import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { testD1 } from "../testing/d1";
import { CANARY_TIMEOUT_MS, parseCanaries, runCanary, type CanaryConfig } from "./canary";
import { MAX_BODY_BYTES } from "./check";
import type { ProbeRequest, ProbeResponse } from "./protocol";
import { runRound } from "./round";

const config: CanaryConfig = {
  origin: "https://gru.api.test",
  tenant: "018f0000-0000-7000-8000-00000000000a",
  database: "018f0000-0000-7000-8000-00000000000b",
  shard: "0",
  collection: "018f0000-0000-7000-8000-00000000000c",
  document: "018f0000-0000-7000-8000-00000000000d",
  schemaGeneration: "1",
  schemaDigest: "a".repeat(64),
  fieldId: 1,
  key: "tbk1_canary",
};

const POINT = `/v1/tenants/${config.tenant}/databases/${config.database}/shards/0/collections/${config.collection}/documents/${config.document}`;
const COMMIT = `/v1/tenants/${config.tenant}/databases/${config.database}/shards/0/transactions`;

/** A TerraBase document API holding the one canary document. `lose` drops
    committed writes, as a broken replica would. */
function dataApi(options: { key?: string; lose?: boolean } = {}) {
  let sequence = 0;
  let fields: unknown[] | null = null;
  const commits: Record<string, unknown>[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${options.key ?? config.key}`) {
      return Response.json({ error: { code: "invalid_key" } }, { status: 401 });
    }
    const context = () =>
      sequence === 0
        ? []
        : [
            {
              replica: "018f0000-0000-7000-8000-000000000005",
              incarnation: "1".repeat(32),
              sequence: String(sequence),
            },
          ];
    if (url.pathname === POINT && (init?.method ?? "GET") === "GET") {
      return Response.json({
        version: 1,
        state: fields ? "value" : "absent",
        context: context(),
        siblings: fields ? [{ kind: "live", schema_generation: "1", schema_digest: config.schemaDigest, fields }] : [],
      });
    }
    if (url.pathname === COMMIT && init?.method === "POST") {
      if (headers.get("content-type") !== "application/json") return new Response(null, { status: 415 });
      const body = JSON.parse(String(init.body)) as { writes: { observed: unknown; value: { fields: unknown[] } }[] };
      commits.push(body);
      const write = body.writes[0];
      if (JSON.stringify(write?.observed) !== JSON.stringify(context())) {
        return Response.json({ error: { code: "conflict" } }, { status: 409 });
      }
      sequence += 1;
      if (!options.lose) fields = write?.value.fields ?? null;
      return Response.json({ version: 1, durability: "local_durable", commit_sequence: String(sequence) });
    }
    return Response.json({ error: { code: "unknown_route" } }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, commits };
}

describe("parseCanaries", () => {
  it("keeps only complete entries and is empty without the secret", () => {
    expect(parseCanaries(undefined)).toEqual({});
    expect(parseCanaries("not json")).toEqual({});
    expect(
      parseCanaries(JSON.stringify({ good: config, bad: { ...config, schemaDigest: "short" }, worse: "x" })),
    ).toEqual({ good: config });
  });
});

describe("runCanary", () => {
  it("writes the marker over the current context and reads it back", async () => {
    const api = dataApi();
    expect(await runCanary(config, "first", api.fetcher)).toMatchObject({ ok: true, error: null });
    expect(await runCanary(config, "second", api.fetcher)).toMatchObject({ ok: true, error: null });
    expect(api.commits).toHaveLength(2);
    expect(api.commits[1]).toMatchObject({
      version: 1,
      writes: [
        {
          collection: config.collection,
          document: config.document,
          schema_generation: "1",
          schema_digest: config.schemaDigest,
          observed: [{ sequence: "1" }],
          value: { kind: "live", fields: [{ id: 1, value: { type: "utf8", value: "second" } }] },
        },
      ],
    });
  });

  it("fails on a rejected key and on a write that cannot be read back", async () => {
    expect(await runCanary(config, "m", dataApi({ key: "other" }).fetcher)).toEqual({
      ok: false,
      latencyMs: null,
      error: "HTTP 401 invalid_key",
    });
    expect(await runCanary(config, "m", dataApi({ lose: true }).fetcher)).toEqual({
      ok: false,
      latencyMs: null,
      error: "Write not readable",
    });
    // A conflict or a differently typed value does not prove the write.
    const reading = (state: string, value: unknown) =>
      (async (_input: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ version: 1 })
          : Response.json({
              version: 1,
              state,
              context: [],
              siblings: [{ kind: "live", fields: [{ id: 1, value }] }],
            })) as typeof fetch;
    expect(await runCanary(config, "m", reading("conflict", { type: "utf8", value: "m" }))).toMatchObject({
      ok: false,
      error: "Write not readable",
    });
    expect(await runCanary(config, "m", reading("value", { type: "bytes", value: "m" }))).toMatchObject({
      ok: false,
      error: "Write not readable",
    });
    expect(await runCanary(config, "m", reading("value", { type: "utf8", value: "m" }))).toMatchObject({ ok: true });
    expect(
      await runCanary(config, "m", (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch),
    ).toMatchObject({ ok: false, error: "Unreachable" });
  });
});

describe("runCanary limits", () => {
  afterEach(() => vi.useRealTimers());

  it("times out a response whose body stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled = (async (_input: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"version":'));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = runCanary(config, "m", stalled);
    await vi.advanceTimersByTimeAsync(CANARY_TIMEOUT_MS);
    expect(await result).toEqual({ ok: false, latencyMs: null, error: "Timed out" });
  });

  it("refuses an oversized body and never writes over a malformed context", async () => {
    let posted = false;
    const answering = (body: string) =>
      (async (_input: string, init?: RequestInit) => {
        if (init?.method === "POST") posted = true;
        return new Response(body, { headers: { "content-type": "application/json" } });
      }) as typeof fetch;
    expect(await runCanary(config, "m", answering(" ".repeat(MAX_BODY_BYTES + 1)))).toEqual({
      ok: false,
      latencyMs: null,
      error: "Response too large",
    });
    expect(await runCanary(config, "m", answering("{}"))).toEqual({
      ok: false,
      latencyMs: null,
      error: "Invalid point",
    });
    expect(
      await runCanary(config, "m", answering('{"version":1,"state":"value","context":[{}],"siblings":[]}')),
    ).toMatchObject({ ok: false, error: "Invalid point" });
    for (const siblings of ["[null]", '[{"kind":"live","fields":{}}]', '[{"kind":"live","fields":[{"id":1}]}]']) {
      expect(
        await runCanary(config, "m", answering(`{"version":1,"state":"value","context":[],"siblings":${siblings}}`)),
      ).toMatchObject({ ok: false, error: "Invalid point" });
    }
    expect(posted).toBe(false);
  });

  it("fails a replayed round whose second write is lost", async () => {
    const options = { lose: false };
    const api = dataApi(options);
    expect(await runCanary(config, "round 1 attempt a", api.fetcher)).toMatchObject({ ok: true });
    // The replay's commit is acknowledged but lost; the first attempt's marker remains.
    options.lose = true;
    expect(await runCanary(config, "round 1 attempt b", api.fetcher)).toMatchObject({
      ok: false,
      error: "Write not readable",
    });
  });

  it("never follows a redirect with the key", async () => {
    const seen: RequestInit["redirect"][] = [];
    const redirecting = (async (_input: string, init?: RequestInit) => {
      seen.push(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
    }) as typeof fetch;
    expect(await runCanary(config, "m", redirecting)).toEqual({ ok: false, latencyMs: null, error: "HTTP 302" });
    expect(seen).toEqual(["manual"]);
  });
});

describe("canary rounds", () => {
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
    db.sqlite.exec("UPDATE endpoints SET enabled = 1 WHERE id = 'data-api-canary-gru'");
    const env = {
      STATUS_DB: db,
      VANTAGE_SFO: vantage("sfo"),
      VANTAGE_GRU: vantage("gru"),
      VANTAGE_FRA: vantage("fra"),
      VANTAGE_NRT: vantage("nrt"),
      DATA_API_CANARY: secret,
    } as unknown as Env;
    return { db, env };
  };

  const canarySamples = (db: ReturnType<typeof testD1>) =>
    db.sqlite
      .prepare(
        "SELECT state, ok, total, results FROM probe_samples WHERE endpoint_id = 'data-api-canary-gru' ORDER BY at",
      )
      .all();

  it("is not run while disabled, the way it is seeded", async () => {
    const { db, env } = roundEnv();
    db.sqlite.exec("UPDATE endpoints SET enabled = 0 WHERE id = 'data-api-canary-gru'");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await runRound(env, Date.parse("2026-10-01T10:00:00Z"), { streaks: {}, colos: {}, versions: {}, trackers: {} });
    expect(fetcher).not.toHaveBeenCalled();
    expect(canarySamples(db)).toEqual([]);
  });

  it("fails when enabled without its secret, so losing the secret resolves nothing silently", async () => {
    const { db, env } = roundEnv();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await runRound(env, Date.parse("2026-10-01T10:00:00Z"), { streaks: {}, colos: {}, versions: {}, trackers: {} });
    expect(fetcher).not.toHaveBeenCalled();
    const samples = canarySamples(db);
    expect(samples.map((sample) => [sample.state, sample.ok, sample.total])).toEqual([["degraded", 0, 1]]);
    expect(JSON.parse(String(samples[0]?.results))).toEqual([
      { v: "canary", ok: 0, ms: null, e: "Canary not configured" },
    ]);
  });

  it("stores a canary sample per round and confirms an outage on the second failure", async () => {
    let healthy = true;
    const good = dataApi();
    const broken = dataApi({ key: "rotated" });
    vi.stubGlobal("fetch", ((input: string, init?: RequestInit) =>
      (healthy ? good : broken).fetcher(input, init)) as typeof fetch);
    const { db, env } = roundEnv(JSON.stringify({ "data-api-canary-gru": config }));

    let state = { streaks: {}, colos: {}, versions: {}, trackers: {} };
    const start = Date.parse("2026-10-01T10:00:00Z");
    for (let round = 0; round < 3; round++) {
      if (round === 1) healthy = false;
      state = await runRound(env, start + round * 30_000, state);
    }

    const samples = canarySamples(db);
    expect(samples.map((sample) => [sample.state, sample.ok, sample.total])).toEqual([
      ["operational", 1, 1],
      ["degraded", 0, 1],
      ["major_outage", 0, 1],
    ]);
    expect(JSON.parse(String(samples[2]?.results))).toEqual([
      { v: "canary", ok: 0, ms: null, e: "HTTP 401 invalid_key" },
    ]);
    expect(good.commits).toHaveLength(1);
  });
});
