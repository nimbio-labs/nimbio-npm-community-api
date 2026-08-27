/**
 * Coverage for the GuestView Entry surface.
 *
 * The dangerous call in this family is `setGuestViewEntryLatches()`: it
 * REPLACES the whole eligible set, and every latch left out loses its schedule
 * windows with it. The client must never merge, pad or reorder that list — a
 * caller who sends one id has to see exactly one id go out, because that is the
 * behaviour the docstring warns about and tells them to read-modify-write.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const FRONT = { latch_id: "3f2a", latch_name: "Front Gate" };
const SIDE = { latch_id: "7b1c", latch_name: "Side Gate" };

const SETTINGS = {
  result: "ok",
  guest_view_entry: {
    allowed: true,
    directory_viewing_enabled: true,
    eligible_latches: [FRONT, SIDE],
    schedule: [
      {
        schedule_id: 41,
        latch_id: "3f2a",
        latch_name: "Front Gate",
        days_of_the_week: "MTWHF",
        start_time: "09:00",
        end_time: "17:00",
      },
      {
        schedule_id: 42,
        latch_id: "7b1c",
        latch_name: "Side Gate",
        days_of_the_week: "SU",
        start_time: "10:00",
        end_time: "14:00",
      },
    ],
    schedule_timezone: "latch_local",
  },
};

describe("GuestView Entry", () => {
  it("guestViewEntry() reads the whole configuration", async () => {
    const { client: c, calls } = client({ body: SETTINGS });

    const settings = await c.community.guestViewEntry();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/community/guest-view-entry");
    expect(settings.allowed).toBe(true);
    expect(settings.directoryViewingEnabled).toBe(true);
    expect(settings.eligibleLatches.map((l) => l.latchId)).toEqual(["3f2a", "7b1c"]);
    expect(settings.schedule).toHaveLength(2);
    expect(settings.schedule[0]!.scheduleId).toBe(41);
    expect(settings.schedule[0]!.daysOfTheWeek).toBe("MTWHF");
    // The windows above are read in each LATCH's zone, not the caller's.
    expect(settings.scheduleTimezone).toBe("latch_local");
    expect(settings.createdScheduleIds).toEqual([]);
    expect(settings.removedScheduleId).toBeNull();
  });

  it("setGuestViewEntryEnabled() PUTs an explicit value, not a toggle", async () => {
    // Retryable by construction: a retried toggle would flip guest access back
    // open, which is why the API takes the value rather than flipping it.
    const { client: c, calls } = client({ body: SETTINGS });

    const settings = await c.community.setGuestViewEntryEnabled(false);

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("/v1/community/guest-view-entry");
    expect(calls[0]!.body).toEqual({ allowed: false });
    // The full settings come back, so no follow-up read is needed.
    expect(settings.eligibleLatches).toHaveLength(2);
  });

  it("setGuestViewEntryLatches() REPLACES the set — it sends exactly what it was given", async () => {
    // The footgun: adding one gate by sending a one-element list takes guest
    // eligibility away from every other gate AND deletes their windows. The
    // client must not soften that by merging with anything it has seen.
    const serverAfter = {
      result: "ok",
      request_id: "r1",
      guest_view_entry: {
        ...SETTINGS.guest_view_entry,
        eligible_latches: [SIDE],
        // Front Gate's window 41 went with its eligibility.
        schedule: [SETTINGS.guest_view_entry.schedule[1]],
      },
    };
    const { client: c, calls } = client([{ body: SETTINGS }, { body: serverAfter }]);

    const before = await c.community.guestViewEntry();
    expect(before.eligibleLatches).toHaveLength(2);
    expect(before.schedule.map((w) => w.scheduleId)).toEqual([41, 42]);

    const after = await c.community.setGuestViewEntryLatches(["7b1c"]);

    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toContain("/v1/community/guest-view-entry/eligible-latches");
    // Exactly the one id, nothing merged in from the read above.
    expect(calls[1]!.body).toEqual({ latch_ids: ["7b1c"] });
    // And the omitted gate is gone from BOTH the set and the schedule.
    expect(after.eligibleLatches.map((l) => l.latchId)).toEqual(["7b1c"]);
    expect(after.schedule.map((w) => w.scheduleId)).toEqual([42]);
  });

  it("the read-modify-write recipe keeps the other gates", async () => {
    // What the docstring tells callers to do instead: read the current set and
    // send back a superset of it.
    const { client: c, calls } = client([{ body: SETTINGS }, { body: SETTINGS }]);

    const current = await c.community.guestViewEntry();
    const ids = current.eligibleLatches.map((l) => l.latchId!);
    await c.community.setGuestViewEntryLatches([...ids, "9d3e"]);

    expect(calls[1]!.body).toEqual({ latch_ids: ["3f2a", "7b1c", "9d3e"] });
  });

  it("an empty list removes GuestView Entry from every gate", async () => {
    const { client: c, calls } = client({ body: SETTINGS });

    await c.community.setGuestViewEntryLatches([]);

    expect(calls[0]!.body).toEqual({ latch_ids: [] });
  });

  it("guestViewEntryLogs() omits `success` unless it was given", async () => {
    // Absence means "everything", which is not the same as either boolean —
    // defaulting it either way would silently hide half the history.
    const { client: c, calls } = client({
      body: {
        result: "ok",
        limit: 50,
        offset: 0,
        has_more: false,
        logs: [
          {
            guest_view_entry_log_id: 918,
            account_id: "a1b2",
            first_name: "Dana",
            last_name: "Lee",
            phone: "+15551234567",
            client_ip: "203.0.113.9",
            latch_id: "3f2a",
            latch_name: "Front Gate",
            log_datetime: "2026-08-18T17:04:11+00:00",
            result: "opened",
          },
        ],
      },
    });

    const page = await c.community.guestViewEntryLogs();
    await c.community.guestViewEntryLogs({ success: false, limit: 200 });

    expect(calls[0]!.url).not.toContain("success");
    expect(calls[1]!.url).toContain("success=false");
    expect(calls[1]!.url).toContain("limit=200");
    expect(page.hasMore).toBe(false);
    // Visitor-identifying rows: name, phone and IP all parse.
    expect(page.logs[0]!.fullName).toBe("Dana Lee");
    expect(page.logs[0]!.phone).toBe("+15551234567");
    expect(page.logs[0]!.clientIp).toBe("203.0.113.9");
    expect(page.logs[0]!.result).toBe("opened");
  });

  it("addGuestViewEntrySchedule() applies one window to several latches", async () => {
    const { client: c, calls } = client({
      body: { ...SETTINGS, created_schedule_ids: [41, 43], request_id: "r2" },
    });

    const settings = await c.community.addGuestViewEntrySchedule(
      "MTWHF",
      ["3f2a", "7b1c"],
      { startTime: "09:00", endTime: "17:00" },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/community/guest-view-entry/schedule");
    expect(calls[0]!.body).toEqual({
      days_of_the_week: "MTWHF",
      latch_ids: ["3f2a", "7b1c"],
      start_time: "09:00",
      end_time: "17:00",
    });
    expect(settings.createdScheduleIds).toEqual([41, 43]);
  });

  it("an overnight window is ONE window here — it wraps past midnight", async () => {
    // Same convention as quiet hours, the opposite of recurring hold opens and
    // key schedules, which cannot wrap and use "24:00" as end-of-day. Splitting
    // it in two here permits different hours than the caller meant, silently.
    const { client: c, calls } = client({ body: SETTINGS });

    await c.community.addGuestViewEntrySchedule("F", ["3f2a"], {
      startTime: "22:00",
      endTime: "06:00",
    });

    expect(calls[0]!.body).toEqual({
      days_of_the_week: "F",
      latch_ids: ["3f2a"],
      start_time: "22:00",
      end_time: "06:00",
    });
  });

  it("a null endTime is sent, not dropped — an unbounded end is a real value", async () => {
    const { client: c, calls } = client({ body: SETTINGS });

    await c.community.addGuestViewEntrySchedule("SU", ["3f2a"], {
      startTime: "08:00",
      endTime: null,
    });
    await c.community.addGuestViewEntrySchedule("SU", ["3f2a"]);

    expect(calls[0]!.body).toEqual({
      days_of_the_week: "SU",
      latch_ids: ["3f2a"],
      start_time: "08:00",
      end_time: null,
    });
    // Nothing given, nothing sent: an all-hours window on those days.
    expect(calls[1]!.body).toEqual({ days_of_the_week: "SU", latch_ids: ["3f2a"] });
  });

  it("removeGuestViewEntrySchedule() deletes by id and reports which", async () => {
    // Removing a latch's LAST window widens access to all hours; the schedule
    // is a whitelist, so the settings that come back are worth reading.
    const { client: c, calls } = client({
      body: {
        ...SETTINGS,
        removed_schedule_id: 41,
        guest_view_entry: {
          ...SETTINGS.guest_view_entry,
          schedule: [SETTINGS.guest_view_entry.schedule[1]],
        },
      },
    });

    const settings = await c.community.removeGuestViewEntrySchedule(41);

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/v1/community/guest-view-entry/schedule/41");
    expect(settings.removedScheduleId).toBe(41);
    expect(settings.schedule.map((w) => w.scheduleId)).toEqual([42]);
  });

  it("a simulated write reports rather than applies", async () => {
    const { client: c } = client({
      body: { ...SETTINGS, result: "simulated" },
    });

    const settings = await c.community.setGuestViewEntryLatches(["3f2a"]);

    expect(settings.simulated).toBe(true);
  });
});
