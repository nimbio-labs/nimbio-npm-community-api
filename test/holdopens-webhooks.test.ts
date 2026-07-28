/**
 * Coverage for the hold-open + webhook surface, `/v1/me` capabilities,
 * `possible_statuses`, and the webhook-signature verifier.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import {
  computeSignature,
  constructEvent,
  verifySignature,
  WebhookSignatureError,
} from "../src/webhooks.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

describe("hold opens", () => {
  it("holdOpens() parses per-latch state", async () => {
    const { client: c } = client({
      body: {
        result: "ok",
        hold_opens: {
          l1: {
            latch_id: "l1", latch_name: "Front Gate", held_open: true,
            manual: false, disabled_until: null, events: [{ id: "e1" }],
            recurring: [], timezone: "America/Los_Angeles",
          },
        },
      },
    });
    const ho = await c.community.holdOpens();
    expect(ho.latches.l1!.heldOpen).toBe(true);
    expect(ho.latches.l1!.manual).toBe(false);
    expect(ho.latches.l1!.events).toEqual([{ id: "e1" }]);
  });

  it("setHoldOpen() PUTs the state", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", latch_id: "l1", manual: true, held_open: true,
              request_id: "r1" },
    });
    const res = await c.community.setHoldOpen("l1", true);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/latches/l1/hold-open");
    expect(calls[0]!.body).toEqual({ state: true });
    expect(res.manual).toBe(true);
    expect(res.simulated).toBe(false);
  });

  it("addHoldOpenEvent() / removeHoldOpenEvent() round-trip", async () => {
    const { client: c, calls } = client([
      { body: { result: "ok", event_id: "e9", latch_id: "l1", request_id: "r1" } },
      { body: { result: "ok", removed: true, request_id: "r2" } },
      { body: { result: "ok", removed: false, request_id: "r3" } },
    ]);
    const added = await c.community.addHoldOpenEvent("l1", {
      start: "2026-08-01 09:00", end: "2026-08-01 10:00",
    });
    expect(added.eventId).toBe("e9");
    expect(calls[0]!.body).toEqual({ start: "2026-08-01 09:00", end: "2026-08-01 10:00" });

    const removed = await c.community.removeHoldOpenEvent("l1", "e9");
    expect(removed.removed).toBe(true);
    expect(calls[1]!.method).toBe("DELETE");
    expect(calls[1]!.url).toBe(
      "https://api.nimbio.com/v1/community/latches/l1/hold-open/events/e9");

    const again = await c.community.removeHoldOpenEvent("l1", "e9");
    expect(again.removed).toBe(false); // idempotent re-remove
  });
});

describe("webhooks", () => {
  it("webhookEventTypes() returns the catalog", async () => {
    const { client: c } = client({
      body: { result: "ok", events: ["sense_line.changed", "hold_open.changed"] },
    });
    const events = await c.community.webhookEventTypes();
    expect(events).toContain("hold_open.changed");
  });

  it("createWebhook() posts url + events and surfaces the one-time secret", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok", request_id: "r1",
        webhook: { webhook_id: "w1", url: "https://x/y",
                   events: ["sense_line.changed"], secret: "whsec_abc" },
      },
    });
    const res = await c.community.createWebhook("https://x/y", ["sense_line.changed"], {
      description: "HA",
    });
    expect(calls[0]!.body).toEqual({
      url: "https://x/y", events: ["sense_line.changed"], description: "HA",
    });
    expect(res.webhook!.secret).toBe("whsec_abc");
  });

  it("webhooks() lists without secrets; update/rotate/delete/test round-trip", async () => {
    const { client: c, calls } = client([
      { body: { result: "ok", webhooks: [{ webhook_id: "w1", url: "https://x/y",
                                           events: [], active: true, disabled: false }] } },
      { body: { result: "ok", webhook: { webhook_id: "w1", active: true }, request_id: "r2" } },
      { body: { result: "ok", webhook_id: "w1", secret: "whsec_new", request_id: "r3" } },
      { body: { result: "ok", message: "Test delivery queued", request_id: "r4" } },
      { body: { result: "ok", webhook_id: "w1", request_id: "r5" } },
    ]);
    const listed = await c.community.webhooks();
    expect(listed[0]!.webhookId).toBe("w1");
    expect(listed[0]!.secret).toBeNull();

    const updated = await c.community.updateWebhook("w1", { active: true });
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.body).toEqual({ active: true });
    expect(updated.webhook!.active).toBe(true);

    const rotated = await c.community.rotateWebhookSecret("w1");
    expect(rotated.secret).toBe("whsec_new");

    await c.community.testWebhook("w1");
    expect(calls[3]!.url).toBe("https://api.nimbio.com/v1/community/webhooks/w1/test");

    await c.community.deleteWebhook("w1");
    expect(calls[4]!.method).toBe("DELETE");
  });
});

describe("me() capabilities + possible_statuses", () => {
  it("exposes key type, community id, and capabilities", async () => {
    const { client: c } = client({
      body: {
        account_id: "a1",
        key: { api_key_id: "k1", mode: "test", type: "community",
               community_id: "7",
               capabilities: ["open", "gate_status", "hold_opens", "webhooks"] },
      },
    });
    const me = await c.me();
    expect(me.key.type).toBe("community");
    expect(me.key.capabilities).toContain("hold_opens");
  });

  it("gateStatus() parses possible_statuses", async () => {
    const { client: c } = client({
      body: {
        latches: [{
          latch_id: "l1", latch_name: "Front Gate", status: "Closed",
          offline: false,
          possible_statuses: [{ status: "Open", transient: false },
                              { status: "Closed", transient: false }],
        }],
      },
    });
    const gs = await c.community.gateStatus();
    expect(gs.latches[0]!.possibleStatuses.map((p) => p.status)).toEqual(
      ["Open", "Closed"]);
  });
});

describe("webhook signature verification", () => {
  const secret = "whsec_test";
  const body = '{"event":"hold_open.changed","id":"e1","community_id":7,' +
    '"occurred_at":"2026-07-27T12:00:00+00:00","data":{"held_open":true}}';

  it("round-trips compute + verify", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await computeSignature(secret, ts, body);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(await verifySignature(body, { signature: sig, timestamp: ts, secret }))
      .toBe(true);
    expect(await verifySignature(body + " ", { signature: sig, timestamp: ts, secret }))
      .toBe(false);
    expect(await verifySignature(body, { signature: sig, timestamp: ts,
                                         secret: "whsec_other" })).toBe(false);
  });

  it("enforces the replay tolerance (and can disable it)", async () => {
    const oldTs = (Math.floor(Date.now() / 1000) - 3600).toString();
    const sig = await computeSignature(secret, oldTs, body);
    expect(await verifySignature(body, { signature: sig, timestamp: oldTs, secret }))
      .toBe(false);
    expect(await verifySignature(body, { signature: sig, timestamp: oldTs, secret,
                                         toleranceSeconds: null })).toBe(true);
  });

  it("constructEvent() verifies then decodes the envelope", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await computeSignature(secret, ts, body);
    const event = await constructEvent(body, { signature: sig, timestamp: ts, secret });
    expect(event.event).toBe("hold_open.changed");
    expect(event.communityId).toBe(7);
    expect(event.data.held_open).toBe(true);

    await expect(constructEvent(body, {
      signature: sig, timestamp: ts, secret: "whsec_wrong",
    })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe("account surface", () => {
  it("account.keys() parses nested latches", async () => {
    const { client: c, calls } = client({
      body: { keys: [{ id: "k1", name: "Home", home: "123 Main St",
                       disabled: false, hidden: false, pending: false,
                       parent_name: "Maple Court Master",
                       latches: [{ id: "l1", name: "Front Gate", offline: false,
                                   location: "Entrance", held_open: false }] }] },
    });
    const keys = await c.account.keys();
    expect(keys[0]!.parentName).toBe("Maple Court Master");
    expect(keys[0]!.latches[0]!.name).toBe("Front Gate");
    expect(calls[0]!.url).toBe("https://api.nimbio.com/v1/account/keys");
  });

  it("account.open() targets key + latch", async () => {
    const { client: c, calls } = client({
      body: { result: "simulated", request_id: "r1" },
    });
    const res = await c.account.open("k1", "l1", { note: "hi" });
    expect(res.simulated).toBe(true);
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/account/keys/k1/latches/l1/open");
    expect(calls[0]!.body).toEqual({ note: "hi" });
  });
});

describe("me() legacy usage names", () => {
  it("accepts pre-fix servers that emit calls_this_minute etc.", async () => {
    const { client: c } = client({
      body: {
        account_id: "a1",
        key: { api_key_id: "k1", mode: "test", type: "account",
               calls_this_minute: 2, rate_limit_per_minute: 60,
               calls_this_month: 9, quota_per_month: 1000 },
      },
    });
    const me = await c.me();
    expect(me.key.minuteCount).toBe(2);
    expect(me.key.minuteLimit).toBe(60);
    expect(me.key.monthCount).toBe(9);
    expect(me.key.monthLimit).toBe(1000);
  });
});

describe("webhook verifier edge branches", () => {
  const secret = "whsec_test";

  it("rejects missing/empty signature or timestamp", async () => {
    expect(await verifySignature("{}", { signature: null, timestamp: "1", secret }))
      .toBe(false);
    expect(await verifySignature("{}", { signature: "", timestamp: "1", secret }))
      .toBe(false);
    expect(await verifySignature("{}", { signature: "sha256=x", timestamp: null, secret }))
      .toBe(false);
    expect(await verifySignature("{}", { signature: "sha256=x", timestamp: "", secret }))
      .toBe(false);
  });

  it("rejects a non-numeric timestamp even with a valid MAC", async () => {
    const sig = await computeSignature(secret, "abc", "{}");
    expect(await verifySignature("{}", { signature: sig, timestamp: "abc", secret }))
      .toBe(false);
  });

  it("accepts Uint8Array and ArrayBuffer bodies", async () => {
    const bytes = new TextEncoder().encode('{"event":"ping"}');
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await computeSignature(secret, ts, bytes);
    expect(await verifySignature(bytes, { signature: sig, timestamp: ts, secret }))
      .toBe(true);
    const buf = bytes.buffer.slice(0);
    expect(await verifySignature(buf, { signature: sig, timestamp: ts, secret }))
      .toBe(true);
    const ev = await constructEvent(bytes, { signature: sig, timestamp: ts, secret });
    expect(ev.event).toBe("ping");
    expect(ev.communityId).toBeNull();
    expect(ev.occurredAt).toBeNull();
  });

  it("constructEvent rejects a JSON body that is not an object", async () => {
    const body = "[1,2,3]";
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await computeSignature(secret, ts, body);
    await expect(constructEvent(body, { signature: sig, timestamp: ts, secret }))
      .rejects.toBeInstanceOf(TypeError);
  });

  it("length-mismatched signature fails fast", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    expect(await verifySignature("{}", { signature: "sha256=short", timestamp: ts, secret }))
      .toBe(false);
  });
});
