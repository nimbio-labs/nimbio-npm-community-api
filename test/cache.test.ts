/**
 * Coverage for conditional requests: the ETag store itself, the transparent
 * `If-None-Match` / 304 round trip in the request loop, the LRU bound, the
 * opt-out, and the stats accessor.
 *
 * The behaviour under test is the point of the feature: a 304 must be
 * indistinguishable from a fresh 200 to the caller, while costing no body on
 * the wire and no monthly quota.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient, APIError, DEFAULT_CACHE_SIZE } from "../src/index.js";
import { EtagCache, cacheKey, isCacheable } from "../src/cache.js";
import { STREAM_PATH } from "../src/sse.js";
import { mockFetch, TEST_KEY, type MockResponseSpec, type CapturedRequest } from "./helpers.js";

/** A gate-status body with one latch, named so mutation is easy to spot. */
function gateBody(name: string): Record<string, unknown> {
  return {
    latches: [
      {
        latch_id: "L1",
        latch_name: name,
        status: "closed",
        possible_statuses: [{ status: "closed", transient: false }],
      },
    ],
  };
}

/** A 200 carrying an ETag, as every conditional route on the API answers. */
function ok(body: unknown, etag = 'W/"v1"'): MockResponseSpec {
  return { status: 200, body, headers: { etag, "cache-control": "private, no-cache" } };
}

/** A bodyless 304, as the API answers an unchanged representation. */
const NOT_MODIFIED: MockResponseSpec = {
  status: 304,
  headers: { etag: 'W/"v1"', "cache-control": "private, no-cache" },
};

function headerOf(call: CapturedRequest, name: string): string | undefined {
  const found = Object.entries(call.headers).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  );
  return found?.[1];
}

function client(responses: MockResponseSpec | MockResponseSpec[], options = {}) {
  const mf = mockFetch(responses);
  return {
    client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl, ...options }),
    calls: mf.calls,
  };
}

describe("conditional requests (on by default)", () => {
  it("sends no If-None-Match first, then revalidates with the stored ETag", async () => {
    const { client: c, calls } = client([ok(gateBody("Front")), NOT_MODIFIED]);

    await c.community.gateStatus();
    expect(headerOf(calls[0]!, "if-none-match")).toBeUndefined();

    await c.community.gateStatus();
    expect(headerOf(calls[1]!, "if-none-match")).toBe('W/"v1"');
  });

  it("makes a 304 indistinguishable from the 200 it replaces", async () => {
    const { client: c } = client([ok(gateBody("Front")), NOT_MODIFIED]);

    const first = await c.community.gateStatus();
    const second = await c.community.gateStatus();

    expect(second).toEqual(first);
    expect(second.latches[0]!.latchName).toBe("Front");
    expect(second.latches[0]!.possibleStatuses[0]!.status).toBe("closed");
    // Equal, but never the same instance — see the mutation test below.
    expect(second).not.toBe(first);
  });

  it("re-parses on every hit, so mutating a result cannot corrupt a later read", async () => {
    const { client: c } = client([ok(gateBody("Front")), NOT_MODIFIED, NOT_MODIFIED]);

    const first = await c.community.gateStatus();
    // A caller doing perfectly ordinary things to a value they were handed.
    first.latches[0]!.latchName = "MUTATED";
    first.latches.push({ ...first.latches[0]! });
    (first.raw as Record<string, unknown>).latches = "clobbered";
    (first.latches[0]!.raw as Record<string, unknown>).latch_name = "MUTATED";

    const second = await c.community.gateStatus();
    expect(second.latches).toHaveLength(1);
    expect(second.latches[0]!.latchName).toBe("Front");
    expect(second.raw.latches).toBeInstanceOf(Array);

    // And the same again after a second hit — the store is not consumed.
    second.latches.length = 0;
    const third = await c.community.gateStatus();
    expect(third.latches[0]!.latchName).toBe("Front");
  });

  it("refreshes the stored ETag when the representation changes", async () => {
    const { client: c, calls } = client([
      ok(gateBody("Front"), 'W/"v1"'),
      ok(gateBody("Side"), 'W/"v2"'),
      NOT_MODIFIED,
    ]);

    await c.community.gateStatus();
    const changed = await c.community.gateStatus();
    expect(headerOf(calls[1]!, "if-none-match")).toBe('W/"v1"');
    expect(changed.latches[0]!.latchName).toBe("Side");

    await c.community.gateStatus();
    expect(headerOf(calls[2]!, "if-none-match")).toBe('W/"v2"');
  });

  it("keys on query params, so different pages do not collide", async () => {
    const { client: c, calls } = client([
      ok({ access_logs: [{ id: 1 }] }),
      ok({ access_logs: [{ id: 2 }] }, 'W/"p1"'),
      NOT_MODIFIED,
    ]);

    await c.community.accessLog({ page: 0 });
    await c.community.accessLog({ page: 1 });
    // Page 1 is a different key, so it revalidated nothing.
    expect(headerOf(calls[1]!, "if-none-match")).toBeUndefined();

    await c.community.accessLog({ page: 1 });
    expect(headerOf(calls[2]!, "if-none-match")).toBe('W/"p1"');
  });

  it("does not store a 200 that carries no ETag", async () => {
    const { client: c, calls } = client({ status: 200, body: gateBody("Front") });

    await c.community.gateStatus();
    await c.community.gateStatus();

    expect(headerOf(calls[1]!, "if-none-match")).toBeUndefined();
    expect(c.cacheStats).toEqual({ hits: 0, misses: 2, entries: 0 });
  });

  it("never caches non-GET requests, even if the response carries an ETag", async () => {
    const { client: c, calls } = client({
      status: 200,
      body: { result: "simulated" },
      headers: { etag: 'W/"nope"' },
    });

    await c.community.open("L1");
    await c.community.open("L1");

    expect(calls.every((call) => headerOf(call, "if-none-match") === undefined)).toBe(true);
    expect(c.cacheStats).toEqual({ hits: 0, misses: 0, entries: 0 });
  });

  it("leaves the SSE stream alone", async () => {
    const frame = JSON.stringify({
      event: "sense_line.changed",
      id: "e1",
      community_id: 5,
      occurred_at: "2026-07-31T12:00:00+00:00",
      data: { latch_id: "L1" },
    });
    const { client: c, calls } = client({
      status: 200,
      body: `: stream open\n\nid: e1\nevent: sense_line.changed\ndata: ${frame}\n\n`,
      headers: { "content-type": "text/event-stream", etag: 'W/"stream"' },
    });

    const controller = new AbortController();
    for await (const _msg of c.community.streamEvents({ signal: controller.signal })) {
      controller.abort(); // one event is enough
    }

    expect(calls[0]!.url).toContain(STREAM_PATH);
    expect(headerOf(calls[0]!, "if-none-match")).toBeUndefined();
    expect(c.cacheStats).toEqual({ hits: 0, misses: 0, entries: 0 });
  });

  it("does not count failed responses as misses or store them", async () => {
    const { client: c } = client({
      status: 403,
      body: { error: { code: "insufficient_scope", message: "nope" } },
      headers: { etag: 'W/"v1"' },
    });

    await expect(c.community.gateStatus()).rejects.toBeInstanceOf(APIError);
    expect(c.cacheStats).toEqual({ hits: 0, misses: 0, entries: 0 });
  });

  it("survives a retry and still stores the eventual 200", async () => {
    const { client: c, calls } = client([
      { status: 503, headers: { "retry-after": "0" } },
      ok(gateBody("Front")),
      NOT_MODIFIED,
    ]);

    await c.community.gateStatus();
    const after = await c.community.gateStatus();

    expect(calls).toHaveLength(3);
    expect(headerOf(calls[2]!, "if-none-match")).toBe('W/"v1"');
    expect(after.latches[0]!.latchName).toBe("Front");
  });
});

