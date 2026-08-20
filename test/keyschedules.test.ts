/**
 * Coverage for the key access-schedule surface: parsing, the whole-schedule
 * replace wire shape, and the distinction between "restricted" and
 * "blocked at all times".
 */
import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const SCHEDULE = {
  key_id: "k1",
  key_name: "Main Gate Key",
  is_temporal_enabled: true,
  restricted: true,
  permanently_blocked: false,
  windows: [
    {
      temporal_date_id: "t1",
      days_of_the_week: "MTWHF",
      start_time: "06:00",
      end_time: "18:00",
    },
  ],
  latch_count: 1,
  latches: [{ latch_id: "l1", name: "Main Gate" }],
  is_community_key: true,
  descendant_key_count: 42,
  inactive_window_count: 0,
  request_id: "r1",
};

describe("key schedules", () => {
  it("keySchedules() parses the list and camel-cases the fields", async () => {
    const { client: c, calls } = client({ body: { keys: [SCHEDULE], request_id: "r1" } });

    const result = await c.community.keySchedules();

    expect(calls[0]!.url).toContain("/v1/community/key-schedules");
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]!.keyId).toBe("k1");
    expect(result.keys[0]!.restricted).toBe(true);
    expect(result.keys[0]!.windows[0]!.daysOfTheWeek).toBe("MTWHF");
    expect(result.keys[0]!.windows[0]!.startTime).toBe("06:00");
    // The blast radius must survive parsing — it is what a caller checks before
    // restricting a community key.
    expect(result.keys[0]!.descendantKeyCount).toBe(42);
  });

  it("blocked collects keys denied at all times", async () => {
    const blocked = {
      ...SCHEDULE,
      key_id: "k2",
      restricted: false,
      permanently_blocked: true,
      is_temporal_enabled: false,
    };
    const { client: c } = client({ body: { keys: [SCHEDULE, blocked] } });

    const result = await c.community.keySchedules();

    expect(result.blocked.map((k) => k.keyId)).toEqual(["k2"]);
  });

  it("keySchedule() reads a single key", async () => {
    const { client: c, calls } = client({ body: SCHEDULE });

    const schedule = await c.community.keySchedule("k1");

    expect(calls[0]!.url).toContain("/v1/community/keys/k1/schedule");
    expect(schedule.keyName).toBe("Main Gate Key");
    expect(schedule.isCommunityKey).toBe(true);
    expect(schedule.latchCount).toBe(1);
  });

  it("encodes the key id in the path", async () => {
    const { client: c, calls } = client({ body: SCHEDULE });
    await c.community.keySchedule("a/b");
    expect(calls[0]!.url).toContain("/v1/community/keys/a%2Fb/schedule");
  });

  it("setKeySchedule() PUTs the whole schedule in snake_case", async () => {
    const { client: c, calls } = client({ body: SCHEDULE });

    await c.community.setKeySchedule("k1", [
      { daysOfTheWeek: "MTWHF", startTime: "06:00", endTime: "18:00" },
    ]);

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual({
      windows: [{ days_of_the_week: "MTWHF", start_time: "06:00", end_time: "18:00" }],
    });
  });

  it("omitted times become null (all day on those days)", async () => {
    const { client: c, calls } = client({ body: SCHEDULE });

    await c.community.setKeySchedule("k1", [{ daysOfTheWeek: "SU" }]);

    expect(calls[0]!.body).toEqual({
      windows: [{ days_of_the_week: "SU", start_time: null, end_time: null }],
    });
  });

  it("an empty array removes every restriction", async () => {
    const { client: c, calls } = client({
      body: { ...SCHEDULE, restricted: false, windows: [] },
    });

    const result = await c.community.setKeySchedule("k1", []);

    expect(calls[0]!.body).toEqual({ windows: [] });
    expect(result.restricted).toBe(false);
    expect(result.windows).toEqual([]);
  });

  it("null/undefined is treated as clearing rather than crashing", async () => {
    const { client: c, calls } = client({ body: { ...SCHEDULE, windows: [] } });
    await c.community.setKeySchedule("k1", null);
    expect(calls[0]!.body).toEqual({ windows: [] });
  });

  it("passes the 24:00 end-of-day sentinel through unchanged", async () => {
    const { client: c, calls } = client({ body: SCHEDULE });

    await c.community.setKeySchedule("k1", [
      { daysOfTheWeek: "MTWHF", startTime: "22:00", endTime: "24:00" },
    ]);

    expect(calls[0]!.body).toEqual({
      windows: [{ days_of_the_week: "MTWHF", start_time: "22:00", end_time: "24:00" }],
    });
  });

  it("a test-mode write reports simulated", async () => {
    const { client: c } = client({
      body: {
        result: "simulated",
        key_id: "k1",
        would_set: "MTWHF 06:00-18:00",
        request_id: "r1",
      },
    });

    const result = await c.community.setKeySchedule("k1", [
      { daysOfTheWeek: "MTWHF", startTime: "06:00", endTime: "18:00" },
    ]);

    expect(result.result).toBe("simulated");
  });

  it("surfaces the overnight rejection as a BadRequestError", async () => {
    const { client: c } = client({
      status: 400,
      body: {
        error: {
          code: "overnight_not_supported",
          message: "Window 1 ends before it starts.",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.setKeySchedule("k1", [
        { daysOfTheWeek: "MTWHF", startTime: "22:00", endTime: "06:00" },
      ]),
    ).rejects.toThrow(/ends before it starts/);
  });

  it("tolerates a malformed payload without throwing", async () => {
    const { client: c } = client({ body: { keys: "not-an-array" } });
    const result = await c.community.keySchedules();
    expect(result.keys).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("surfaces expired windows as a count rather than dropping them silently", async () => {
    // The list returns only what is in force today. A caller seeing an empty
    // `windows` with no other signal would read an expired schedule as "no
    // restriction", so the count has to survive parsing.
    const expired = {
      ...SCHEDULE,
      windows: [],
      restricted: false,
      inactive_window_count: 2,
    };
    const { client: c } = client({ body: { keys: [expired], request_id: "r1" } });

    const rows = (await c.community.keySchedules()).keys;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.windows).toEqual([]);
    expect(rows[0]!.inactiveWindowCount).toBe(2);
  });

  it("refuses a member key with not_a_community_key rather than a generic 403", async () => {
    // Schedules are community-keys-only. The two 403s need different fixes --
    // "schedule the community key instead" versus "that key is someone else's"
    // -- so the specific code must reach the caller.
    const { client: c } = client({
      status: 403,
      body: {
        error: {
          code: "not_a_community_key",
          message:
            "Access schedules are set on the community key, which applies to " +
            "every member beneath it.",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.setKeySchedule("member1", [
        { daysOfTheWeek: "MTWHF", startTime: "06:00", endTime: "18:00" },
      ]),
    ).rejects.toMatchObject({ code: "not_a_community_key" });
  });
});
