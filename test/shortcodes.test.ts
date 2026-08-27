/**
 * Coverage for the GuestView short-code surface.
 *
 * The trap here is that assignment is exclusive and silent: repointing a code
 * detaches whatever gate it pointed at before, and nothing in the response
 * mentions the gate that just lost its code. The test below pins what the call
 * actually sends, so the warning on `assignShortCode()` stays accurate.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const CODE = {
  short_code: "Kp7Rx2Q",
  community_id: 2585,
  latch_id: "l1",
  latch_name: "Main Entrance",
  disabled: false,
  require_security_code: false,
  created_at: "2026-08-18T17:04:11+00:00",
  last_updated_datetime: "2026-08-18T17:04:11+00:00",
};

describe("short codes", () => {
  it("shortCodes() lists the community's codes with their gates", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", short_codes: [CODE, { ...CODE, short_code: "Zz1", latch_id: null }] },
    });

    const codes = await c.community.shortCodes();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/community/short-codes");
    expect(codes).toHaveLength(2);
    expect(codes[0]!.shortCode).toBe("Kp7Rx2Q");
    expect(codes[0]!.latchName).toBe("Main Entrance");
    expect(codes[0]!.requireSecurityCode).toBe(false);
    // Null latch = routes to the directory without preselecting a gate.
    expect(codes[1]!.latchId).toBeNull();
  });

  it("createShortCode() sends nothing when nothing was asked for", async () => {
    // Omitting `code` is the server-generated path, which retries on collision
    // and so effectively never 409s.
    const { client: c, calls } = client({
      body: { result: "ok", request_id: "r1", short_code: CODE },
    });

    const created = await c.community.createShortCode();

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({});
    expect(created.shortCode!.shortCode).toBe("Kp7Rx2Q");
    expect(created.code).toBe("Kp7Rx2Q");
  });

  it("createShortCode() claims a specific code and gate", async () => {
    const { client: c, calls } = client({ body: { result: "ok", short_code: CODE } });

    await c.community.createShortCode({ code: "Kp7Rx2Q", latchId: "l1" });

    expect(calls[0]!.body).toEqual({ code: "Kp7Rx2Q", latch_id: "l1" });
  });

  it("assignShortCode() PUTs the new gate — and detaches the old one", async () => {
    // Exclusive assignment: the code routes to exactly one gate, so this write
    // takes it away from whatever it pointed at, effective for the next visitor
    // who types it. The response names only the new gate.
    const { client: c, calls } = client({
      body: {
        result: "ok",
        request_id: "r2",
        short_code: { ...CODE, latch_id: "l2", latch_name: "Service Entrance" },
      },
    });

    const result = await c.community.assignShortCode("Kp7Rx2Q", "l2");

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("/v1/community/short-codes/Kp7Rx2Q");
    expect(calls[0]!.body).toEqual({ latch_id: "l2" });
    expect(result.shortCode!.latchId).toBe("l2");
    expect(result.shortCode!.latchName).toBe("Service Entrance");
    // Nothing here names the gate that just lost the code.
    expect(result.raw.detached_latch_id).toBeUndefined();
  });

  it("a short code with URL-unsafe characters is encoded into the path", async () => {
    const { client: c, calls } = client({ body: { result: "ok", short_code: CODE } });

    await c.community.assignShortCode("a/b?c", "l2");

    expect(calls[0]!.url).toContain("/v1/community/short-codes/a%2Fb%3Fc");
  });

  it("a simulated assign changes nothing", async () => {
    const { client: c } = client({ body: { result: "simulated", would_set: CODE } });

    const result = await c.community.assignShortCode("Kp7Rx2Q", "l2");

    expect(result.simulated).toBe(true);
    expect(result.code).toBe("Kp7Rx2Q");
  });
});
