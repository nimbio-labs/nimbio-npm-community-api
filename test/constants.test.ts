/**
 * The shipped vocabularies: they must match the server's lists exactly, and
 * they must stay open — an unknown value is never rejected.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_CODE_MODES,
  ACCOUNT_KEY_CAPABILITIES,
  CAPABILITIES,
  CHANGE_LOG_TYPES,
  GEOFENCE_MODES,
  KEY_USAGE_REPORT_TYPES,
  STREAM_EVENT_TYPES,
  hasCapability,
  NimbioClient,
} from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

describe("CAPABILITIES", () => {
  it("is the API's 22 append-only capability names", () => {
    expect(CAPABILITIES).toEqual([
      "open", "gate_status", "key_statuses", "hold_opens", "webhooks",
      "members", "messages", "access_logs", "key_schedules", "key_usage",
      "change_logs", "homes", "short_codes", "guest_view_entry", "access_codes",
      "guest_links", "map", "open_notifications", "settings", "sense_lines",
      "nfc_tags", "access_code_mode",
    ]);
    expect(CAPABILITIES).toHaveLength(22);
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
  });
});

describe("ACCOUNT_KEY_CAPABILITIES", () => {
  it("is just `open`, and a subset of the community set", () => {
    expect(ACCOUNT_KEY_CAPABILITIES).toEqual(["open"]);
    expect(Object.isFrozen(ACCOUNT_KEY_CAPABILITIES)).toBe(true);
    for (const cap of ACCOUNT_KEY_CAPABILITIES) {
      expect(CAPABILITIES).toContain(cap);
    }
  });

  it("works with hasCapability like any other list", () => {
    expect(hasCapability(ACCOUNT_KEY_CAPABILITIES, "open")).toBe(true);
    expect(hasCapability(ACCOUNT_KEY_CAPABILITIES, "webhooks")).toBe(false);
  });
});

describe("STREAM_EVENT_TYPES", () => {
  it("mirrors the API's ten event types", () => {
    expect(STREAM_EVENT_TYPES).toEqual([
      "sense_line.changed", "open.succeeded", "open.failed", "device.online",
      "device.offline", "hold_open.changed", "member.requested",
      "member.approved", "member.removed", "directory.call",
    ]);
    expect(STREAM_EVENT_TYPES).toHaveLength(10);
    expect(Object.isFrozen(STREAM_EVENT_TYPES)).toBe(true);
  });
});

describe("hasCapability()", () => {
  it("reads a bare capability list", () => {
    expect(hasCapability(["open", "webhooks"], "webhooks")).toBe(true);
    expect(hasCapability(["open"], "hold_opens")).toBe(false);
  });

  it("reads the key info from me()", async () => {
    const mf = mockFetch({
      body: { account_id: "a1", key: { api_key_id: "k1", type: "community",
              capabilities: ["open", "hold_opens", "webhooks"] } },
    });
    const c = new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl });
    const me = await c.me();
    expect(hasCapability(me.key, "hold_opens")).toBe(true);
    expect(hasCapability(me.key, "nfc_tags")).toBe(false);
  });

  it("never rejects a capability this client predates", () => {
    // A newer server may grant something not in CAPABILITIES; it must simply
    // read as present, not throw.
    expect(hasCapability(["open", "future_thing"], "future_thing")).toBe(true);
    expect(hasCapability([], "future_thing")).toBe(false);
  });
});

describe("GEOFENCE_MODES", () => {
  it("is the closed pair the geofence PATCH accepts", () => {
    expect(GEOFENCE_MODES).toEqual(["prompt", "auto_open"]);
  });

  it("is frozen, so a caller cannot mutate the shipped vocabulary", () => {
    expect(Object.isFrozen(GEOFENCE_MODES)).toBe(true);
  });
});

describe("ACCESS_CODE_MODES", () => {
  it("is the closed pair the access-code mode PUT accepts", () => {
    expect(ACCESS_CODE_MODES).toEqual(["per_member", "single_entry"]);
  });

  it("is frozen, so a caller cannot mutate the shipped vocabulary", () => {
    expect(Object.isFrozen(ACCESS_CODE_MODES)).toBe(true);
  });
});

describe("CHANGE_LOG_TYPES", () => {
  it("is the four configuration trails changeLogs() can read", () => {
    expect(CHANGE_LOG_TYPES).toEqual([
      "hold_open",
      "key_schedule",
      "guest_view",
      "guest_link",
    ]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(CHANGE_LOG_TYPES)).toBe(true);
  });
});

describe("KEY_USAGE_REPORT_TYPES", () => {
  it("is the two attribution rules keyUsage() can report", () => {
    expect(KEY_USAGE_REPORT_TYPES).toEqual(["commercial", "residential"]);
  });

  it("is frozen, and open: it describes a response, never a request", () => {
    // The server picks the rule from the community's property type — there is
    // no parameter for it — so an unrecognized rule from a newer server must
    // still read as a value, not an error.
    expect(Object.isFrozen(KEY_USAGE_REPORT_TYPES)).toBe(true);
    const rule: (typeof KEY_USAGE_REPORT_TYPES)[number] | string = "future_rule";
    expect(KEY_USAGE_REPORT_TYPES).not.toContain(rule);
  });
});
