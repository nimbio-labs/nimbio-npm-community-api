import { describe, expect, it } from "vitest";
import {
  NimbioClient,
  RateLimitError,
  PermissionDeniedError,
  GateNotOpenedError,
  ServerError,
  UpstreamError,
  APIConnectionError,
  APITimeoutError,
} from "../src/index.js";
import { mockFetch, hangingFetch, failingFetch, TEST_KEY } from "./helpers.js";

describe("retry policy", () => {
  it("retries a 429 (honoring Retry-After) then succeeds", async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 429, headers: { "retry-after": "0" } },
      { body: { account_id: "acct_1", key: {} } },
    ]);
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
    const me = await client.me();
    expect(me.accountId).toBe("acct_1");
    expect(calls).toHaveLength(2);
  });

  it("retries 5xx responses", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { fetchImpl, calls } = mockFetch([
        { status, headers: { "retry-after": "0" } },
        { body: { account_id: "ok", key: {} } },
      ]);
      const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
      await client.me();
      expect(calls).toHaveLength(2);
    }
  });

  it("gives up after maxRetries and throws the mapped error", async () => {
    const { fetchImpl, calls } = mockFetch({
      status: 503,
      headers: { "retry-after": "0" },
      body: { error: { code: "upstream_unavailable", message: "down" } },
    });
    const client = new NimbioClient(TEST_KEY, { maxRetries: 1, fetch: fetchImpl });
    await expect(client.me()).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(2); // original + 1 retry
  });

  it("does not retry when maxRetries is 0", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 500 });
    const client = new NimbioClient(TEST_KEY, { maxRetries: 0, fetch: fetchImpl });
    await expect(client.me()).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a non-retryable 4xx", async () => {
    const { fetchImpl, calls } = mockFetch({
      status: 403,
      body: { error: { code: "open_denied", message: "denied", request_id: "r1" } },
    });
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl });
    await expect(client.community.open("L1")).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(calls).toHaveLength(1);
  });
});

describe("error mapping", () => {
  it("surfaces the error envelope on RateLimitError with retryAfter", async () => {
    const { fetchImpl } = mockFetch({
      status: 429,
      headers: { "retry-after": "3" },
      body: { error: { code: "rate_limited", message: "slow down", request_id: "r9" } },
    });
    const client = new NimbioClient(TEST_KEY, { maxRetries: 0, fetch: fetchImpl });
    await expect(client.me()).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "slow down",
      requestId: "r9",
      retryAfter: 3,
    });
    await expect(client.me()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("maps a 504 to GateNotOpenedError", async () => {
    const { fetchImpl } = mockFetch({
      status: 504,
      body: { error: { code: "did_not_open", message: "gate silent" } },
    });
    const client = new NimbioClient(TEST_KEY, { maxRetries: 0, fetch: fetchImpl });
    await expect(client.community.open("L1")).rejects.toBeInstanceOf(GateNotOpenedError);
  });

  it("preserves a non-JSON error body as the message", async () => {
    const { fetchImpl } = mockFetch({ status: 500, body: "<html>upstream boom</html>" });
    const client = new NimbioClient(TEST_KEY, { maxRetries: 0, fetch: fetchImpl });
    await expect(client.me()).rejects.toMatchObject({
      status: 500,
      message: "<html>upstream boom</html>",
    });
  });

  it("falls back to a generic message when the body has no envelope", async () => {
    const { fetchImpl } = mockFetch({ status: 400, body: {} });
    const client = new NimbioClient(TEST_KEY, { maxRetries: 0, fetch: fetchImpl });
    await expect(client.me()).rejects.toMatchObject({ status: 400, message: "HTTP 400" });
  });
});

describe("transport failures", () => {
  it("wraps a timeout in APITimeoutError", async () => {
    const client = new NimbioClient(TEST_KEY, { fetch: hangingFetch(), timeout: 0.02 });
    await expect(client.me()).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("wraps a connection failure in APIConnectionError", async () => {
    const client = new NimbioClient(TEST_KEY, {
      fetch: failingFetch(new TypeError("fetch failed")),
    });
    await expect(client.me()).rejects.toBeInstanceOf(APIConnectionError);
  });

  it("does not time out when the response is fast", async () => {
    const { fetchImpl } = mockFetch({ body: { account_id: "fast", key: {} } });
    const client = new NimbioClient(TEST_KEY, { fetch: fetchImpl, timeout: 5 });
    expect((await client.me()).accountId).toBe("fast");
  });
});