describe("cache stats", () => {
  it("reports hits, misses and stored entries", async () => {
    const { client: c } = client([
      ok(gateBody("Front")),
      NOT_MODIFIED,
      NOT_MODIFIED,
      ok({ access_logs: [] }, 'W/"logs"'),
    ]);

    expect(c.cacheStats).toEqual({ hits: 0, misses: 0, entries: 0 });
    await c.community.gateStatus();
    expect(c.cacheStats).toEqual({ hits: 0, misses: 1, entries: 1 });
    await c.community.gateStatus();
    await c.community.gateStatus();
    expect(c.cacheStats).toEqual({ hits: 2, misses: 1, entries: 1 });
    await c.community.accessLog();
    expect(c.cacheStats).toEqual({ hits: 2, misses: 2, entries: 2 });
  });

  it("clearCache() drops entries and forces a full re-fetch", async () => {
    const { client: c, calls } = client([ok(gateBody("Front")), ok(gateBody("Front"))]);

    await c.community.gateStatus();
    c.clearCache();
    expect(c.cacheStats.entries).toBe(0);

    await c.community.gateStatus();
    expect(headerOf(calls[1]!, "if-none-match")).toBeUndefined();
  });
});

describe("opting out", () => {
  it("cache: false never sends If-None-Match and stores nothing", async () => {
    const { client: c, calls } = client([ok(gateBody("Front")), ok(gateBody("Front"))], {
      cache: false,
    });

    await c.community.gateStatus();
    await c.community.gateStatus();

    expect(calls.every((call) => headerOf(call, "if-none-match") === undefined)).toBe(true);
    expect(c.cacheStats).toEqual({ hits: 0, misses: 0, entries: 0 });
    c.clearCache(); // no-op, must not throw
  });

  it("cacheSize: 0 disables it too", async () => {
    const { client: c, calls } = client([ok(gateBody("Front")), ok(gateBody("Front"))], {
      cacheSize: 0,
    });

    await c.community.gateStatus();
    await c.community.gateStatus();

    expect(headerOf(calls[1]!, "if-none-match")).toBeUndefined();
    expect(c.cacheStats.entries).toBe(0);
  });
});

