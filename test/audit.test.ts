/**
 * Coverage for the two audit/reporting reads: the configuration change log and
 * the key-usage report.
 *
 * Both quietly narrow what you asked for — change logs are pruned at 30 days,
 * and a key-usage window wider than 14 days is clamped rather than rejected —
 * so the tests below pin that the *effective* window is what comes back, and
 * that `reportType` (not a parameter) is what decides how `user` reads.
 */
import { describe, expect, it } from "vitest";
import { CHANGE_LOG_TYPES, KEY_USAGE_REPORT_TYPES, NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const CHANGE_ROW = {
  log_type: "guest_link",
  log_id: 733,
  datetime: "2026-06-06T11:05:55+00:00",
  account_id: "a1b2",
  account_display_name: "Dana Lee",
  action_type: "link_created",
  summary: 'Created event link #733 "Spring Open House" on 2 gate(s)',
  details: { latch_id: "l1", latch_name: "Main Gate" },
};

const USAGE_ROW = {
  datetime: "2026-06-09T11:02:00",
  key_name: "Front Gate",
  latch_name: "Front Gate",
  open_desc: "Open",
  open_result: "Opened",
  reason_desc: "Master",
  source: "Mobile",
  user: "Dana Lee",
  phone: null,
  location: null,
};

describe("configuration change log", () => {
  it("changeLogs() requires a trail and sends the documented defaults", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        log_type: "guest_link",
        logs: [CHANGE_ROW],
        days: 30,
        from: "2026-05-11T17:04:03+00:00",
        to: "2026-06-10T17:04:03+00:00",
        limit: 500,
        offset: 0,
        total: 1,
        has_more: false,
      },
    });

    const page = await c.community.changeLogs("guest_link");

    expect(calls[0]!.url).toContain("/v1/community/change-logs");
    expect(calls[0]!.url).toContain("type=guest_link");
    expect(calls[0]!.url).toContain("days=30");
    expect(calls[0]!.url).toContain("limit=500");
    expect(calls[0]!.url).toContain("offset=0");
    expect(page.logType).toBe("guest_link");
    expect(page.logs[0]!.actionType).toBe("link_created");
    expect(page.logs[0]!.accountDisplayName).toBe("Dana Lee");
    // `details` varies by log type and is kept whole rather than flattened.
    expect(page.logs[0]!.details).toEqual({ latch_id: "l1", latch_name: "Main Gate" });
    expect(page.hasMore).toBe(false);
  });

  it("every documented trail is a legal argument", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", logs: [], days: 30, limit: 500, offset: 0 },
    });

    for (const type of CHANGE_LOG_TYPES) {
      await c.community.changeLogs(type);
    }

    expect(calls.map((call) => new URL(call.url).searchParams.get("type"))).toEqual([
      ...CHANGE_LOG_TYPES,
    ]);
  });

  it("a window past the 30-day retention cap comes back clamped, not refused", async () => {
    // Retention prunes every trail at 30 days, so nothing older is recoverable
    // here — the effective window is what the response reports.
    const { client: c, calls } = client({
      body: {
        result: "ok",
        log_type: "hold_open",
        logs: [],
        days: 30,
        from: "2026-05-11T17:04:03+00:00",
        to: "2026-06-10T17:04:03+00:00",
        limit: 500,
        offset: 0,
      },
    });

    const page = await c.community.changeLogs("hold_open", { days: 365, limit: 50, offset: 100 });

    expect(calls[0]!.url).toContain("days=365");
    expect(calls[0]!.url).toContain("limit=50");
    expect(calls[0]!.url).toContain("offset=100");
    // Asked for a year, got the 30-day cap.
    expect(page.days).toBe(30);
    expect(page.dateFrom).toBe("2026-05-11T17:04:03+00:00");
    expect(page.dateTo).toBe("2026-06-10T17:04:03+00:00");
  });
});

