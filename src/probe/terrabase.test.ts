import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_CONFIGURED } from "../domain/status";
import type { Env } from "../env";
import { testD1 } from "../testing/d1";
import { CANARY_TIMEOUT_MS } from "./canary";
import type { ProbeRequest, ProbeResponse } from "./protocol";
import { rollupStatements } from "./rollup";
import { runRound } from "./round";
import {
  isTerraBaseConfig,
  notConfiguredSample,
  parseTerraBase,
  runTerraBase,
  type TerraBaseConfig,
  type TerraBaseProbe,
} from "./terrabase";

const ORIGIN = "https://terrabase.test";
const KEY = "tbk1_probe";
const TENANT = "018f0000-0000-7000-8000-00000000000a";
const DATABASE = "018f0000-0000-7000-8000-00000000000b";

const configs: Record<TerraBaseProbe, TerraBaseConfig> = {
  health: { origin: ORIGIN },
  documents: { origin: ORIGIN, key: KEY, database: "canary", collection: "probes" },
  management: { origin: ORIGIN, key: KEY, tenant: TENANT },
};
const PROBES = Object.keys(configs) as TerraBaseProbe[];

type Route = "readyz" | "create" | "read" | "query" | "delete" | "tenants" | "databases";

interface Reply {
  status: number;
  /** A string is sent as text, anything else as JSON. */
  body: unknown;
}

const routeOf = (method: string, url: URL): Route | null => {
  if (method === "GET" && url.pathname === "/v1/readyz") return "readyz";
  if (method === "GET" && url.pathname === "/v1/dashboard/tenants" && url.search === "?limit=1") return "tenants";
  if (method === "GET" && url.pathname === `/v1/dashboard/tenants/${TENANT}/databases` && url.search === "?limit=1") {
    return "databases";
  }
  const match = /^\/v1\/databases\/canary\/collections\/probes\/(documents|query)(?:\/([^/]+))?$/.exec(url.pathname);
  if (match?.[1] === "query" && !match[2] && method === "POST") return "query";
  if (match?.[1] === "documents" && match[2] && method === "PUT") return "create";
  if (match?.[1] === "documents" && match[2] && method === "GET") return "read";
  if (match?.[1] === "documents" && match[2] && method === "DELETE") return "delete";
  return null;
};

/** An in-memory TerraBase v1 API holding the canary collection. A fault
    replaces a route's answer. */
function terrabase() {
  const docs = new Map<string, { version: string; document: Record<string, unknown> }>();
  const calls: string[] = [];
  const faults: Partial<Record<Route, Reply>> = {};
  let offset = 0;
  const stamp = () => ({
    version: `tbv1-${(++offset).toString(16).padStart(32, "0")}`,
    offset: String(offset),
    durability: "local_durable",
  });
  const valueOf = (id: string) => ({
    id,
    version: docs.get(id)!.version,
    state: "value",
    document: docs.get(id)!.document,
  });

  const reply = (method: string, url: URL, authorization: string | null, body: string): Reply => {
    const route = routeOf(method, url);
    calls.push(route ?? `${method} ${url.pathname}${url.search}`);
    if (route && faults[route]) return faults[route];
    if (route === "readyz") return { status: 200, body: "ready\n" };
    if (authorization !== `Bearer ${KEY}`) return { status: 401, body: { error: { code: "invalid_key" } } };
    const id = url.pathname.split("/").at(-1)!;
    switch (route) {
      case "create": {
        const existed = docs.has(id);
        const written = stamp();
        docs.set(id, { version: written.version, document: JSON.parse(body) as Record<string, unknown> });
        return { status: existed ? 200 : 201, body: { id, ...written } };
      }
      case "read":
        return docs.has(id)
          ? { status: 200, body: valueOf(id) }
          : { status: 404, body: { error: { code: "not_found" } } };
      case "query": {
        const { filter } = JSON.parse(body) as { filter: { eq: [string, string] } };
        return {
          status: 200,
          body: { items: docs.has(filter.eq[1]) ? [valueOf(filter.eq[1])] : [], next_cursor: null },
        };
      }
      case "delete":
        if (!docs.delete(id)) return { status: 404, body: { error: { code: "not_found" } } };
        return { status: 200, body: { id, ...stamp() } };
      case "tenants":
        return { status: 200, body: { items: [{ id: TENANT, name: "canary" }], next_cursor: null } };
      case "databases":
        return { status: 200, body: { items: [{ id: DATABASE, name: "canary" }], next_cursor: "c1" } };
      default:
        return { status: 404, body: { error: { code: "unknown_route" } } };
    }
  };

  const inits: RequestInit[] = [];
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    inits.push(init ?? {});
    urls.push(String(input));
    const answer = reply(
      init?.method ?? "GET",
      new URL(String(input)),
      new Headers(init?.headers).get("authorization"),
      String(init?.body ?? ""),
    );
    return typeof answer.body === "string"
      ? new Response(answer.body, { status: answer.status })
      : Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;
  return { reply, fetcher, docs, calls, faults, inits, urls };
}

