/* What subscribers receive: a confirmation request, or an incident update,
   as an email (plain text and HTML) or a webhook payload for Discord,
   Slack, or anything else (signed JSON). */

import type { IncidentImpact, IncidentKind, IncidentStatus } from "../domain/status";
import { escape } from "../html";
import { hmacHex } from "./webhooks";

export interface Notice {
  kind: "confirm" | "update";
  channel: "email" | "webhook";
  flavor: "email" | "discord" | "slack" | "generic";
  links: { site: string; manage: string; confirm?: string; incident?: string };
  incident?: { id: string; kind: IncidentKind; title: string; impact: IncidentImpact; source: "manual" | "auto" };
  update?: { status: IncidentStatus; body: string; createdAt: string };
}

const STATUS: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
};

const COLORS: Record<IncidentImpact, number> = { none: 0x60a5fa, minor: 0xfbbf24, major: 0xfb923c, critical: 0xf87171 };

function subject(notice: Notice): string {
  if (notice.kind === "confirm" || !notice.incident || !notice.update)
    return "Confirm your TerraScale status subscription";
  const prefix = notice.incident.kind === "maintenance" ? "Maintenance" : STATUS[notice.update.status];
  return `[TerraScale] ${prefix}: ${notice.incident.title}`;
}

function lines(notice: Notice): string[] {
  if (notice.kind === "confirm") {
    return [
      "Someone, hopefully you, asked to receive TerraScale status updates here.",
      `Confirm the subscription: ${notice.links.confirm}`,
      "If it was not you, ignore this message and nothing will be sent.",
    ];
  }
  return [
    `${STATUS[notice.update?.status ?? "investigating"]}: ${notice.update?.body ?? ""}`,
    `Details: ${notice.links.incident}`,
  ];
}

/** RFC 2047 encoding for header text outside ASCII. */
const header = (text: string): string =>
  /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}?=`;

/** Base64 of UTF-8 text in 76-character lines. */
const base64 = (text: string): string =>
  (btoa(String.fromCharCode(...new TextEncoder().encode(text))).match(/.{1,76}/g) ?? []).join("\r\n");

function html(notice: Notice): string {
  const [first, ...rest] = lines(notice);
  const link = notice.kind === "confirm" ? notice.links.confirm : notice.links.incident;
  const action = notice.kind === "confirm" ? "Confirm subscription" : "View on the status page";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#0a0c12;color:#eef1f7;font-family:system-ui,sans-serif">
<div style="max-width:560px;margin:0 auto">
<p style="color:#3b82f6;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase">TerraScale Status</p>
<h1 style="font-size:20px">${escape(notice.incident?.title ?? "Confirm your subscription")}</h1>
<p style="color:#a7afbf">${escape(first ?? "")}</p>
${rest
  .slice(0, -1)
  .map((line) => `<p style="color:#a7afbf">${escape(line)}</p>`)
  .join("")}
<p><a href="${escape(link ?? notice.links.site)}" style="display:inline-block;padding:8px 16px;border-radius:6px;background:#3b82f6;color:#fff;text-decoration:none;font-weight:600">${action}</a></p>
<p style="color:#6c7589;font-size:12px"><a href="${escape(notice.links.manage)}" style="color:#6c7589">Unsubscribe</a></p>
</div></body></html>`;
}

/** The full email message, headers and body. */
export function email(notice: Notice, from: string, to: string, now: number): string {
  const boundary = `ts-${crypto.randomUUID()}`;
  const text = [...lines(notice), "", `Unsubscribe: ${notice.links.manage}`].join("\r\n");
  return [
    `From: ${header("TerraScale Status")} <${from}>`,
    `To: <${to}>`,
    `Subject: ${header(subject(notice))}`,
    `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@status.terrascale.tech>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    `List-Unsubscribe: <${notice.links.manage}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64(html(notice)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** A webhook request body and headers for the subscriber's flavor. */
export async function webhook(
  notice: Notice,
  secret: string,
): Promise<{ body: string; headers: Record<string, string> }> {
  const title = notice.incident?.title ?? "TerraScale status subscription";
  const text = lines(notice).join("\n");
  let payload: unknown;
  switch (notice.flavor) {
    case "discord":
      payload =
        notice.kind === "confirm"
          ? { username: "TerraScale Status", content: text }
          : {
              username: "TerraScale Status",
              embeds: [
                {
                  title: subject(notice).replace(/^\[TerraScale\] /, ""),
                  url: notice.links.incident,
                  description: notice.update?.body,
                  color: COLORS[notice.incident?.impact ?? "none"],
                  footer: { text: `TerraScale Status · unsubscribe: ${notice.links.manage}` },
                  timestamp: notice.update?.createdAt,
                },
              ],
            };
      break;
    case "slack":
      payload = {
        text: notice.kind === "confirm" ? text : `*${title}*\n${text}\n<${notice.links.manage}|Unsubscribe>`,
      };
      break;
    default:
      payload =
        notice.kind === "confirm"
          ? { type: "subscription.confirm", confirmUrl: notice.links.confirm, manageUrl: notice.links.manage }
          : {
              type: "incident.update",
              incident: notice.incident,
              update: notice.update,
              url: notice.links.incident,
              manageUrl: notice.links.manage,
            };
  }
  const body = JSON.stringify(payload);
  return notice.flavor === "generic"
    ? { body, headers: { "x-terrascale-signature": `sha256=${await hmacHex(secret, body)}` } }
    : { body, headers: {} };
}
