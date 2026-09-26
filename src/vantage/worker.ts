/* A vantage Worker. It has no route: the coordinator reaches it through a
   service binding, and Cloudflare runs it near its placement region. Each
   request probes every target in parallel and reports where it ran. */

import { check } from "../probe/check";
import type { ProbeRequest, ProbeResponse, Target } from "../probe/protocol";

interface VantageEnv {
  VANTAGE: string;
}

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

/** "remote-GRU" or "local-EWR" → "GRU" */
function colo(request: Request): string | null {
  const placement = request.headers.get("cf-placement")?.split("-").at(-1);
  const cf = (request as Request<unknown, IncomingRequestCfProperties>).cf;
  return placement || (cf?.colo ?? null);
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = (await request.json().catch(() => null)) as Partial<ProbeRequest> | null;
    if (!Array.isArray(body?.targets) || !body.targets.every(isTarget)) {
      return new Response("Bad request", { status: 400 });
    }
    const results = await Promise.all(body.targets.map((target) => check(target)));
    return Response.json({ vantage: env.VANTAGE, colo: colo(request), results } satisfies ProbeResponse);
  },
} satisfies ExportedHandler<VantageEnv>;