const DOCUMENT_ROUTES = ["create", "read", "query", "delete"];

describe("isTerraBaseConfig", () => {
  it("accepts what each probe needs", () => {
    for (const probe of PROBES) expect(isTerraBaseConfig(probe, configs[probe])).toBe(true);
    expect(isTerraBaseConfig("health", { origin: ORIGIN, key: KEY })).toBe(true);
    expect(isTerraBaseConfig("documents", { ...configs.documents, database: "a", collection: "z_9-x" })).toBe(true);
  });

  it("rejects an origin that is not a bare https origin", () => {
    for (const origin of [
      "http://terrabase.test",
      "https://terrabase.test/",
      "https://terrabase.test/v1",
      "https://terrabase.test#ready",
      "https://terrabase.test?x=1",
      "https://user:pw@terrabase.test",
      "",
      1,
    ]) {
      for (const probe of PROBES) expect(isTerraBaseConfig(probe, { ...configs[probe], origin })).toBe(false);
    }
    for (const value of [null, "x", 1, undefined]) expect(isTerraBaseConfig("health", value)).toBe(false);
  });

  it("requires a key for documents and management, and only a non-empty one for health", () => {
    expect(isTerraBaseConfig("health", { origin: ORIGIN, key: "" })).toBe(false);
    expect(isTerraBaseConfig("health", { origin: ORIGIN, key: 1 })).toBe(false);
    for (const probe of ["documents", "management"] as const) {
      expect(isTerraBaseConfig(probe, { ...configs[probe], key: undefined })).toBe(false);
      expect(isTerraBaseConfig(probe, { ...configs[probe], key: "" })).toBe(false);
    }
  });

  it("checks the database and collection names and the tenant id", () => {
    for (const name of ["Canary", "1canary", "_canary", "can ary", "a".repeat(64), "", undefined]) {
      expect(isTerraBaseConfig("documents", { ...configs.documents, database: name })).toBe(false);
      expect(isTerraBaseConfig("documents", { ...configs.documents, collection: name })).toBe(false);
    }
    for (const tenant of [TENANT.toUpperCase(), "canary", TENANT.slice(1), undefined]) {
      expect(isTerraBaseConfig("management", { ...configs.management, tenant })).toBe(false);
    }
    // Each probe asks only for its own fields.
    expect(isTerraBaseConfig("documents", configs.management)).toBe(false);
    expect(isTerraBaseConfig("management", configs.documents)).toBe(false);
  });
});

describe("parseTerraBase", () => {
  it("reads the entries unchecked: empty when unset, null when not a JSON object", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseTerraBase(undefined)).toEqual({});
    expect(parseTerraBase("")).toEqual({});
    expect(parseTerraBase("not json")).toBeNull();
    expect(parseTerraBase("[]")).toBeNull();
    expect(parseTerraBase("null")).toBeNull();
    expect(parseTerraBase(JSON.stringify({ a: configs.health, b: "x" }))).toEqual({ a: configs.health, b: "x" });
    error.mockRestore();
  });

  it("names a not configured endpoint's unjudged sample", () => {
    expect(notConfiguredSample("x")).toEqual({
      endpointId: "x",
      state: "none",
      ok: 0,
      total: 0,
      latencyMs: null,
      results: [{ v: "canary", ok: null, ms: null, e: NOT_CONFIGURED }],
      values: null,
    });
  });
});

