/**
 * Coverage for webhook delivery inspection and replay, and for the 409
 * conflicts those endpoints raise.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

describe("community.webhookDeliveries()", () => {
  it("lists attempts newest first with the default limit", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        deliveries: [
          { delivery_id: "d1", event_type: "sense_line.changed", event_id: "e1",
            status: "delivered", attempts: 1, last_status_code: 200,
            last_error: null, next_attempt_datetime: null,
            created_datetime: "2026-08-18T14:03:11+00:00",
            delivered_datetime: "2026-08-18T14:03:12+00:00" },
          { delivery_id: "d2", event_type: "open.succeeded", event_id: "e2",
            status: "failed", attempts: 5, last_status_code: 502,
            last_error: "502 Bad Gateway", next_attempt_datetime: null,
            created_datetime: "2026-08-18T13:59:02+00:00",
            delivered_datetime: null },
        ],
      },
    });
    const deliveries = await c.community.webhookDeliveries("w1");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/webhooks/w1/deliveries?limit=50");
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.status).toBe("delivered");
    expect(deliveries[0]!.deliveredDatetime).toBe("2026-08-18T14:03:12+00:00");
    expect(deliveries[1]!.attempts).toBe(5);
    expect(deliveries[1]!.lastError).toBe("502 Bad Gateway");
    expect(deliveries[1]!.deliveredDatetime).toBeNull();
  });

  it("passes an explicit limit", async () => {
    const { client: c, calls } = client({ body: { result: "ok", deliveries: [] } });
    expect(await c.community.webhookDeliveries("w1", { limit: 200 })).toEqual([]);
    expect(calls[0]!.url).toContain("limit=200");
  });

  it("raises NotFoundError for an unknown webhook", async () => {
    const { client: c } = client({
      status: 404,
      body: { error: { code: "webhook_not_found", message: "Webhook not found" } },
    });
    await expect(c.community.webhookDeliveries("nope")).rejects.toMatchObject({
      status: 404, code: "webhook_not_found",
    });
  });
});

describe("community.replayDelivery()", () => {
  it("returns the new delivery, carrying the ORIGINAL event id", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", delivery_id: "d9", replayed_from_delivery_id: "d2",
              event_id: "e2", event_type: "member.approved", status: "pending",
              created_datetime: "2026-08-18T15:10:00+00:00", request_id: "r1" },
    });
    const res = await c.community.replayDelivery("w1", "d2");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/webhooks/w1/deliveries/d2/replay");
    expect(res.deliveryId).toBe("d9");            // new delivery row
    expect(res.replayedFromDeliveryId).toBe("d2");
    expect(res.eventId).toBe("e2");               // unchanged: the dedupe key
    expect(res.status).toBe("pending");
    expect(res.simulated).toBe(false);
  });

  it("reports a test-mode call as simulated with nothing enqueued", async () => {
    const { client: c } = client({
      body: { result: "simulated", webhook_id: "w1", delivery_id: "d2",
              request_id: "r1" },
    });
    const res = await c.community.replayDelivery("w1", "d2");
    expect(res.simulated).toBe(true);
    expect(res.replayedFromDeliveryId).toBeNull();
  });

  it("raises ConflictError when the delivery is still in flight", async () => {
    const { client: c } = client({
      status: 409,
      body: { error: { code: "delivery_in_flight", request_id: "r1",
                       message: "Nimbio is still retrying that delivery" } },
    });
    const err = await c.community.replayDelivery("w1", "d2").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("delivery_in_flight");
    expect(err.requestId).toBe("r1");
  });

  it("raises ConflictError when the webhook is disabled", async () => {
    const { client: c } = client({
      status: 409,
      body: { error: { code: "webhook_disabled",
                       message: "Webhook is disabled or inactive" } },
    });
    await expect(c.community.replayDelivery("w1", "d2")).rejects.toBeInstanceOf(
      ConflictError);
  });
});

describe("community.retryFailedDeliveries()", () => {
  it("reports what was actually enqueued", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok", webhook_id: "w1", replayed_count: 2, limit: 50,
        skipped_in_flight: 1, skipped_duplicate_event: 0, request_id: "r1",
        replayed: [
          { delivery_id: "d9", replayed_from_delivery_id: "d2", event_id: "e2",
            event_type: "member.approved", status: "pending",
            created_datetime: "2026-08-18T15:10:00+00:00" },
          { delivery_id: "d10", replayed_from_delivery_id: "d3", event_id: "e3",
            event_type: "open.succeeded", status: "pending",
            created_datetime: "2026-08-18T15:10:00.001000+00:00" },
        ],
      },
    });
    const res = await c.community.retryFailedDeliveries("w1");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/webhooks/w1/deliveries/retry-failed?limit=50");
    expect(res.replayedCount).toBe(2);
    expect(res.replayed[0]!.eventId).toBe("e2");
    expect(res.skippedInFlight).toBe(1);
    expect(res.skippedDuplicateEvent).toBe(0);
    expect(res.limit).toBe(50);
  });

  it("passes since and limit", async () => {
    const { client: c, calls } = client({ body: { result: "ok" } });
    await c.community.retryFailedDeliveries("w1", {
      since: "2026-08-18T13:00:00+00:00", limit: 100,
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("since")).toBe("2026-08-18T13:00:00+00:00");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("reports a test-mode call as simulated", async () => {
    const { client: c } = client({
      body: { result: "simulated", webhook_id: "w1", request_id: "r1" },
    });
    const res = await c.community.retryFailedDeliveries("w1");
    expect(res.simulated).toBe(true);
    expect(res.replayed).toEqual([]);
    expect(res.replayedCount).toBeNull();
  });

  it("raises ConflictError on a disabled webhook", async () => {
    const { client: c } = client({
      status: 409,
      body: { error: { code: "webhook_disabled",
                       message: "Re-enable it before replaying" } },
    });
    const err = await c.community.retryFailedDeliveries("w1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe("webhook_disabled");
  });
});
