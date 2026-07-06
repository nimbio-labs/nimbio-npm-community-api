import { describe, expect, it } from "vitest";
import { NimbioClient, VERSION } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

describe("NimbioClient top-level", () => {
  it("sends the bearer token and standard headers", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { account_id: "acct_1", key: {} } });
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
    const me = await client.me();

    expect(me.accountId).toBe("acct_1");
    expect(calls).toHaveLength(1);
    const { url, headers, method } = calls[0]!;
    expect(method).toBe("GET");
    expect(url).toBe("https://api.nimbio.com/v1/me");
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(headers.Accept).toBe("application/json");
    expect(headers["User-Agent"]).toBe(`nimbio-community-api-js/${VERSION}`);
  });

  it("hits the configured environment base URL", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { account_id: "a", key: {} } });
    const client = new NimbioClient(TEST_KEY, { environment: "dev", fetch: fetchImpl });
    await client.me();
    expect(calls[0]!.url).toBe("https://api.nimbio.dev/v1/me");
  });

  it("health() is unauthenticated and never throws on 503", async () => {
    const { fetchImpl, calls } = mockFetch({
      status: 503,
      body: { ok: false, wamp: "disconnected" },
    });
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
    const h = await client.health();

    expect(h.ok).toBe(false);
    expect(h.wamp).toBe("disconnected");
    expect(calls[0]!.url).toBe("https://api.nimbio.com/healthz");
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("health() parses a connected backend", async () => {
    const { fetchImpl } = mockFetch({ body: { ok: true, wamp: "connected" } });
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
    expect((await client.health()).ok).toBe(true);
  });

  it("merges custom default headers", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { account_id: "a", key: {} } });
    const client = new NimbioClient(TEST_KEY, {
      fetch: fetchImpl,
      defaultHeaders: { "X-Trace": "abc" },
    });
    await client.me();
    expect(calls[0]!.headers["X-Trace"]).toBe("abc");
  });

  it("close() is a harmless no-op", () => {
    const { fetchImpl } = mockFetch({ body: {} });
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
    expect(() => client.close()).not.toThrow();
  });
});

describe("community reads", () => {
  it("parses gate status", async () => {
    const { fetchImpl, calls } = mockFetch({
      body: { latches: [{ latch_id: "L1", latch_name: "Front", status: "closed" }] },
    });
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
    const gs = await client.community.gateStatus();

    expect(gs.latches[0]!.latchName).toBe("Front");
    expect(calls[0]!.url).toBe("https://api.nimbio.com/v1/community/gate-status");
  });

  it("parses members, key statuses, and keys", async () => {
    const membersFetch = mockFetch({ body: { accepted: [{ account_community_id: 1 }] } });
    let client = new NimbioClient(TEST_KEY, { fetch: membersFetch.fetchImpl });
    expect((await client.community.members()).accepted).toHaveLength(1);

    const ksFetch = mockFetch({ body: { keys: [{ id: "a" }], hold_opens: {} } });
    client = new NimbioClient(TEST_KEY, { fetch: ksFetch.fetchImpl });
    expect((await client.community.keyStatuses()).keys).toHaveLength(1);

    const keysFetch = mockFetch({ body: { keys: [{ id: "a" }, { id: "b" }] } });
    client = new NimbioClient(TEST_KEY, { fetch: keysFetch.fetchImpl });
    const keys = await client.community.keys();
    expect(keys.map((k) => k.id)).toEqual(["a", "b"]);
    expect(keysFetch.calls[0]!.url).toBe("https://api.nimbio.com/v1/community/keys");
  });
});
