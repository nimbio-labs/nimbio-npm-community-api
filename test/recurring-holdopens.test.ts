/**
 * Coverage for recurring hold-open schedules and the per-latch suspend
 * override — the write halves of what `holdOpens()` reports.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient, NotFoundError } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const SCHEDULE = {
  temporal_date_id: "t1", days_of_the_week: "MTWHF", recurring_week: 1,
  start_date: null, end_date: null, active: false,
  temporal_times: [{ temporal_time_id: "tt1", start: "08:00:00", end: "09:00:00" }],
};

describe("community.addHoldOpenRecurring()", () => {
  it("posts days + latch-local times and returns the schedule id", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", latch_id: "l1", temporal_date_id: "t1",
              schedule: SCHEDULE, request_id: "r1" },
    });
    const res = await c.community.addHoldOpenRecurring("l1", "MTWHF", {
      startTime: "08:00", endTime: "09:00",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/latches/l1/hold-open/recurring");
    expect(calls[0]!.body).toEqual({
      days_of_the_week: "MTWHF", start_time: "08:00", end_time: "09:00",
    });
    expect(res.temporalDateId).toBe("t1");
    expect(res.schedule!.daysOfTheWeek).toBe("MTWHF");
    expect(res.schedule!.temporalTimes).toEqual([
      { temporal_time_id: "tt1", start: "08:00:00", end: "09:00:00" },
    ]);
    expect(res.schedule!.active).toBe(false);
  });

  it("sends days alone for an all-day schedule", async () => {
    const { client: c, calls } = client({ body: { result: "ok", schedule: null } });
    const res = await c.community.addHoldOpenRecurring("l1", "SU");
    expect(calls[0]!.body).toEqual({ days_of_the_week: "SU" });
    expect(res.schedule).toBeNull();
  });

  it("accepts a day bitmask and a recurring week", async () => {
    const { client: c, calls } = client({ body: { result: "ok" } });
    await c.community.addHoldOpenRecurring("l1", 31, { recurringWeek: 2 });
    expect(calls[0]!.body).toEqual({ days_of_the_week: 31, recurring_week: 2 });
  });

  it("reports a test-mode add as simulated", async () => {
    const { client: c } = client({
      body: { result: "simulated", latch_id: "l1", request_id: "r1",
              would_add: { days_of_the_week: "MTWHF", start_time: "08:00",
                           end_time: "09:00", recurring_week: 1 } },
    });
    const res = await c.community.addHoldOpenRecurring("l1", "MTWHF", {
      startTime: "08:00", endTime: "09:00",
    });
    expect(res.simulated).toBe(true);
    expect(res.temporalDateId).toBeNull();
    expect(res.wouldSet.days_of_the_week).toBe("MTWHF");
  });

  it("surfaces the hold-opens feature gate as a 403", async () => {
    const { client: c } = client({
      status: 403,
      body: { error: { code: "hold_opens_disabled",
                       message: "Hold opens are not enabled for this community" } },
    });
    await expect(c.community.addHoldOpenRecurring("l1", "M")).rejects.toMatchObject({
      status: 403, code: "hold_opens_disabled",
    });
  });
});

describe("community.updateHoldOpenRecurring()", () => {
  it("PATCHes only the fields sent", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", latch_id: "l1", temporal_date_id: "t1",
              schedule: { ...SCHEDULE, days_of_the_week: "MTWHFS" },
              request_id: "r1" },
    });
    const res = await c.community.updateHoldOpenRecurring("l1", "t1", {
      daysOfTheWeek: "MTWHFS",
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/latches/l1/hold-open/recurring/t1");
    expect(calls[0]!.body).toEqual({ days_of_the_week: "MTWHFS" });
    expect(res.schedule!.daysOfTheWeek).toBe("MTWHFS");
  });

  it("clears the window with clearTimes", async () => {
    const { client: c, calls } = client({ body: { result: "ok" } });
    await c.community.updateHoldOpenRecurring("l1", "t1", { clearTimes: true });
    expect(calls[0]!.body).toEqual({ clear_times: true });
  });

  it("replaces the window when both times are sent", async () => {
    const { client: c, calls } = client({ body: { result: "ok" } });
    await c.community.updateHoldOpenRecurring("l1", "t1", {
      startTime: "07:30", endTime: "24:00", recurringWeek: 1,
    });
    expect(calls[0]!.body).toEqual({
      recurring_week: 1, start_time: "07:30", end_time: "24:00",
    });
  });

  it("raises NotFoundError for a schedule that is not on this latch", async () => {
    const { client: c } = client({
      status: 404,
      body: { error: { code: "unknown_schedule",
                       message: "No such recurring hold open on this latch" } },
    });
    await expect(
      c.community.updateHoldOpenRecurring("l1", "nope", { daysOfTheWeek: "M" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("community.removeHoldOpenRecurring()", () => {
  it("DELETEs the schedule", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", removed: true, latch_id: "l1",
              temporal_date_id: "t1", request_id: "r1" },
    });
    const res = await c.community.removeHoldOpenRecurring("l1", "t1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/latches/l1/hold-open/recurring/t1");
    expect(res.removed).toBe(true);
    expect(res.temporalDateId).toBe("t1");
  });

  it("is deliberately NOT idempotent — a second delete is a 404", async () => {
    const { client: c } = client({
      status: 404,
      body: { error: { code: "unknown_schedule",
                       message: "No such recurring hold open on this latch" } },
    });
    await expect(
      c.community.removeHoldOpenRecurring("l1", "t1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports a test-mode delete as simulated", async () => {
    const { client: c } = client({
      body: { result: "simulated", latch_id: "l1", temporal_date_id: "t1",
              request_id: "r1" },
    });
    const res = await c.community.removeHoldOpenRecurring("l1", "t1");
    expect(res.simulated).toBe(true);
    expect(res.removed).toBe(false);
  });
});

describe("community.setHoldOpenDisabledUntil()", () => {
  it("PUTs a latch-local suspension", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", latch_id: "l1", disabled_until: "2026-12-25 23:59:00",
              held_open: false, request_id: "r1" },
    });
    const res = await c.community.setHoldOpenDisabledUntil("l1", "2026-12-25 23:59");
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/latches/l1/hold-open/disabled-until");
    expect(calls[0]!.body).toEqual({ until: "2026-12-25 23:59" });
    expect(res.disabledUntil).toBe("2026-12-25 23:59:00");
    expect(res.heldOpen).toBe(false);
  });

  it("sends an explicit null to resume", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", latch_id: "l1", disabled_until: null, held_open: true,
              request_id: "r1" },
    });
    const res = await c.community.setHoldOpenDisabledUntil("l1", null);
    expect(calls[0]!.body).toEqual({ until: null });
    expect(res.disabledUntil).toBeNull();
    expect(res.heldOpen).toBe(true);
  });

  it("reports a test-mode call as simulated", async () => {
    const { client: c } = client({
      body: { result: "simulated", would_set: "2026-12-25 23:59", latch_id: "l1",
              request_id: "r1" },
    });
    const res = await c.community.setHoldOpenDisabledUntil("l1", "2026-12-25 23:59");
    expect(res.simulated).toBe(true);
    expect(res.wouldSet).toBe("2026-12-25 23:59");
    expect(res.heldOpen).toBeNull();
  });
});
