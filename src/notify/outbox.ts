/* The outbox. The minute cron enqueues every eligible incident update for
   every confirmed subscriber that follows its components, then delivers
   what is due, retrying failures with exponential backoff.

   Updates of automatic incidents wait five minutes, and an automatic
   incident resolved within five minutes notifies nobody: a blip should
   not wake anyone. Operator incidents notify at once. */

import { iso, sqlTime } from "../db/reads";
import type { IncidentImpact, IncidentKind, IncidentStatus } from "../domain/status";
import type { Env } from "../env";
import { email, webhook, type Notice } from "./messages";
import { send, type Connect, type SmtpConfig } from "./smtp";
import { sign } from "./tokens";
import { post } from "./webhooks";

/** Automatic incidents notify once they have lasted this long. */
export const AUTO_HOLD_MS = 5 * 60_000;

/** Updates older than this are never enqueued. */
const LOOKBACK_MS = 2 * 86_400_000;

/** Attempts before a message is given up. */
export const MAX_ATTEMPTS = 8;

/** Messages delivered per cron run. */
const BATCH = 20;

const ENQUEUE = `INSERT OR IGNORE INTO outbox (id, subscriber_id, kind, update_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), s.id, 'update', u.id, ?1, ?1
  FROM incident_updates u
  JOIN incidents i ON i.id = u.incident_id
  JOIN subscribers s ON s.confirmed_at IS NOT NULL AND s.confirmed_at <= u.created_at
  WHERE u.created_at >= ?2
    AND (i.source = 'manual' OR i.operator_touched = 1
      OR (i.created_at <= ?3 AND (i.resolved_at IS NULL OR i.resolved_at >= datetime(i.created_at, '+5 minutes'))))
    AND (s.components = '[]'
      OR NOT EXISTS (SELECT 1 FROM incident_components c WHERE c.incident_id = i.id)
      OR EXISTS (SELECT 1 FROM incident_components c, json_each(s.components) j
        WHERE c.incident_id = i.id AND c.component_id = j.value))`;

const DUE = `SELECT o.id, o.kind, o.attempts, s.id AS subscriberId, s.channel, s.target, s.flavor,
    u.status, u.body, ${iso("u.created_at")} AS updateAt,
    i.id AS incidentId, i.kind AS incidentKind, i.title, i.impact, i.source
  FROM outbox o JOIN subscribers s ON s.id = o.subscriber_id
  LEFT JOIN incident_updates u ON u.id = o.update_id
  LEFT JOIN incidents i ON i.id = u.incident_id
  WHERE o.sent_at IS NULL AND o.next_attempt_at <= ?1 AND o.attempts < ?2
  ORDER BY o.created_at LIMIT ?3`;

interface Due {
  id: string;
  kind: "confirm" | "update";
  attempts: number;
  subscriberId: string;
  channel: "email" | "webhook";
  target: string;
  flavor: Notice["flavor"];
  status: IncidentStatus | null;
  body: string | null;
  updateAt: string | null;
  incidentId: string | null;
  incidentKind: IncidentKind | null;
  title: string | null;
  impact: IncidentImpact | null;
  source: "manual" | "auto" | null;
}

export interface Delivery {
  connect: Connect;
  fetcher?: typeof fetch;
}

/** The SMTP relay, when configured. */
export function smtpConfig(env: Env): (SmtpConfig & { from: string }) | null {
  if (!env.SMTP_HOST || !env.SMTP_USERNAME || !env.SMTP_PASSWORD || !env.SMTP_FROM) return null;
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    username: env.SMTP_USERNAME,
    password: env.SMTP_PASSWORD,
    from: env.SMTP_FROM,
  };
}

