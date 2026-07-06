import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NimbioClient,
  NimbioConfigError,
  ENVIRONMENTS,
  DEFAULT_ENVIRONMENT,
} from "../src/index.js";
import { mockFetch, TEST_KEY, LIVE_KEY } from "./helpers.js";

const ENV_KEYS = ["NIMBIO_API_KEY", "NIMBIO_ENV", "NIMBIO_BASE_URL"] as const;

describe("configuration", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws NimbioConfigError when no key is provided", () => {
    expect(() => new NimbioClient()).toThrow(NimbioConfigError);
  });

  it("reads the API key from NIMBIO_API_KEY", () => {
    process.env.NIMBIO_API_KEY = TEST_KEY;
    const client = new NimbioClient();
    expect(client.mode).toBe("test");
  });

  it("prefers an explicit key over the environment", () => {
    process.env.NIMBIO_API_KEY = TEST_KEY;
    const client = new NimbioClient(LIVE_KEY);
    expect(client.mode).toBe("live");
  });

  it("defaults to the prod base URL", () => {
    const client = new NimbioClient(TEST_KEY);
    expect(client.baseUrl).toBe(ENVIRONMENTS[DEFAULT_ENVIRONMENT]);
    expect(client.baseUrl).toBe("https://api.nimbio.com");
  });

  it("resolves named environments", () => {
    expect(new NimbioClient(TEST_KEY, { environment: "dev" }).baseUrl).toBe(
      "https://api.nimbio.dev",
    );
    expect(new NimbioClient(TEST_KEY, { environment: "local" }).baseUrl).toBe(
      "http://localhost:8000",
    );
  });

  it("reads the environment from NIMBIO_ENV", () => {
    process.env.NIMBIO_ENV = "dev";
    expect(new NimbioClient(TEST_KEY).baseUrl).toBe("https://api.nimbio.dev");
  });

  it("lets baseUrl override the environment and strips trailing slashes", () => {
    const client = new NimbioClient(TEST_KEY, {
      environment: "prod",
      baseUrl: "http://localhost:9000/",
    });
    expect(client.baseUrl).toBe("http://localhost:9000");
  });

  it("reads NIMBIO_BASE_URL", () => {
    process.env.NIMBIO_BASE_URL = "http://example.test";
    expect(new NimbioClient(TEST_KEY).baseUrl).toBe("http://example.test");
  });

  it("rejects an unknown environment as a config error", () => {
    expect(() => new NimbioClient(TEST_KEY, { environment: "staging" })).toThrow(
      NimbioConfigError,
    );
  });

  it("exposes mode as null for an unrecognized key prefix", () => {
    expect(new NimbioClient("some-other-token").mode).toBeNull();
  });

  it("never leaks the API key in toString()", () => {
    const s = new NimbioClient(TEST_KEY).toString();
    expect(s).not.toContain(TEST_KEY);
    expect(s).toContain("mode=test");
  });

  it("throws a config error when no global fetch and no custom fetch exist", () => {
    const original = globalThis.fetch;
    // @ts-expect-error - intentionally removing the global for this test
    delete globalThis.fetch;
    try {
      expect(() => new NimbioClient(TEST_KEY)).toThrow(NimbioConfigError);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("clamps a negative maxRetries to zero", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 500, headers: { "retry-after": "0" } });
    const client = new NimbioClient(TEST_KEY, { maxRetries: -5, fetch: fetchImpl });
    await expect(client.me()).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
  });
});
