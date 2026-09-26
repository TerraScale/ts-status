/* The status Worker's handlers. Static files are served by Workers assets
   before this runs; the Worker renders the pages and the JSON API from D1
   and keeps each response in the edge cache for a few seconds, so traffic
   spikes during an incident cost at most one D1 batch per URL per colo
   every CACHE_SECONDS. Its cron trigger probes every endpoint once a minute. */

import { loadHistory, loadSnapshot } from "./db/reads";
import type { Env } from "./env";
import { cacheKey, readQuery, type QuerySpec } from "./http/cache";
import { contentSecurityPolicy, type PolicyOptions } from "./http/csp";
import { secure } from "./http/security";
import { overview, snapshotWindow } from "./overview";
import { probeAll } from "./probe";
import { createRouter } from "./router";
import { historyPage } from "./views/history";
import { homePage } from "./views/home";
import { document, type Page } from "./views/layout";
import { notFoundPage } from "./views/not-found";

const FONT_PRELOAD = '</fonts/oxanium.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin';

interface RenderContext {
  now: number;
  /** Only the page's <main>, for in-place refreshes. */
  fragment: boolean;
  params: Record<string, string>;
  query: Record<string, string>;
  policy?: PolicyOptions;
}

interface Route {
  render: (env: Env, context: RenderContext) => Promise<Response>;
  /** Query parameters the route reads; every other one is ignored. */
  query?: QuerySpec;
  /** Widens the page's content security policy. */
  policy?: PolicyOptions;
}

const route = createRouter<Route>({
  "/": {
    render: async (env, context) => {
      const snapshot = await loadSnapshot(env, snapshotWindow(context.now));
      return page(homePage(overview(snapshot, context.now)), context);
    },
  },
  "/history": {
    render: async (env, context) => page(historyPage(await loadHistory(env)), context),
  },
  "/api/status": {
    render: async (env, { now }) => {
      const view = overview(await loadSnapshot(env, snapshotWindow(now)), now);
      return Response.json(
        {
          generatedAt: new Date(view.generatedAt).toISOString(),
          status: view.status,
          uptime30d: view.uptime30d,
          groups: view.groups.map(({ components, ...group }) => ({
            ...group,
            components: components.map(({ hours, groupId: _group, ...component }) => ({
              ...component,
              hours: hours.map((bucket) => bucket.state),
            })),
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
  },
});

async function page(content: Page, context: RenderContext, status = 200): Promise<Response> {
  const body = context.fragment ? content.body.value : document(content, new Date(context.now).getUTCFullYear()).value;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await contentSecurityPolicy(context.policy),
      link: FONT_PRELOAD,
    },
  });
}

async function render(route: Route, env: Env, context: RenderContext): Promise<Response> {
  try {
    return secure(await route.render(env, context), true);
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
    const match = route(url.pathname);
    const now = Date.now();

    if (!match) return secure(await page(notFoundPage(), { now, fragment: false, params: {}, query: {} }, 404), false);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return secure(new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } }), false);
    }

    const fragment = url.searchParams.get("fragment") === "main";
    const query = readQuery(url, match.value.query);
    const key = new Request(cacheKey(url, query, fragment));
    const cache = caches.default;
    let response = await cache.match(key);
    if (!response) {
      response = await render(match.value, env, {
        now,
        fragment,
        params: match.params,
        query,
        policy: match.value.policy,
      });
      if (response.ok) ctx.waitUntil(cache.put(key, response.clone()));
    }
    return request.method === "HEAD" ? new Response(null, response) : response;
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(probeAll(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
