/**
 * Coverage for the member-open notification surface.
 *
 * Two things here are easy to get wrong and fail silently, so they are pinned
 * by tests: the settings are scoped to the API key's OWNING MANAGER rather than
 * to the community, and a quiet-hours window MAY wrap past midnight — the exact
 * opposite of recurring hold opens and key schedules.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const SETTINGS = {
  result: "ok",
  enabled: true,
  feature_available: true,
  quiet_hours: [
    {
      quiet_hours_id: 41,
      days_of_the_week: "MTWHF",
      start_time: "22:00",
      end_time: "06:00",
    },
  ],
  request_id: "r1",
};

describe("my notification settings", () => {
  it("myNotificationSettings() reads this key owner's own settings", async () => {
    const { client: c, calls } = client({ body: SETTINGS });

    const result = await c.community.myNotificationSettings();

    expect(calls[0]!.url).toContain("/v1/community/my-notification-settings");
    expect(calls[0]!.method).toBe("GET");
    expect(result.enabled).toBe(true);
    expect(result.featureAvailable).toBe(true);
    expect(result.quietHours).toHaveLength(1);
    expect(result.quietHours[0]!.quietHoursId).toBe(41);
    expect(result.quietHours[0]!.daysOfTheWeek).toBe("MTWHF");
  });

  it("a wrapping window survives parsing as ONE window", async () => {
    // 22:00 -> 06:00 is a single quiet-hours window, not two halves. If a
    // caller re-read it as start > end being invalid they would split it and
    // suppress nothing at the hours they meant.
    const { client: c } = client({ body: SETTINGS });

    const window = (await c.community.myNotificationSettings()).quietHours[0]!;

    expect(window.startTime).toBe("22:00");
    expect(window.endTime).toBe("06:00");
  });

  it("setMyNotificationsEnabled() PUTs the flag and returns the full object", async () => {
    // Every write returns the whole settings object, so nothing needs a
    // follow-up GET.
    const { client: c, calls } = client({ body: { ...SETTINGS, enabled: false } });

    const result = await c.community.setMyNotificationsEnabled(false);

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual({ enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.quietHours).toHaveLength(1);
  });

  it("a write is refused when the community disallows the feature", async () => {
    const { client: c } = client({
      status: 403,
      body: {
        error: {
          code: "open_notifications_disabled",
          message: "Member-open notifications are not enabled for this community",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.setMyNotificationsEnabled(true),
    ).rejects.toMatchObject({ code: "open_notifications_disabled", status: 403 });
  });

  it("addQuietHours() posts a window that wraps past midnight unchanged", async () => {
    // The SDK must not "helpfully" split or reorder this: quiet hours wrap,
    // and days_of_the_week names the day the window STARTS on.
    const { client: c, calls } = client({ body: SETTINGS });

    await c.community.addQuietHours("MTWHF", {
      startTime: "22:00",
      endTime: "06:00",
    });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/my-notification-settings/quiet-hours");
    expect(calls[0]!.body).toEqual({
      days_of_the_week: "MTWHF",
      start_time: "22:00",
      end_time: "06:00",
    });
  });

  it("omitting both times posts days alone — an all-day window", async () => {
    const { client: c, calls } = client({ body: SETTINGS });

    await c.community.addQuietHours("SU");

    expect(calls[0]!.body).toEqual({ days_of_the_week: "SU" });
  });

  it("one time given sends both, so a half-open window never reaches the server", async () => {
    const { client: c, calls } = client({ body: SETTINGS });

    await c.community.addQuietHours("MTWHF", { startTime: "22:00" });

    expect(calls[0]!.body).toEqual({
      days_of_the_week: "MTWHF",
      start_time: "22:00",
      end_time: null,
    });
  });

  it("passes 24:00 through so the server's rejection reaches the caller", async () => {
    // "24:00" is a key-schedule/hold-open idiom and is NOT accepted here. A
    // developer carrying it across must see the 422, not have it rewritten.
    const { client: c, calls } = client({
      status: 422,
      body: {
        error: {
          code: "invalid_time",
          message: "end_time must be 'HH:MM' between 00:00 and 23:59",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.addQuietHours("MTWHF", { startTime: "22:00", endTime: "24:00" }),
    ).rejects.toMatchObject({ code: "invalid_time", status: 422 });
    expect(calls[0]!.body).toMatchObject({ end_time: "24:00" });
  });

  it("a zero-length window is refused with invalid_time", async () => {
    const { client: c } = client({
      status: 422,
      body: {
        error: {
          code: "invalid_time",
          message: "start_time and end_time must differ",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.addQuietHours("MTWHF", { startTime: "22:00", endTime: "22:00" }),
    ).rejects.toMatchObject({ code: "invalid_time" });
  });

  it("bad day letters surface as invalid_days", async () => {
    const { client: c } = client({
      status: 422,
      body: {
        error: {
          code: "invalid_days",
          message:
            "Invalid day 'X' in days_of_the_week — use letters from MTWHFSU",
          request_id: "r1",
        },
      },
    });

    await expect(c.community.addQuietHours("XYZ")).rejects.toThrow(/MTWHFSU/);
  });

  it("removeQuietHours() deletes one window and returns what is left", async () => {
    // Quiet hours are additive: one POST appends one window, one DELETE
    // removes one. Replacing a schedule means deleting what you no longer want.
    const { client: c, calls } = client({
      body: { ...SETTINGS, quiet_hours: [] },
    });

    const result = await c.community.removeQuietHours(41);

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain(
      "/v1/community/my-notification-settings/quiet-hours/41",
    );
    expect(result.quietHours).toEqual([]);
  });

  it("another manager's window id is a 404 that deletes nothing", async () => {
    // Including another manager of the SAME community: the API deliberately
    // does not distinguish "not yours" from "does not exist".
    const { client: c } = client({
      status: 404,
      body: {
        error: {
          code: "quiet_hours_not_found",
          message: "Quiet-hours window not found for this community manager",
          request_id: "r1",
        },
      },
    });

    await expect(c.community.removeQuietHours(999)).rejects.toMatchObject({
      code: "quiet_hours_not_found",
      status: 404,
    });
  });

  it("encodes a string window id in the path", async () => {
    const { client: c, calls } = client({ body: SETTINGS });
    await c.community.removeQuietHours("a/b");
    expect(calls[0]!.url).toContain("/quiet-hours/a%2Fb");
  });

  it("a test-mode write validates and never saves", async () => {
    const { client: c } = client({ body: { ...SETTINGS, result: "simulated" } });

    const result = await c.community.addQuietHours("MTWHF", {
      startTime: "22:00",
      endTime: "06:00",
    });

    expect(result.result).toBe("simulated");
    expect(result.simulated).toBe(true);
  });

  it("tolerates a malformed payload without throwing", async () => {
    const { client: c } = client({ body: { quiet_hours: "nope" } });

    const result = await c.community.myNotificationSettings();

    expect(result.enabled).toBe(false);
    expect(result.featureAvailable).toBe(false);
    expect(result.quietHours).toEqual([]);
  });

  it("keeps a non-numeric window id usable rather than nulling it", async () => {
    const { client: c } = client({
      body: { ...SETTINGS, quiet_hours: [{ quiet_hours_id: "q41" }] },
    });

    const window = (await c.community.myNotificationSettings()).quietHours[0]!;

    expect(window.quietHoursId).toBe("q41");
    expect(window.daysOfTheWeek).toBe("");
    expect(window.startTime).toBeNull();
  });
});