describe("runTerraBase health", () => {
  it("passes on 200 ready, sending the key only when it has one", async () => {
    const api = terrabase();
    const result = await runTerraBase("health", configs.health, "m", api.fetcher);
    expect(result).toMatchObject({ ok: true, error: null });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(new Headers(api.inits[0]?.headers).has("authorization")).toBe(false);
    await runTerraBase("health", { origin: ORIGIN, key: KEY }, "m", api.fetcher);
    expect(new Headers(api.inits[1]?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(api.calls).toEqual(["readyz", "readyz"]);
  });

  it("fails on a 5xx and on anything but ready", async () => {
    const api = terrabase();
    api.faults.readyz = { status: 503, body: "unavailable" };
    expect(await runTerraBase("health", configs.health, "m", api.fetcher)).toEqual({
      ok: false,
      latencyMs: null,
      error: "HTTP 503",
    });
    for (const body of ["starting", "", "ready now", "not ready"]) {
      api.faults.readyz = { status: 200, body };
      expect(await runTerraBase("health", configs.health, "m", api.fetcher)).toEqual({
        ok: false,
        latencyMs: null,
        error: "Invalid response",
      });
    }
  });
});

describe("runTerraBase documents", () => {
  it("creates, reads, queries and deletes a canary document with the key, never following redirects", async () => {
    const api = terrabase();
    expect(await runTerraBase("documents", configs.documents, "marker 1", api.fetcher)).toMatchObject({
      ok: true,
      error: null,
    });
    expect(api.calls).toEqual(DOCUMENT_ROUTES);
    expect(api.docs.size).toBe(0);
    for (const init of api.inits) {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      expect(init.redirect).toBe("manual");
    }
    expect(api.inits.map((init) => init.method ?? "GET")).toEqual(["PUT", "GET", "POST", "DELETE"]);
    expect(new Headers(api.inits[0]?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(api.inits[0]?.body))).toEqual({ canary: "marker 1" });
    // Every round writes the same document.
    expect(await runTerraBase("documents", configs.documents, "marker 2", api.fetcher)).toMatchObject({ ok: true });
    const puts = api.urls.filter((_, index) => api.inits[index]?.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(new Set(puts).size).toBe(1);
    expect(JSON.parse(String(api.inits[2]?.body))).toMatchObject({
      filter: { eq: ["$id", expect.any(String)] },
      limit: 1,
    });
  });

  it("fails a rejected create, still sending its delete", async () => {
    const api = terrabase();
    api.faults.create = { status: 503, body: { error: { code: "storage_unavailable" } } };
    expect(await runTerraBase("documents", configs.documents, "m", api.fetcher)).toEqual({
      ok: false,
      latencyMs: null,
      error: "HTTP 503 storage_unavailable",
    });
    expect(api.calls).toEqual(["create", "delete"]);
    expect(
      await runTerraBase("documents", { ...configs.documents, key: "tbk1_rotated" }, "m", terrabase().fetcher),
    ).toMatchObject({ ok: false, error: "HTTP 401 invalid_key" });
  });

  it("fails a create answering a malformed write, still deleting the canary document", async () => {
    const write = { version: `tbv1-${"0".repeat(32)}`, offset: "1", durability: "local_durable" };
    for (const body of [
      { ...write, id: crypto.randomUUID() },
      { ...write, id: "doc-1" },
      { ...write, version: "1" },
      { ...write, offset: undefined },
      {},
    ]) {
      const api = terrabase();
      api.faults.create = { status: 201, body };
      expect(await runTerraBase("documents", configs.documents, "m", api.fetcher)).toEqual({
        ok: false,
        latencyMs: null,
        error: "Invalid response",
      });
      expect(api.calls).toEqual(["create", "delete"]);
    }
    const api = terrabase();
    api.faults.create = { status: 201, body: "created" };
    expect(await runTerraBase("documents", configs.documents, "m", api.fetcher)).toMatchObject({
      error: "Invalid JSON",
    });
  });

  it("deletes a document whose create committed but whose answer was lost, in the same round", async () => {
    const api = terrabase();
    const losingCreate = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await api.fetcher(input, init);
      if (init?.method === "PUT") throw new TypeError("connection reset");
      return response;
    }) as typeof fetch;
    expect(await runTerraBase("documents", configs.documents, "m", losingCreate)).toMatchObject({
      ok: false,
      error: "Unreachable",
    });
    expect(api.calls).toEqual(["create", "delete"]);
    expect(api.docs.size).toBe(0);
  });

  it("leaves at most one document while every answer is lost, which the next round removes", async () => {
    const api = terrabase();
    const losing = (async (input: string | URL | Request, init?: RequestInit) => {
      // The create commits; the delete never reaches the server.
      if (init?.method !== "DELETE") await api.fetcher(input, init);
      throw new TypeError("connection reset");
    }) as typeof fetch;
    for (let round = 0; round < 3; round++) {
      expect(await runTerraBase("documents", configs.documents, `m${round}`, losing)).toMatchObject({
        ok: false,
        error: "Unreachable",
      });
    }
    expect(api.docs.size).toBe(1);
    expect(await runTerraBase("documents", configs.documents, "m3", api.fetcher)).toMatchObject({ ok: true });
    expect(api.docs.size).toBe(0);
  });

  it("still deletes the document when the read or the query fails", async () => {
    const cases: [Route, Reply, string][] = [
      ["read", { status: 500, body: "boom" }, "HTTP 500"],
      ["read", { status: 200, body: { id: "x", state: "absent" } }, "Invalid response"],
      ["query", { status: 503, body: { error: { code: "capacity" } } }, "HTTP 503 capacity"],
      ["query", { status: 200, body: { items: [], next_cursor: null } }, "Query missed the document"],
      ["query", { status: 200, body: { items: {}, next_cursor: null } }, "Invalid response"],
    ];
    for (const [route, reply, error] of cases) {
      const api = terrabase();
      api.faults[route] = reply;
      expect(await runTerraBase("documents", configs.documents, "m", api.fetcher)).toEqual({
        ok: false,
        latencyMs: null,
        error,
      });
      expect(api.calls.at(-1)).toBe("delete");
      expect(api.docs.size).toBe(0);
    }
  });

  it("fails a read or query holding another round's marker", async () => {
    // The document is found, but holds another write than this round's.
    const restamp = (value: { document?: { canary?: string } }) => ({
      ...value,
      document: { ...value.document, canary: "other" },
    });
    const cases: [string, string][] = [
      ["GET", "Invalid response"],
      ["POST", "Query missed the document"],
    ];
    for (const [method, error] of cases) {
      const api = terrabase();
      const tampering = (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await api.fetcher(input, init);
        const read = method === "GET" && init?.method === undefined;
        const query = method === "POST" && String(input).endsWith("/query");
        if (!read && !query) return response;
        const body = (await response.json()) as {
          document?: { canary?: string };
          items?: { document?: { canary?: string } }[];
        };
        return Response.json(read ? restamp(body) : { ...body, items: body.items?.map(restamp) });
      }) as typeof fetch;
      expect(await runTerraBase("documents", configs.documents, "m", tampering)).toMatchObject({ ok: false, error });
      expect(api.calls.at(-1)).toBe("delete");
      expect(api.docs.size).toBe(0);
    }
  });

  it("reports a failed delete, and the first failure when both fail", async () => {
    const api = terrabase();
    api.faults.delete = { status: 503, body: { error: { code: "storage_unavailable" } } };
    expect(await runTerraBase("documents", configs.documents, "m", api.fetcher)).toMatchObject({
      ok: false,
      error: "HTTP 503 storage_unavailable",
    });
    expect(api.calls).toEqual(DOCUMENT_ROUTES);
    api.faults.query = { status: 200, body: { items: [], next_cursor: null } };
    expect(await runTerraBase("documents", configs.documents, "m", api.fetcher)).toMatchObject({
      ok: false,
      error: "Query missed the document",
    });
    api.faults.delete = { status: 200, body: { id: crypto.randomUUID(), version: `tbv1-${"0".repeat(32)}` } };
    api.faults.query = undefined;
    expect(await runTerraBase("documents", configs.documents, "m", api.fetcher)).toMatchObject({
      ok: false,
      error: "Invalid response",
    });
  });
});

