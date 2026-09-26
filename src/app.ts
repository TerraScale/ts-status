/* The status Worker's handlers. Static files are served by Workers assets
   before this runs; the Worker renders the pages and the JSON API from D1
   and keeps each response in the edge cache for a few seconds, so traffic
   spikes during an incident cost at most one D1 batch per URL per colo
   every CACHE_SECONDS. Its minute cron keeps the probe coordinator armed
   and rolls the probe samples up into hours and days. */

import { loadHistory, loadIncident, loadMaintenance, loadSnapshot } from "./db/reads";
import type { Env } from "./env";
import { DEFAULT_RANGE, isRange, RANGE_KEYS, type RangeKey } from "./domain/range";
import { cacheKey, oneOf, readQuery, text, type QuerySpec } from "./http/cache";
import { contentSecurityPolicy, type PolicyOptions } from "./http/csp";
import { secure } from "./http/security";
import { overview, snapshotWindow } from "./overview";
import { coordinator } from "./probe/coordinator";
import { rollup } from "./probe/rollup";
import { DAY } from "./format";
import { createRouter } from "./router";
import { historyPage, historyWindow } from "./views/history";
import { incidentPage } from "./views/incident";
import { MAINTENANCE_DAYS, maintenancePage } from "./views/maintenance";
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

const rangeQuery: QuerySpec = { range: oneOf(...RANGE_KEYS) };

const rangeOf = (query: Record<string, string>): RangeKey => (isRange(query.range) ? query.range : DEFAULT_RANGE);

async function loadOverview(env: Env, now: number, range: RangeKey) {
  return overview(await loadSnapshot(env, snapshotWindow(now, range)), now, range);
}

const route = createRouter<Route>({
  "/": {
    query: rangeQuery,
    render: async (env, context) =>
      page(homePage(await loadOverview(env, context.now, rangeOf(context.query))), context),
  },
  "/history": {
    query: {
      component: (value) => /^[a-z0-9-]{1,40}$/.test(value),
      kind: oneOf("incident", "warning"),
      impact: oneOf("minor", "major", "critical"),
      q: text(80),
      month: (value) => /^20\d\d-(0[1-9]|1[0-2])$/.test(value),
    },
    policy: { formAction: "'self'" },
    render: async (env, context) => {
      const { query, now } = context;
      const history = await loadHistory(env, { ...query, ...historyWindow(query, now) });
      return page(historyPage(history, query, now), context);
    },
  },
  "/incidents/:id": {
    render: async (env, context) => {
      const detail = await loadIncident(env, context.params.id ?? "", context.now);
      return detail ? page(incidentPage(detail, context.now), context) : page(notFoundPage(), context, 404);
    },
  },
  "/maintenance": {
    render: async (env, context) => {
      const { windows, components } = await loadMaintenance(env, context.now - MAINTENANCE_DAYS * DAY);
      return page(maintenancePage(windows, components, context.now), context);
    },
  },
  "/api/status": {
    query: rangeQuery,
    render: async (env, { now, query }) => {
      const view = await loadOverview(env, now, rangeOf(query));
      const states = (list: readonly { state: string }[]) => list.map((bucket) => bucket.state);
      return Response.json(
        {
          generatedAt: new Date(view.generatedAt).toISOString(),
          range: view.range,
          status: view.status,
          uptime: view.uptime,
          lastRoundAt:
            view.monitoring.lastRoundAt === null ? null : new Date(view.monitoring.lastRoundAt).toISOString(),
          groups: view.groups.map(({ components, ...group }) => ({
            ...group,
            components: components.map(({ bars, groupId: _group, ...component }) => ({
              ...component,
              bars: states(bars),
            })),
          })),
          regions: view.regions.map(({ mapX: _x, mapY: _y, clusters, ...region }) => ({
            ...region,
            clusters: clusters.map(({ bars, ...entry }) => ({ ...entry, bars: states(bars) })),
          })),
          days: states(view.days),
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
    ctx.waitUntil(Promise.all([coordinator(env).arm(), rollup(env, controller.scheduledTime)]));
  },
} satisfies ExportedHandler<Env>;
