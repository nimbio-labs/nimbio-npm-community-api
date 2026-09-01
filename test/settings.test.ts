/**
 * Coverage for the community-settings surface: the read's feature-discovery
 * block, the camelCase -> snake_case patch shape, and the two rules that make
 * the patch safe to reason about — it is all-or-nothing, and an unknown key is
 * rejected rather than dropped.
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
  community_id: 2585,
  settings: {
    allow_directory_viewing: true,
    allow_directory_access_codes: false,
    is_new_member_request_home_enabled: true,
    limited_use_links_members_only: false,
    limited_use_links_require_account: true,
    event_keys_require_account: false,
    event_keys_override: "inherit",
    member_terminology_option_id: null,
    member_term_custom: "Tenant",
    member_term_custom_plural: "Tenants",
    member_icon: "person",
    home_terminology_option_id: 12,
    home_term_custom: null,
    home_term_custom_plural: null,
    home_icon: null,
  },
  read_only: {
    allow_hold_opens: true,
    is_open_log_history_enabled: false,
    allow_guest_view_entry: false,
    event_keys_enabled: true,
    community_type: 3,
    access_code_mode: "per_member",
  },
  terminology: {
    member: { singular: "Tenant", plural: "Tenants", icon: "person" },
    home: { singular: "Suite", plural: "Suites", icon: "home" },
  },
  terminology_options: {
    member: [
      {
        terminology_option_id: 7,
        label_singular: "Resident",
        label_plural: "Residents",
        icon: "person",
      },
    ],
    home: [
      {
        terminology_option_id: 12,
        label_singular: "Suite",
        label_plural: "Suites",
        icon: "home",
      },
    ],
  },
};

describe("community settings", () => {
  it("settings() reads the configuration and camel-cases it", async () => {
    const { client: c, calls } = client({ body: SETTINGS });

    const result = await c.community.settings();

    expect(calls[0]!.url).toContain("/v1/community/settings");
    expect(calls[0]!.method).toBe("GET");
    expect(result.communityId).toBe(2585);
    expect(result.settings.allowDirectoryViewing).toBe(true);
    expect(result.settings.eventKeysOverride).toBe("inherit");
    expect(result.settings.memberTermCustomPlural).toBe("Tenants");
    expect(result.settings.homeTerminologyOptionId).toBe(12);
    expect(result.terminology.member.singular).toBe("Tenant");
    expect(result.terminologyOptions.home[0]!.terminologyOptionId).toBe(12);
    // A read applied nothing.
    expect(result.changed).toEqual([]);
  });

  it("read_only is feature discovery — the flags that gate other endpoints", async () => {
    // Without this block the only way to learn access-log history is off is to
    // call accessLog() and take a 403, so each flag has to survive parsing.
    const { client: c } = client({ body: SETTINGS });

    const { readOnly } = await c.community.settings();

    expect(readOnly.allowHoldOpens).toBe(true);
    expect(readOnly.isOpenLogHistoryEnabled).toBe(false);
    expect(readOnly.allowGuestViewEntry).toBe(false);
    // The RESOLVED answer, not the settable override.
    expect(readOnly.eventKeysEnabled).toBe(true);
    expect(readOnly.communityType).toBe(3);
    // Read-only HERE: the one flag an API key can change, but only through
    // setAccessCodeMode(), because flipping it deletes every access code.
    expect(readOnly.accessCodeMode).toBe("per_member");
  });

  it("updateSettings() PATCHes camelCase keys as snake_case under `settings`", async () => {
    const { client: c, calls } = client({
      body: { ...SETTINGS, changed: ["allow_directory_viewing"], request_id: "r1" },
    });

    const result = await c.community.updateSettings({
      allowDirectoryViewing: true,
      eventKeysOverride: "deny",
      memberTermCustom: "Tenant",
      memberTerminologyOptionId: null,
    });

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({
      settings: {
        allow_directory_viewing: true,
        event_keys_override: "deny",
        member_term_custom: "Tenant",
        member_terminology_option_id: null,
      },
    });
    expect(result.changed).toEqual(["allow_directory_viewing"]);
    expect(result.requestId).toBe("r1");
  });

  it("forwards an unknown key verbatim so the server can reject it", async () => {
    // The API rejects an unknown setting with 422 invalid_setting naming it.
    // Dropping it here would turn that loud rejection into a write that
    // reports success and changes nothing.
    const { client: c, calls } = client({
      status: 422,
      body: {
        error: {
          code: "invalid_setting",
          message: "Unknown setting 'allowEverything'. Settable: …",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.updateSettings({ allowDirectoryViewing: true, allowEverything: true }),
    ).rejects.toMatchObject({ code: "invalid_setting", status: 422 });

    // The whole patch is validated before anything is written, so the good key
    // travelled with the bad one and NOTHING was applied.
    expect(calls[0]!.body).toEqual({
      settings: { allow_directory_viewing: true, allowEverything: true },
    });
  });

  it("lets a snake_case key from the REST docs through unchanged", async () => {
    const { client: c, calls } = client({ body: SETTINGS });

    await c.community.updateSettings({ allow_directory_access_codes: true });

    expect(calls[0]!.body).toEqual({
      settings: { allow_directory_access_codes: true },
    });
  });

  it("surfaces a read-only setting as invalid_setting, not a silent no-op", async () => {
    // allow_hold_opens and the per-community caps are Nimbio provisioning
    // decisions; the caller needs the "contact support" message, not silence.
    const { client: c } = client({
      status: 422,
      body: {
        error: {
          code: "invalid_setting",
          message:
            "'allow_hold_opens' is not settable via the API — it is enabled by " +
            "Nimbio for your community (contact support)",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.updateSettings({ allow_hold_opens: true }),
    ).rejects.toThrow(/contact support/);
  });

  it("a test-mode patch reports simulated with the settings unchanged", async () => {
    const { client: c } = client({
      body: { ...SETTINGS, result: "simulated", changed: [], request_id: "r1" },
    });

    const result = await c.community.updateSettings({ allowDirectoryViewing: false });

    expect(result.result).toBe("simulated");
    expect(result.simulated).toBe(true);
    expect(result.settings.allowDirectoryViewing).toBe(true);
    expect(result.changed).toEqual([]);
  });

  it("tolerates a malformed payload without throwing", async () => {
    const { client: c } = client({ body: { settings: "nope", changed: [1, "ok"] } });

    const result = await c.community.settings();

    expect(result.settings.allowDirectoryViewing).toBe(false);
    expect(result.readOnly.allowHoldOpens).toBe(false);
    expect(result.terminology.member.singular).toBeNull();
    expect(result.terminologyOptions.member).toEqual([]);
    // Non-string entries are dropped rather than poisoning the list.
    expect(result.changed).toEqual(["ok"]);
  });
});