describe("runTerraBase management", () => {
  it("lists tenants and one tenant's databases", async () => {
    const api = terrabase();
    expect(await runTerraBase("management", configs.management, "m", api.fetcher)).toMatchObject({ ok: true });
    expect(api.calls).toEqual(["tenants", "databases"]);
    for (const init of api.inits) {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      expect(init.redirect).toBe("manual");
    }
    // An empty first page lists nothing, but is a valid answer.
    api.faults.tenants = { status: 200, body: { items: [], next_cursor: null } };
    expect(await runTerraBase("management", configs.management, "m", api.fetcher)).toMatchObject({ ok: true });
  });

  it("fails a rejected key, a 5xx and a malformed list", async () => {
    expect(
      await runTerraBase("management", { ...configs.management, key: "tbk1_other" }, "m", terrabase().fetcher),
    ).toEqual({ ok: false, latencyMs: null, error: "HTTP 401 invalid_key" });
    const api = terrabase();
    api.faults.databases = { status: 500, body: { error: { code: "internal" } } };
    expect(await runTerraBase("management", configs.management, "m", api.fetcher)).toMatchObject({
      error: "HTTP 500",
    });
    for (const body of [
      { items: {}, next_cursor: null },
      { items: [{ id: TENANT }], next_cursor: 1 },
      { items: [{ id: TENANT }] },
      { items: [{ name: "x" }], next_cursor: null },
      { items: [null], next_cursor: null },
    ]) {
      const listing = terrabase();
      listing.faults.tenants = { status: 200, body };
      expect(await runTerraBase("management", configs.management, "m", listing.fetcher)).toEqual({
        ok: false,
        latencyMs: null,
        error: "Invalid response",
      });
      expect(listing.calls).toEqual(["tenants"]);
    }
  });
});