describe("key usage report", () => {
  it("keyUsage() sends the window as given and reports commercial attribution", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        report_type: "commercial",
        page: 0,
        has_more: false,
        from: "2026-06-01",
        to: "2026-06-10",
        requested_from: "2026-06-01",
        requested_to: "2026-06-10",
        clamped: false,
        max_range_days: 14,
        timezone: "America/Los_Angeles",
        logs: [USAGE_ROW],
      },
    });

    const report = await c.community.keyUsage("2026-06-01", "2026-06-10");

    expect(calls[0]!.url).toContain("/v1/community/key-usage");
    expect(calls[0]!.url).toContain("from=2026-06-01");
    expect(calls[0]!.url).toContain("to=2026-06-10");
    expect(calls[0]!.url).toContain("page=0");
    // Commercial: `user` is the actual opener.
    expect(report.reportType).toBe("commercial");
    expect(report.residential).toBe(false);
    expect(KEY_USAGE_REPORT_TYPES).toContain(report.reportType);
    expect(report.logs[0]!.user).toBe("Dana Lee");
    expect(report.clamped).toBe(false);
    // Row datetimes are local to this zone, with no offset attached.
    expect(report.timezone).toBe("America/Los_Angeles");
    expect(report.logs[0]!.datetime).toBe("2026-06-09T11:02:00");
  });

  it("a residential community attributes every open to the account holder", async () => {
    // The server picks the rule from the property type — there is no parameter
    // for it — so `reportType` is the only way to read `user` correctly. This
    // groups by household; it does not anonymize.
    const { client: c } = client({
      body: {
        result: "ok",
        report_type: "residential",
        page: 0,
        has_more: false,
        from: "2026-05-28",
        to: "2026-06-10",
        requested_from: "2026-01-01",
        requested_to: "2026-06-10",
        clamped: true,
        max_range_days: 14,
        timezone: "America/Los_Angeles",
        logs: [
          { ...USAGE_ROW, user: "Dana Lee Keychain", phone: "+15551234567", reason_desc: "Sub Key" },
        ],
      },
    });

    const report = await c.community.keyUsage("2026-01-01", "2026-06-10");

    expect(report.reportType).toBe("residential");
    // The derived accessor is what callers should branch on: a misspelled
    // string comparison here fails silently and misreports who opened a gate.
    expect(report.residential).toBe(true);
    expect(report.logs[0]!.user).toBe("Dana Lee Keychain");
    // A wider request is clamped to the most recent allowed span, not refused.
    expect(report.clamped).toBe(true);
    expect(report.maxRangeDays).toBe(14);
    expect(report.dateFrom).toBe("2026-05-28");
    expect(report.requestedFrom).toBe("2026-01-01");
    // `phone` here is whatever the open recorded — a guest's number, not the
    // account holder's as on accessLog().
    expect(report.logs[0]!.phone).toBe("+15551234567");
  });

  it("keyUsage() pages, and has_more says the page came back full", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        report_type: "commercial",
        page: 2,
        has_more: true,
        from: "2026-06-01",
        to: "2026-06-10",
        logs: [USAGE_ROW],
      },
    });

    const report = await c.community.keyUsage("2026-06-01", "2026-06-10", { page: 2 });

    expect(calls[0]!.url).toContain("page=2");
    expect(report.page).toBe(2);
    expect(report.hasMore).toBe(true);
  });

  it("an inverted window is the server's 422, not a client-side reorder", async () => {
    const { client: c, calls } = client({
      status: 422,
      body: {
        error: {
          code: "invalid_date_range",
          message: "from must be on or before to",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.keyUsage("2026-06-10", "2026-06-01"),
    ).rejects.toMatchObject({ code: "invalid_date_range", status: 422 });
    // Sent exactly as written — silently swapping them would report on a
    // window the caller never asked for.
    expect(calls[0]!.url).toContain("from=2026-06-10");
    expect(calls[0]!.url).toContain("to=2026-06-01");
  });

  it("a community with access-log history switched off is refused", async () => {
    const { client: c } = client({
      status: 403,
      body: {
        error: {
          code: "access_logs_disabled",
          message: "Access Log History is not enabled for this community",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.keyUsage("2026-06-01", "2026-06-10"),
    ).rejects.toMatchObject({ code: "access_logs_disabled", status: 403 });
  });

  it("a rule this client predates reads as not-residential, not as commercial", async () => {
    // `residential` is one-sided on purpose: false means "not the household
    // rule", NOT "the actual opener is named". A caller that needs to tell
    // commercial from something new has to read reportType itself.
    const { client: c } = client({
      body: {
        result: "ok",
        report_type: "future_rule",
        page: 0,
        has_more: false,
        from: "2026-06-01",
        to: "2026-06-10",
        logs: [USAGE_ROW],
      },
    });

    const report = await c.community.keyUsage("2026-06-01", "2026-06-10");

    expect(report.reportType).toBe("future_rule");
    expect(report.residential).toBe(false);
    expect(KEY_USAGE_REPORT_TYPES).not.toContain(report.reportType);
  });
});