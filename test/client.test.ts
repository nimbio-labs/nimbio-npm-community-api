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

  it("sends no integration header when the option is unset", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { account_id: "a", key: {} } });
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
    await client.me();
    expect(calls[0]!.headers["X-Nimbio-Integration"]).toBeUndefined();
    expect(calls[0]!.headers["User-Agent"]).toBe(`nimbio-community-api-js/${VERSION}`);
  });

  it("identifies an integration on authenticated requests", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { account_id: "a", key: {} } });
    const client = new NimbioClient(TEST_KEY, {
      fetch: fetchImpl,
      integration: "homebridge/0.2.0",
    });
    await client.me();
    expect(calls[0]!.headers["X-Nimbio-Integration"]).toBe("homebridge/0.2.0");
    expect(calls[0]!.headers["User-Agent"]).toBe(
      `nimbio-community-api-js/${VERSION} homebridge/0.2.0`,
    );
  });

  it("identifies an integration on unauthenticated requests", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { ok: true, wamp: "connected" } });
    const client = new NimbioClient(TEST_KEY, {
      fetch: fetchImpl,
      integration: "mcp/0.3.0",
    });
    await client.health();
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(calls[0]!.headers["X-Nimbio-Integration"]).toBe("mcp/0.3.0");
    expect(calls[0]!.headers["User-Agent"]).toBe(`nimbio-community-api-js/${VERSION} mcp/0.3.0`);
  });

  it("lets defaultHeaders override the integration headers", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { account_id: "a", key: {} } });
    const client = new NimbioClient(TEST_KEY, {
      fetch: fetchImpl,
      integration: "mcp/0.3.0",
      defaultHeaders: { "X-Nimbio-Integration": "custom/1", "User-Agent": "mine/1" },
    });
    await client.me();
    expect(calls[0]!.headers["X-Nimbio-Integration"]).toBe("custom/1");
    expect(calls[0]!.headers["User-Agent"]).toBe("mine/1");
  });

  it.each(["google_home/1.0.0", "ab/1", "a" + "b".repeat(31) + "/2026.10.0-rc.1+build"])(
    "accepts the well-formed integration %s",
    (integration) => {
      expect(() => new NimbioClient(TEST_KEY, { integration })).not.toThrow();
    },
  );

  it.each([
    "",
    "homebridge", // no version
    "homebridge/", // empty version
    "HomeBridge/1.0", // uppercase slug
    "1home/1.0", // leading digit
    "a/1.0", // slug too short
    "a".repeat(33) + "/1", // slug too long
    "home-bridge/1.0", // hyphen in slug
    "homebridge/1.0 extra", // whitespace
    "homebridge/1.0\r\nX-Evil: 1",
    "x".repeat(20) + "/" + "1".repeat(60), // 81 characters
    123 as unknown as string,
  ])("rejects the malformed integration %j", (integration) => {
    expect(() => new NimbioClient(TEST_KEY, { integration })).toThrow(TypeError);
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