describe("runTerraBase strictness", () => {
  it("requires the documented status and every documented member", async () => {
    const write = {
      id: crypto.randomUUID(),
      version: `tbv1-${"0".repeat(32)}`,
      offset: "1",
      durability: "local_durable",
    };
    const cases: [TerraBaseProbe, Route, Reply, string][] = [
      ["health", "readyz", { status: 202, body: "ready\n" }, "HTTP 202"],
      ["documents", "create", { status: 202, body: write }, "HTTP 202"],
      ["documents", "create", { status: 201, body: { ...write, offset: undefined } }, "Invalid response"],
      ["documents", "create", { status: 201, body: { ...write, durability: "eventually" } }, "Invalid response"],
      ["documents", "query", { status: 200, body: { items: [] } }, "Invalid response"],
      [
        "management",
        "tenants",
        { status: 200, body: { items: [{ id: "garbage" }], next_cursor: null } },
        "Invalid response",
      ],
    ];
    for (const [probe, route, reply, error] of cases) {
      const api = terrabase();
      api.faults[route] = reply;
      expect(await runTerraBase(probe, configs[probe], "m", api.fetcher), `${probe} ${route}`).toMatchObject({
        ok: false,
        error,
      });
    }
  });

  it("never stores an error code TerraBase does not document, such as an echoed key", async () => {
    const api = terrabase();
    // The key itself looks like a code.
    api.faults.tenants = { status: 401, body: { error: { code: KEY } } };
    expect(await runTerraBase("management", configs.management, "m", api.fetcher)).toEqual({
      ok: false,
      latencyMs: null,
      error: "HTTP 401",
    });
  });
});

describe("runTerraBase limits", () => {
  afterEach(() => vi.useRealTimers());

  it("times out each probe whose body stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled = (async (_input: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("rea"));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
        },
      });
      return new Response(body);
    }) as typeof fetch;
    for (const probe of PROBES) {
      const result = runTerraBase(probe, configs[probe], "m", stalled);
      // The document canary's delete follows its timed out create.
      await vi.advanceTimersByTimeAsync(2 * CANARY_TIMEOUT_MS);
      expect(await result).toEqual({ ok: false, latencyMs: null, error: "Timed out" });
    }
  });

  it("fails an unreachable origin and never follows a redirect", async () => {
    const unreachable = (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const redirects: RequestInit["redirect"][] = [];
    const redirecting = (async (_input: string, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
    }) as typeof fetch;
    for (const probe of PROBES) {
      expect(await runTerraBase(probe, configs[probe], "m", unreachable)).toMatchObject({ error: "Unreachable" });
      expect(await runTerraBase(probe, configs[probe], "m", redirecting)).toMatchObject({ error: "HTTP 302" });
    }
    // The document canary's delete follows its redirected create.
    expect(redirects).toEqual(["manual", "manual", "manual", "manual"]);
  });
});

/** A TerraBase server on loopback serving `api`; `hang` leaves every request unanswered. */
const realFetch = globalThis.fetch;
const api = terrabase();
const server = createServer((request, response) => {
  if (mock.hang) return;
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    const answer = api.reply(
      request.method ?? "GET",
      new URL(request.url ?? "/", "http://127.0.0.1"),
      request.headers.authorization ?? null,
      body,
    );
    const text = typeof answer.body === "string";
    response.writeHead(answer.status, { "content-type": text ? "text/plain" : "application/json" });
    response.end(text ? answer.body : JSON.stringify(answer.body));
  });
});
const mock = { hang: false, origin: "" };
/** Sends the configured https origin to the loopback server. */
const viaServer = ((input: string | URL | Request, init?: RequestInit) =>
  realFetch(String(input).replace(ORIGIN, mock.origin), init)) as typeof fetch;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  mock.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});

