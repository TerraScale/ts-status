import { describe, expect, it, vi } from "vitest";
import { EMAIL_INBOX_UNAVAILABLE } from "../domain/status";
import type { EmailSender } from "../env";
import { emailSample, runEmailProbe, SEND_EVERY_MS, type EmailProbeState } from "./email";

const T0 = Date.parse("2026-10-27T23:00:00Z");

/** A mail.tm stand-in: one domain, accounts, tokens, and the messages sent to them. */
function inbox(options: { delayMs?: number; down?: boolean } = {}) {
  const accounts = new Map<string, string>();
  const messages: { id: string; to: string; subject: string; createdAt: string }[] = [];
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (options.down) return new Response("busy", { status: 503 });
    const body = init?.body ? (JSON.parse(String(init.body)) as { address: string; password: string }) : null;
    const owner = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length);
    switch (`${method} ${url.pathname}`) {
      case "GET /domains":
        return Response.json({ "hydra:member": [{ domain: "inbox.test", isActive: true }] });
      case "POST /accounts":
        accounts.set(body!.address, body!.password);
        return Response.json({ id: `account-${accounts.size}`, address: body!.address }, { status: 201 });
      case "POST /token":
        return accounts.get(body!.address) === body!.password
          ? Response.json({ token: body!.address })
          : Response.json({ code: 401 }, { status: 401 });
      case "GET /messages":
        return Response.json({ "hydra:member": messages.filter((message) => message.to === owner) });
      default:
        if (method === "DELETE" && url.pathname.startsWith("/messages/")) {
          messages.splice(
            messages.findIndex((message) => `/messages/${message.id}` === url.pathname),
            1,
          );
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
    }
  });
  const sent: Parameters<EmailSender["send"]>[0][] = [];
  const email: EmailSender = {
    send: vi.fn(async (message) => {
      sent.push(message);
      messages.push({
        id: `m${sent.length}`,
        to: message.to,
        subject: message.subject,
        createdAt: new Date(Date.now() + (options.delayMs ?? 4_000)).toISOString(),
      });
      return { messageId: `m${sent.length}` };
    }),
  };
  return { fetcher, email, sent, calls, accounts, messages };
}

const sampleOf = (state: EmailProbeState, fault: string | null, now: number, streak = 0) =>
  emailSample("endpoint", state, fault, now, streak);

describe("email delivery probe", () => {
  it("creates its own inbox, sends one message and times its arrival", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    try {
      const box = inbox();
      const first = await runEmailProbe({}, box.email, T0, box.fetcher);
      expect(first.fault).toBeNull();
      expect(box.sent).toHaveLength(1);
      expect(box.sent[0]).toMatchObject({ from: { email: "noreply@terrascale.tech" }, to: first.state.inbox!.address });
      expect(first.state.inbox!.address).toMatch(/^ts-status-[0-9a-z]{26}@inbox\.test$/);
      expect(sampleOf(first.state, null, T0).sample).toMatchObject({ state: "none", total: 0 });

      const second = await runEmailProbe(first.state, box.email, T0 + 30_000, box.fetcher);
      expect(second.state.pending).toBeUndefined();
      expect(second.state.last).toEqual({ ok: true, ms: 4_000, error: null });
      expect(box.messages).toHaveLength(0);
      expect(sampleOf(second.state, null, T0 + 30_000).sample).toMatchObject({
        state: "operational",
        ok: 1,
        total: 1,
        latencyMs: 4_000,
      });

      // Nothing is due until the next interval: no inbox or sender traffic.
      const calls = box.calls.length;
      const idle = await runEmailProbe(second.state, box.email, T0 + 60_000, box.fetcher);
      expect(box.calls).toHaveLength(calls);
      expect(box.sent).toHaveLength(1);
      await runEmailProbe(idle.state, box.email, T0 + SEND_EVERY_MS, box.fetcher);
      expect(box.sent).toHaveLength(2);
      expect(box.accounts.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades a message slower than 30 seconds, even before it arrives", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    try {
      const box = inbox({ delayMs: 45_000 });
      const sent = await runEmailProbe({}, box.email, T0, box.fetcher);
      box.messages.length = 0; // Still on its way.
      const waiting = await runEmailProbe(sent.state, box.email, T0 + 40_000, box.fetcher);
      expect(sampleOf(waiting.state, null, T0 + 40_000).sample).toMatchObject({
        state: "degraded",
        latencyMs: 40_000,
        results: [{ e: "Not delivered in 30 seconds" }],
      });
      box.messages.push({
        id: "late",
        to: sent.state.inbox!.address,
        subject: box.sent[0]!.subject,
        createdAt: new Date(T0 + 45_000).toISOString(),
      });
      const arrived = await runEmailProbe(waiting.state, box.email, T0 + 60_000, box.fetcher);
      expect(arrived.state.last).toEqual({ ok: true, ms: 45_000, error: null });
      expect(sampleOf(arrived.state, null, T0 + 60_000).sample.state).toBe("degraded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a lost message and a refused send, degraded first and down when it persists", async () => {
    const box = inbox();
    const sent = await runEmailProbe({}, box.email, T0, box.fetcher);
    box.messages.length = 0;
    const lost = await runEmailProbe(sent.state, box.email, T0 + 120_000, box.fetcher);
    expect(lost.state.last).toEqual({ ok: false, ms: null, error: "Not delivered in 2 minutes" });
    const once = sampleOf(lost.state, null, T0 + 120_000);
    expect(once.sample).toMatchObject({ state: "degraded", ok: 0, total: 1 });
    expect(sampleOf(lost.state, null, T0 + 150_000, once.streak).sample.state).toBe("major_outage");

    const refusing: EmailSender = { send: vi.fn(async () => Promise.reject(new Error("rejected"))) };
    const refused = await runEmailProbe({}, refusing, T0, inbox().fetcher);
    expect(refused.state.last).toEqual({ ok: false, ms: null, error: "Send failed" });
    expect(refused.state.pending).toBeUndefined();
  });

  it("leaves Email unmeasured when the inbox API fails, and replaces a deleted inbox", async () => {
    const down = inbox({ down: true });
    const failed = await runEmailProbe({}, down.email, T0, down.fetcher);
    expect(failed.fault).toBe(EMAIL_INBOX_UNAVAILABLE);
    expect(down.sent).toHaveLength(0);
    expect(sampleOf(failed.state, failed.fault, T0).sample).toMatchObject({
      state: "none",
      total: 0,
      results: [{ ok: null, e: EMAIL_INBOX_UNAVAILABLE }],
    });

    const box = inbox();
    const forgotten = { inbox: { id: "gone", address: "old@inbox.test", password: "x" } };
    const replaced = await runEmailProbe(forgotten, box.email, T0, box.fetcher);
    expect(replaced.fault).toBeNull();
    expect(replaced.state.inbox!.address).not.toBe("old@inbox.test");
    expect(box.sent[0]!.to).toBe(replaced.state.inbox!.address);
  });
});
