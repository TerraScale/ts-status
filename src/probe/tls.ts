/* TLS expiry. A Worker cannot see the certificate a server presents, but
   every publicly trusted certificate is logged for certificate
   transparency; Cert Spotter's API lists the valid ones for a host. The
   latest expiry among them is when the host's certificate runs out unless
   it is renewed again, so a latest expiry that is near means renewal has
   stalled. Each host is looked up at most once a day. */

import { sqlTime } from "../db/reads";
import type { Env } from "../env";
import { DAY } from "../format";

export const CERT_SPOTTER = "https://api.certspotter.com/v1/issuances";

/** Hosts are looked up again after this long. */
export const RECHECK_MS = DAY;

/** A certificate expiring sooner than this needs attention. */
export const EXPIRY_WARNING_MS = 14 * DAY;

/** Lookups run in the minute cron once an hour, at this minute. */
export const CHECK_MINUTE = 17;

interface Issuance {
  dns_names?: string[];
  not_after?: string;
  revoked?: boolean;
  issuer?: { friendly_name?: string; name?: string };
}

/** Whether a certificate name covers a host, wildcards included. */
export function covers(name: string, host: string): boolean {
  if (name === host) return true;
  if (!name.startsWith("*.")) return false;
  const rest = host.slice(host.indexOf(".") + 1);
  return host.includes(".") && name.slice(2) === rest;
}

/** The latest expiry of a valid certificate covering the host. */
export function latest(
  issuances: readonly Issuance[],
  host: string,
): { notAfter: string; issuer: string | null } | null {
  let best: { notAfter: string; issuer: string | null } | null = null;
  for (const issuance of issuances) {
    if (issuance.revoked || !issuance.not_after || !issuance.dns_names?.some((name) => covers(name, host))) continue;
    if (!best || Date.parse(issuance.not_after) > Date.parse(best.notAfter)) {
      best = { notAfter: issuance.not_after, issuer: issuance.issuer?.friendly_name ?? issuance.issuer?.name ?? null };
    }
  }
  return best;
}

async function lookup(
  host: string,
  fetcher: typeof fetch,
): Promise<{ notAfter: string | null; issuer: string | null; error: string | null }> {
  try {
    const url = `${CERT_SPOTTER}?domain=${encodeURIComponent(host)}&match_wildcards=true&expand=dns_names&expand=issuer`;
    const response = await fetcher(url, { headers: { accept: "application/json" } });
    if (!response.ok) return { notAfter: null, issuer: null, error: `Cert Spotter HTTP ${response.status}` };
    const found = latest((await response.json()) as Issuance[], host);
    return found ? { ...found, error: null } : { notAfter: null, issuer: null, error: "No valid certificate logged" };
  } catch {
    return { notAfter: null, issuer: null, error: "Cert Spotter unreachable" };
  }
}

const UPSERT = `INSERT INTO tls_certs (host, not_after, issuer, checked_at, error) VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT (host) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error,
    not_after = coalesce(excluded.not_after, not_after), issuer = coalesce(excluded.issuer, issuer)`;

/** Looks up every monitored host not checked in the last day. A failed
    lookup keeps the last known expiry. */
export async function checkCertificates(env: Env, now: number, fetcher: typeof fetch = fetch): Promise<string[]> {
  const [endpoints, checked] = await env.STATUS_DB.batch([
    env.STATUS_DB.prepare("SELECT DISTINCT url FROM endpoints WHERE enabled = 1"),
    env.STATUS_DB.prepare("SELECT host FROM tls_certs WHERE checked_at >= ?1").bind(sqlTime(now - RECHECK_MS)),
  ]);
  const fresh = new Set(((checked?.results ?? []) as { host: string }[]).map((row) => row.host));
  const hosts = [
    ...new Set(
      ((endpoints?.results ?? []) as { url: string }[]).flatMap((row) => {
        try {
          const url = new URL(row.url);
          return url.protocol === "https:" ? [url.hostname] : [];
        } catch {
          return [];
        }
      }),
    ),
  ].filter((host) => !fresh.has(host));
  if (hosts.length === 0) return [];
  const results = await Promise.all(hosts.map(async (host) => ({ host, ...(await lookup(host, fetcher)) })));
  await env.STATUS_DB.batch(
    results.map((result) =>
      env.STATUS_DB.prepare(UPSERT).bind(
        result.host,
        result.notAfter && sqlTime(Date.parse(result.notAfter)),
        result.issuer,
        sqlTime(now),
        result.error,
      ),
    ),
  );
  return hosts;
}
