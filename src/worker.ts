/* The status Worker. Static files are served by Workers assets before this
   runs; the Worker renders the pages and the JSON API from D1 and keeps each
   response in the edge cache for a few seconds, so traffic spikes during an
   incident cost at most one D1 batch per URL per colo every CACHE_SECONDS.
   Its cron trigger probes every region's clusters once a minute. */

import { loadHistory, loadSnapshot, type Env } from "./data";
import { overview, snapshotWindow } from "./overview";
import { probeAll } from "./probe";
import { CLIENT_SCRIPT } from "./views/client";
import { historyPage } from "./views/history";
import { homePage } from "./views/home";
import { document, STYLES, type Page } from "./views/layout";
import { notFoundPage } from "./views/not-found";

/** Edge and browser cache lifetime; well under the 30-second refresh. */
const CACHE_SECONDS = 10;

const FONT_PRELOAD = '</fonts/oxanium.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin';

interface RenderContext {
  now: number;
  /** Only the page's <main>, for in-place refreshes. */
  fragment: boolean;
}

type Route = (env: Env, context: RenderContext) => Promise<Response>;

const routes: Record<string, Route> = {
  "/": async (env, context) => {
    const snapshot = await loadSnapshot(env, snapshotWindow(context.now));
    return page(homePage(overview(snapshot, context.now)), context);
  },
  "/history": async (env, context) => page(historyPage(await loadHistory(env)), context),
  "/api/status": async (env, { now }) => {
    const view = overview(await loadSnapshot(env, snapshotWindow(now)), now);
    return Response.json(
      {
        generatedAt: new Date(view.generatedAt).toISOString(),
        status: view.status,
        uptime30d: view.uptime30d,
        services: view.services.map(({ hours, ...service }) => ({
          ...service,
          hours: hours.map((bucket) => bucket.state),
        })),
        regions: view.regions.map(({ mapX: _x, mapY: _y, clusters, ...region }) => ({
          ...region,
          clusters: clusters.map(({ hours, ...entry }) => ({ ...entry, hours: hours.map((bucket) => bucket.state) })),
        })),
        incidents: [...view.activeIncidents, ...view.resolvedIncidents],
      },
      { headers: { "access-control-allow-origin": "*" } },
    );
  },
};

let policy: Promise<string> | undefined;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/** The content security policy, allowing only the inlined style and script. */
function contentSecurityPolicy(): Promise<string> {
  policy ??= Promise.all([sha256(STYLES), sha256(CLIENT_SCRIPT)]).then(([style, script]) =>
    [
      "default-src 'none'",
      `style-src ${style}`,
      `script-src ${script}`,
      "connect-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  return policy;
}

async function page(content: Page, context: RenderContext, status = 200): Promise<Response> {
  const body = context.fragment ? content.body.value : document(content, new Date(context.now).getUTCFullYear()).value;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await contentSecurityPolicy(),
      link: FONT_PRELOAD,
    },
  });
}

function secure(response: Response, cacheable: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, headers });
}

async function render(route: Route, env: Env, context: RenderContext): Promise<Response> {
  try {
    return secure(await route(env, context), true);
  } catch (error) {
    console.error("status render failed", error);
    return secure(
      new Response("Status is temporarily unavailable.", { status: 503, headers: { "retry-after": "10" } }),
      false,
    );
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const route = routes[url.pathname];

    if (!route) return secure(await page(notFoundPage(), { now: Date.now(), fragment: false }, 404), false);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return secure(new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } }), false);
    }

    // Cache entries are keyed by path and fragment only, so arbitrary query
    // strings cannot bypass the cache.
    const fragment = url.searchParams.get("fragment") === "main";
    const key = new Request(`${url.origin}${url.pathname}${fragment ? "?fragment=main" : ""}`);
    const cache = caches.default;
    let response = await cache.match(key);
    if (!response) {
      response = await render(route, env, { now: Date.now(), fragment });
      if (response.ok) ctx.waitUntil(cache.put(key, response.clone()));
    }
    return request.method === "HEAD" ? new Response(null, response) : response;
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(probeAll(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