describe("LRU bound", () => {
  it("evicts the least recently used entry past cacheSize", async () => {
    const { client: c, calls } = client([
      ok({ access_logs: [] }, 'W/"p0"'),
      ok({ access_logs: [] }, 'W/"p1"'),
      ok({ access_logs: [] }, 'W/"p2"'),
      ok({ access_logs: [] }, 'W/"p0b"'),
    ], { cacheSize: 2 });

    await c.community.accessLog({ page: 0 });
    await c.community.accessLog({ page: 1 });
    await c.community.accessLog({ page: 2 }); // evicts page 0
    expect(c.cacheStats.entries).toBe(2);

    await c.community.accessLog({ page: 0 });
    expect(headerOf(calls[3]!, "if-none-match")).toBeUndefined();
    expect(c.cacheStats.entries).toBe(2);
  });

  it("a hit refreshes recency, protecting the entry from eviction", async () => {
    const { client: c, calls } = client([
      ok({ access_logs: [] }, 'W/"p0"'),
      ok({ access_logs: [] }, 'W/"p1"'),
      NOT_MODIFIED, // page 0 revalidates -> now the most recent
      ok({ access_logs: [] }, 'W/"p2"'), // evicts page 1, not page 0
      NOT_MODIFIED, // page 0 still cached
    ], { cacheSize: 2 });

    await c.community.accessLog({ page: 0 });
    await c.community.accessLog({ page: 1 });
    await c.community.accessLog({ page: 0 });
    await c.community.accessLog({ page: 2 });
    await c.community.accessLog({ page: 0 });

    expect(headerOf(calls[4]!, "if-none-match")).toBe('W/"p0"');
  });
});

describe("a caller-supplied If-None-Match", () => {
  it("is not overridden by the client", async () => {
    const { client: c, calls } = client([ok(gateBody("Front")), ok(gateBody("Front"))], {
      defaultHeaders: { "If-None-Match": 'W/"mine"' },
    });

    await c.community.gateStatus();
    await c.community.gateStatus();

    expect(headerOf(calls[1]!, "if-none-match")).toBe('W/"mine"');
  });

  it("raises a clear error if it produces a 304 we cannot resolve", async () => {
    const { client: c } = client(NOT_MODIFIED, {
      defaultHeaders: { "if-none-match": 'W/"mine"' },
    });

    await expect(c.community.gateStatus()).rejects.toMatchObject({
      status: 304,
      message: expect.stringContaining("defaultHeaders"),
    });
  });

  it("raises the same error when the cache is disabled entirely", async () => {
    const { client: c } = client(NOT_MODIFIED, {
      cache: false,
      defaultHeaders: { "If-None-Match": 'W/"mine"' },
    });

    await expect(c.community.gateStatus()).rejects.toBeInstanceOf(APIError);
  });
});

describe("EtagCache unit behaviour", () => {
  it("defaults to DEFAULT_CACHE_SIZE and never goes below one entry", () => {
    expect(DEFAULT_CACHE_SIZE).toBe(256);
    expect(new EtagCache().maxEntries).toBe(DEFAULT_CACHE_SIZE);
    expect(new EtagCache(-5).maxEntries).toBe(1);
    expect(new EtagCache(2.9).maxEntries).toBe(2);
  });

  it("returns null for an unknown key without counting a hit", () => {
    const cache = new EtagCache();
    expect(cache.etagFor("GET /v1/x")).toBeNull();
    expect(cache.hit("GET /v1/x")).toBeNull();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, entries: 0 });
  });

  it("keeps counters across a clear()", () => {
    const cache = new EtagCache();
    cache.put("k", "e", "{}");
    cache.hit("k");
    cache.miss();
    cache.clear();
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, entries: 0 });
  });
});

describe("cache key and eligibility", () => {
  it("normalises param order so equivalent requests share one entry", () => {
    expect(cacheKey("GET", "/v1/a", { b: "2", a: "1" })).toBe(
      cacheKey("get", "/v1/a", { a: "1", b: "2" }),
    );
  });

  it("omits the query when there are no params", () => {
    expect(cacheKey("GET", "/v1/a", null)).toBe("GET /v1/a");
    expect(cacheKey("GET", "/v1/a", {})).toBe("GET /v1/a");
  });

  it("accepts GETs and rejects writes and the event stream", () => {
    expect(isCacheable("GET", "/v1/community")).toBe(true);
    expect(isCacheable("get", "/v1/community")).toBe(true);
    expect(isCacheable("POST", "/v1/community")).toBe(false);
    expect(isCacheable("DELETE", "/v1/community")).toBe(false);
    expect(isCacheable("GET", STREAM_PATH)).toBe(false);
  });
});