const resetServer = () => {
  mock.hang = false;
  for (const route of Object.keys(api.faults) as Route[]) delete api.faults[route];
  api.calls.length = 0;
};

describe("runTerraBase against a TerraBase server", () => {
  beforeEach(resetServer);
  afterEach(() => vi.useRealTimers());

  it("passes every probe and leaves no canary document behind", async () => {
    for (const probe of PROBES) {
      expect(await runTerraBase(probe, configs[probe], `marker ${probe}`, viaServer)).toMatchObject({
        ok: true,
        error: null,
      });
    }
    expect(api.calls).toEqual(["readyz", ...DOCUMENT_ROUTES, "tenants", "databases"]);
    expect(api.docs.size).toBe(0);
  });

  it("fails each probe on a 5xx", async () => {
    api.faults.readyz = { status: 503, body: "unavailable" };
    api.faults.create = { status: 503, body: { error: { code: "storage_unavailable" } } };
    api.faults.tenants = { status: 500, body: "Internal Server Error" };
    expect(await runTerraBase("health", configs.health, "m", viaServer)).toMatchObject({ error: "HTTP 503" });
    expect(await runTerraBase("documents", configs.documents, "m", viaServer)).toMatchObject({
      error: "HTTP 503 storage_unavailable",
    });
    expect(await runTerraBase("management", configs.management, "m", viaServer)).toMatchObject({
      error: "HTTP 500",
    });
  });

  it("fails each probe on a wrong payload, deleting what it created", async () => {
    api.faults.readyz = { status: 200, body: "starting" };
    api.faults.query = { status: 200, body: { items: [], next_cursor: null } };
    api.faults.databases = { status: 200, body: { items: "none", next_cursor: null } };
    expect(await runTerraBase("health", configs.health, "m", viaServer)).toMatchObject({ error: "Invalid response" });
    expect(await runTerraBase("documents", configs.documents, "m", viaServer)).toMatchObject({
      error: "Query missed the document",
    });
    expect(api.docs.size).toBe(0);
    expect(await runTerraBase("management", configs.management, "m", viaServer)).toMatchObject({
      error: "Invalid response",
    });
  });

  it("times out a server that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mock.hang = true;
    for (const probe of PROBES) {
      const result = runTerraBase(probe, configs[probe], "m", viaServer);
      await vi.advanceTimersByTimeAsync(2 * CANARY_TIMEOUT_MS);
      expect(await result).toEqual({ ok: false, latencyMs: null, error: "Timed out" });
    }
  });
});

const TERRABASE_ENDPOINTS = ["document-api-gru", "management-api-gru", "terrabase-health-gru"];
const SECRET = JSON.stringify({
  "terrabase-health-gru": configs.health,
  "document-api-gru": configs.documents,
  "management-api-gru": configs.management,
});

