/* Admin authentication: one password, stored as a PBKDF2 hash in the
   ADMIN_PASSWORD_HASH secret, exchanged for a short-lived session cookie
   signed with ADMIN_SESSION_SECRET. Nothing is stored server-side: the
   cookie carries its expiry and a nonce, and every form carries a CSRF
   token derived from that nonce. Comparisons are constant time. */

import { base64url, decode } from "../notify/tokens";

export const COOKIE = "__Host-ts_status_admin";

/** A session lasts this long; signing in again starts a new one. */
export const SESSION_MS = 60 * 60_000;

/** Cloudflare Workers caps PBKDF2 at 100,000 iterations. */
export const ITERATIONS = 100_000;

const encoder = new TextEncoder();

/** Compares two byte strings without exiting early on the first difference. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** "pbkdf2-sha256$<iterations>$<salt>$<hash>", salt and hash in base64url. */
export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16))) {
  return `pbkdf2-sha256$${ITERATIONS}$${base64url(salt)}$${base64url(await derive(password, salt, ITERATIONS))}`;
}

export async function checkPassword(password: string, stored: string | undefined): Promise<boolean> {
  const [scheme, rounds, salt, hash] = (stored ?? "").split("$");
  const iterations = Number(rounds);
  const saltBytes = decode(salt ?? "");
  const expected = decode(hash ?? "");
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS)
    return false;
  if (!saltBytes || !expected || expected.length !== 32 || password.length === 0 || password.length > 1_000) {
    return false;
  }
  return sameBytes(await derive(password, saltBytes, iterations), expected);
}

async function hmac(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

export interface Session {
  expires: number;
  nonce: string;
}

/** A new session's cookie value: "<expires>.<nonce>.<signature>". */
export async function issue(secret: string, now: number): Promise<string> {
  const expires = now + SESSION_MS;
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  return `${expires}.${nonce}.${base64url(await hmac(secret, `session.${expires}.${nonce}`))}`;
}

/** The session a cookie value carries, or null when forged or expired. */
export async function session(secret: string | undefined, value: string | null, now: number): Promise<Session | null> {
  if (!secret || !value) return null;
  const [expires, nonce, signature, ...rest] = value.split(".");
  const presented = decode(signature ?? "");
  if (rest.length > 0 || !expires || !nonce || !presented || !/^\d{13}$/.test(expires)) return null;
  if (!sameBytes(presented, await hmac(secret, `session.${expires}.${nonce}`))) return null;
  return Number(expires) > now ? { expires: Number(expires), nonce } : null;
}

/** The token every admin form posts back, bound to the session. */
export const csrfToken = async (secret: string, current: Session): Promise<string> =>
  base64url(await hmac(secret, `csrf.${current.nonce}`));

export async function checkCsrf(secret: string, current: Session, presented: string | null): Promise<boolean> {
  const bytes = decode(presented ?? "");
  return bytes !== null && sameBytes(bytes, await hmac(secret, `csrf.${current.nonce}`));
}

/** The admin cookie's value from a request. */
export function readCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return null;
}

export const setCookie = (value: string): string =>
  `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;

export const clearCookie = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/** Whether a form post comes from this site: browsers send Origin on every POST. */
export function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}
