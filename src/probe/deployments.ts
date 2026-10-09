import type { Env } from "../env";
import type { ProbeResponse } from "./protocol";

const SERVICES = [
  ["ts-atlas", "https://atlas.terrascale.tech/health/version"],
  ["ts-status", "https://status.terrascale.tech/health/version"],
  ["ts-dashboard", "https://ts-dashboard.fly.dev/health/ready"],
] as const;

export interface DeploymentObservation {
  service: string;
  region: string;
  target: "service" | "vantage";
  version: string | null;
  status: number | null;
  colo: string | null;
  observedAt: string;
}

const revision = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;

/** Fixed public targets only: callers cannot use the regional bindings as a proxy. */
export async function deployments(env: Env, now: number): Promise<DeploymentObservation[]> {
  const observedAt = new Date(now).toISOString();
  const targets = SERVICES.map(([key, url]) => ({
    key,
    url,
    headers: '{"Cache-Control":"no-cache"}',
    body: true,
  }));
  const regions = [
    ["GRU", env.VANTAGE_GRU],
    ["SFO", env.VANTAGE_SFO],
  ] as const;
  return (
    await Promise.all(
      regions.map(async ([region, vantage]) => {
        let probe: ProbeResponse | null = null;
        try {
          const response = await vantage.fetch("https://vantage/probe", {
            method: "POST",
            body: JSON.stringify({ targets }),
            signal: AbortSignal.timeout(8_000),
          });
          if (response.ok) probe = (await response.json()) as ProbeResponse;
        } catch {
          // A missing vantage is a missing deployment proof, never a healthy sample.
        }
        const observations: DeploymentObservation[] = SERVICES.map(([service]) => {
          const result = probe?.results?.find((item) => item.key === service);
          let version: string | null = null;
          try {
            if (result?.status === 200) version = revision(JSON.parse(result.body ?? "").version);
          } catch {
            /* Invalid bodies remain unknown. */
          }
          return {
            service,
            region,
            target: "service",
            version,
            status: result?.status ?? null,
            colo: probe?.colo ?? null,
            observedAt,
          };
        });
        observations.push({
          service: "ts-status",
          region,
          target: "vantage",
          version: revision(probe?.version),
          status: probe ? 200 : null,
          colo: probe?.colo ?? null,
          observedAt,
        });
        return observations;
      }),
    )
  ).flat();
}
