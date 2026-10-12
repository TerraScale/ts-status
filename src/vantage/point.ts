/* A vantage point: a Durable Object the coordinator creates near a location
   hint (src/probe/vantages.ts). Each request to /<code> probes every target
   in parallel and reports where it ran. */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { check } from "../probe/check";
import type { ProbeRequest, ProbeResponse, Target } from "../probe/protocol";

function isTarget(value: unknown): value is Target {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.key === "string" &&
    typeof target.url === "string" &&
    typeof target.headers === "string" &&
    typeof target.body === "boolean"
  );
}

/** The data center this object runs in, e.g. "GRU"; requests to a Durable
    Object carry no cf.colo of their own. */
async function colo(): Promise<string | null> {
  try {
    const trace = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    return /^colo=(\w+)$/m.exec(trace)?.[1] ?? null;
  } catch {
    return null;
  }
}

export class VantagePoint extends DurableObject<Env> {
  /** An object never moves while it lives, so one lookup is enough. */
  private colo: Promise<string | null> | undefined;

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = (await request.json().catch(() => null)) as Partial<ProbeRequest> | null;
    if (!Array.isArray(body?.targets) || !body.targets.every(isTarget)) {
      return new Response("Bad request", { status: 400 });
    }
    this.colo ??= colo();
    const results = await Promise.all(body.targets.map((target) => check(target)));
    const where = await this.colo;
    if (where === null) this.colo = undefined;
    return Response.json({
      vantage: new URL(request.url).pathname.slice(1),
      version: this.env.VERSION ?? "unknown",
      colo: where,
      results,
    } satisfies ProbeResponse);
  }
}
