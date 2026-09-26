/* Headers every response carries. */

/** Edge and browser cache lifetime; well under the 30-second refresh. */
export const CACHE_SECONDS = 10;

export function secure(response: Response, cacheable: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, headers });
}