describe("TerraBase rounds", () => {
  beforeEach(resetServer);
  afterEach(() => vi.unstubAllGlobals());

  const vantage = (code: string) => ({
    fetch: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as ProbeRequest;
      return Response.json({
        vantage: code,
        colo: null,
        results: body.targets.map((target) => ({ key: target.key, status: 200, latencyMs: 40, error: null })),
      } satisfies ProbeResponse);
    },
  });

  const roundEnv = (secret?: string) => {
    const db = testD1();
    const env = {
      STATUS_DB: db,
      VANTAGE_SFO: vantage("sfo"),
      VANTAGE_GRU: vantage("gru"),
      VANTAGE_FRA: vantage("fra"),
      VANTAGE_NRT: vantage("nrt"),
      TERRABASE_PROBES: secret,
    } as unknown as Env;
    return { db, env };
  };

  const samples = (db: ReturnType<typeof testD1>) =>
    db.sqlite
      .prepare(
        `SELECT endpoint_id AS id, state, ok, total, latency_ms AS ms, results FROM probe_samples
          WHERE endpoint_id IN (SELECT id FROM endpoints WHERE probe IS NOT NULL) ORDER BY at, endpoint_id`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        state: row.state,
        ok: row.ok,
        total: row.total,
        ms: row.ms,
        results: JSON.parse(String(row.results)) as unknown,
      }));

  const empty = () => ({ streaks: {}, colos: {}, versions: {}, trackers: {} });
  const start = Date.parse("2026-10-01T10:00:00Z");

  it("seeds only GRU enabled, and stores it as not configured without the secret", async () => {
    const { db, env } = roundEnv();
    expect(
      db.sqlite.prepare("SELECT id FROM endpoints WHERE probe IS NOT NULL AND enabled = 1 ORDER BY id").all(),
    ).toEqual(TERRABASE_ENDPOINTS.map((id) => ({ id })));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await runRound(env, start, empty());
    expect(fetcher).not.toHaveBeenCalled();
    expect(samples(db)).toEqual(
      TERRABASE_ENDPOINTS.map((id) => ({
        id,
        state: "none",
        ok: 0,
        total: 0,
        ms: null,
        results: [{ v: "canary", ok: null, ms: null, e: "Not configured" }],
      })),
    );
  });

  it("stores operational samples, then confirms an outage on the second failure", async () => {
    vi.stubGlobal("fetch", viaServer);
    const { db, env } = roundEnv(SECRET);
    let state = empty();
    for (let round = 0; round < 3; round++) {
      if (round === 1) {
        api.faults.readyz = { status: 503, body: "unavailable" };
        api.faults.create = { status: 503, body: { error: { code: "storage_unavailable" } } };
        api.faults.tenants = { status: 503, body: { error: { code: "dependencies_unavailable" } } };
      }
      state = await runRound(env, start + round * 30_000, state);
    }
    const stored = samples(db);
    expect(stored.map((sample) => [sample.id, sample.state, sample.ok, sample.total])).toEqual([
      ...TERRABASE_ENDPOINTS.map((id) => [id, "operational", 1, 1]),
      ...TERRABASE_ENDPOINTS.map((id) => [id, "degraded", 0, 1]),
      ...TERRABASE_ENDPOINTS.map((id) => [id, "major_outage", 0, 1]),
    ]);
    for (const sample of stored.slice(0, 3)) {
      expect(sample.ms).toBeGreaterThanOrEqual(0);
      expect(sample.results).toEqual([{ v: "canary", ok: 1, ms: sample.ms, e: null }]);
    }
    expect(stored.slice(6).map((sample) => sample.results)).toEqual([
      [{ v: "canary", ok: 0, ms: null, e: "HTTP 503 storage_unavailable" }],
      [{ v: "canary", ok: 0, ms: null, e: "HTTP 503 dependencies_unavailable" }],
      [{ v: "canary", ok: 0, ms: null, e: "HTTP 503" }],
    ]);
    expect(api.docs.size).toBe(0);
  });

  it("fails a malformed entry without probing it", async () => {
    const fetcher = vi.fn(viaServer);
    vi.stubGlobal("fetch", fetcher);
    const { db, env } = roundEnv(
      JSON.stringify({
        "terrabase-health-gru": { origin: "http://terrabase.test" },
        "document-api-gru": configs.management,
      }),
    );
    await runRound(env, start, empty());
    expect(fetcher).not.toHaveBeenCalled();
    expect(samples(db).map((sample) => [sample.id, sample.state, sample.total, sample.results])).toEqual([
      ["document-api-gru", "degraded", 1, [{ v: "canary", ok: 0, ms: null, e: "Invalid probe config" }]],
      ["management-api-gru", "none", 0, [{ v: "canary", ok: null, ms: null, e: "Not configured" }]],
      ["terrabase-health-gru", "degraded", 1, [{ v: "canary", ok: 0, ms: null, e: "Invalid probe config" }]],
    ]);
  });

  it("fails every probe when the secret stops being JSON, rather than going quiet", async () => {
    vi.stubGlobal("fetch", viaServer);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, env } = roundEnv(SECRET);
    const state = await runRound(env, start, empty());
    env.TERRABASE_PROBES = "{not json";
    await runRound(env, start + 30_000, state);
    expect(samples(db).map((sample) => [sample.id, sample.state, sample.total, sample.results])).toEqual([
      ...TERRABASE_ENDPOINTS.map((id) => [id, "operational", 1, expect.anything()]),
      ...TERRABASE_ENDPOINTS.map((id) => [
        id,
        "degraded",
        1,
        [{ v: "canary", ok: 0, ms: null, e: "Invalid probe config" }],
      ]),
    ]);
    error.mockRestore();
  });

  it("shows an entry still waiting for its key as not configured", async () => {
    const fetcher = vi.fn(viaServer);
    vi.stubGlobal("fetch", fetcher);
    const { db, env } = roundEnv(
      JSON.stringify({
        "document-api-gru": { ...configs.documents, key: undefined },
        "management-api-gru": { origin: ORIGIN, tenant: TENANT },
      }),
    );
    await runRound(env, start, empty());
    expect(fetcher).not.toHaveBeenCalled();
    expect(samples(db).map((sample) => [sample.id, sample.state, sample.total])).toEqual([
      ["document-api-gru", "none", 0],
      ["management-api-gru", "none", 0],
      ["terrabase-health-gru", "none", 0],
    ]);
  });

  it("fails an array or null entry instead of taking it for one waiting for its key", async () => {
    const fetcher = vi.fn(viaServer);
    vi.stubGlobal("fetch", fetcher);
    const { db, env } = roundEnv(
      JSON.stringify({ "document-api-gru": [], "management-api-gru": null, "terrabase-health-gru": [] }),
    );
    await runRound(env, start, empty());
    expect(fetcher).not.toHaveBeenCalled();
    expect(samples(db).map((sample) => [sample.id, sample.state, sample.results])).toEqual([
      ["document-api-gru", "degraded", [{ v: "canary", ok: 0, ms: null, e: "Invalid probe config" }]],
      ["management-api-gru", "degraded", [{ v: "canary", ok: 0, ms: null, e: "Invalid probe config" }]],
      ["terrabase-health-gru", "degraded", [{ v: "canary", ok: 0, ms: null, e: "Invalid probe config" }]],
    ]);
  });

  it("never counts not configured rounds toward resolving an incident", async () => {
    vi.stubGlobal("fetch", viaServer);
    const health = JSON.stringify({ "terrabase-health-gru": configs.health });
    const { db, env } = roundEnv(health);
    const incident = () =>
      db.sqlite.prepare("SELECT status FROM incidents WHERE source = 'auto' AND auto_key = 'terrabase-health'").get();
    let state = empty();
    let round = 0;
    const next = async (secret: string | undefined) => {
      env.TERRABASE_PROBES = secret;
      state = await runRound(env, start + round++ * 30_000, state);
    };
    api.faults.readyz = { status: 503, body: "unavailable" };
    for (let index = 0; index < 3; index++) await next(health);
    expect(incident()).toEqual({ status: "investigating" });
    api.faults.readyz = undefined;
    await next(health);
    expect(incident()).toEqual({ status: "monitoring" });
    // Five minutes without the secret, then the first configured round.
    for (let index = 0; index < 10; index++) await next(undefined);
    await next(health);
    expect(incident()).toEqual({ status: "monitoring" });
    // Resolved five minutes after the last unmeasured round, not before.
    for (let index = 0; index < 8; index++) await next(health);
    expect(incident()).toEqual({ status: "monitoring" });
    await next(health);
    expect(incident()).toBeUndefined();
  });

  it("rolls up configured rounds as checks and not configured ones as none", async () => {
    vi.stubGlobal("fetch", viaServer);
    const { db, env } = roundEnv();
    let state = await runRound(env, start, empty());
    // Only the health probe is configured from the second round on.
    env.TERRABASE_PROBES = JSON.stringify({ "terrabase-health-gru": configs.health });
    for (let round = 1; round < 3; round++) state = await runRound(env, start + round * 30_000, state);
    await db.batch(rollupStatements(db, TERRABASE_ENDPOINTS, Date.parse("2026-10-01T10:10:00Z")));

    const hours = db.sqlite
      .prepare("SELECT endpoint_id AS id, vantage, checks, failures FROM probe_hours ORDER BY endpoint_id, vantage")
      .all();
    expect(hours).toEqual([
      { id: "terrabase-health-gru", vantage: "all", checks: 2, failures: 0 },
      { id: "terrabase-health-gru", vantage: "canary", checks: 2, failures: 0 },
    ]);
    expect(db.sqlite.prepare("SELECT DISTINCT endpoint_id AS id FROM probe_days ORDER BY id").all()).toEqual([
      { id: "terrabase-health-gru" },
    ]);
  });
});