/** The links a subscriber's messages carry. */
export async function links(env: Env & { SUBSCRIPTION_SECRET: string }, subscriberId: string) {
  const origin = env.PUBLIC_ORIGIN ?? "https://status.terrascale.tech";
  const id = encodeURIComponent(subscriberId);
  return {
    site: origin,
    confirm: `${origin}/subscribe/confirm?id=${id}&token=${await sign(env.SUBSCRIPTION_SECRET, "confirm", subscriberId)}`,
    manage: `${origin}/subscribe/manage?id=${id}&token=${await sign(env.SUBSCRIPTION_SECRET, "manage", subscriberId)}`,
  };
}

async function deliver(
  env: Env & { SUBSCRIPTION_SECRET: string },
  row: Due,
  delivery: Delivery,
  now: number,
): Promise<void> {
  const origin = env.PUBLIC_ORIGIN ?? "https://status.terrascale.tech";
  const notice: Notice = {
    kind: row.kind,
    channel: row.channel,
    flavor: row.flavor,
    links: {
      ...(await links(env, row.subscriberId)),
      incident: row.incidentId ? `${origin}/incidents/${row.incidentId}` : undefined,
    },
    incident:
      row.incidentId && row.incidentKind && row.title && row.impact && row.source
        ? { id: row.incidentId, kind: row.incidentKind, title: row.title, impact: row.impact, source: row.source }
        : undefined,
    update:
      row.status && row.body && row.updateAt
        ? { status: row.status, body: row.body, createdAt: row.updateAt }
        : undefined,
  };
  if (row.kind === "update" && (!notice.incident || !notice.update)) throw new Error("Update no longer exists");
  if (row.channel === "email") {
    const config = smtpConfig(env);
    if (!config) throw new Error("Email is not configured");
    await send(delivery.connect, config, {
      from: config.from,
      to: row.target,
      data: email(notice, config.from, row.target, now),
    });
  } else {
    const request = await webhook(notice, env.SUBSCRIPTION_SECRET);
    await post(row.target, request.body, request.headers, delivery.fetcher);
  }
}

/** Enqueues eligible updates, then delivers up to a batch of due messages.
    Returns how many were sent and how many failed. */
export async function runOutbox(env: Env, now: number, delivery: Delivery): Promise<{ sent: number; failed: number }> {
  const secret = env.SUBSCRIPTION_SECRET;
  if (!secret) return { sent: 0, failed: 0 };
  const signed = { ...env, SUBSCRIPTION_SECRET: secret };
  const time = sqlTime(now);
  const [, due] = await env.STATUS_DB.batch([
    env.STATUS_DB.prepare(ENQUEUE).bind(time, sqlTime(now - LOOKBACK_MS), sqlTime(now - AUTO_HOLD_MS)),
    env.STATUS_DB.prepare(DUE).bind(time, MAX_ATTEMPTS, BATCH),
  ]);
  const rows = (due?.results ?? []) as Due[];
  let failed = 0;
  const statements = await Promise.all(
    rows.map(async (row) => {
      try {
        await deliver(signed, row, delivery, now);
        return env.STATUS_DB.prepare(
          "UPDATE outbox SET sent_at = ?2, attempts = attempts + 1, last_error = NULL WHERE id = ?1",
        ).bind(row.id, time);
      } catch (error) {
        failed += 1;
        const retry = sqlTime(now + Math.min(2 ** row.attempts, 360) * 60_000);
        const message = error instanceof Error ? error.message.slice(0, 300) : "Delivery failed";
        return env.STATUS_DB.prepare(
          "UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?2, last_error = ?3 WHERE id = ?1",
        ).bind(row.id, retry, message);
      }
    }),
  );
  // Retention: delivered messages for 30 days, unconfirmed subscribers for 7.
  statements.push(
    env.STATUS_DB.prepare("DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?1").bind(
      sqlTime(now - 30 * 86_400_000),
    ),
    env.STATUS_DB.prepare("DELETE FROM subscribers WHERE confirmed_at IS NULL AND created_at < ?1").bind(
      sqlTime(now - 7 * 86_400_000),
    ),
  );
  await env.STATUS_DB.batch(statements);
  return { sent: rows.length - failed, failed };
}
