/**
 * Coverage for the community description, the paged roster, the message log,
 * key updates, member approval, and the bulk writes.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const MEMBER_ROW = {
  id: "a1",
  is_home: false,
  account_community_id: 4021,
  first_name: "Dana",
  last_name: "Lee",
  phone_numbers: ["+1 555-123-4567"],
  keys: [{ key_name: "Front Gate Key", key_id: "k1", disabled: false }],
  accepted: true,
  subkey_count: 1,
  created_datetime: "2026-01-14",
};

describe("community.info()", () => {
  it("parses identity, features, latches and counts", async () => {
    const { client: c, calls } = client({
      body: {
        community_id: 2585,
        community_uuid: "6f1c2a80",
        name: "Sunset Ridge",
        active: true,
        property_type: { id: 2, name: "Commercial" },
        number_of_units: 120,
        timezone: "America/Los_Angeles",
        timezones: ["America/Los_Angeles"],
        features: {
          hold_opens: true, access_log_history: true, directory_viewing: false,
          directory_access_codes: false, guest_view_entry: false, subkeys: true,
          member_open_notifications: true, event_keys: false,
        },
        latches: [
          { latch_id: "l1", latch_name: "Main Entrance", offline: false,
            timezone: "America/Los_Angeles", box_id: "b1", box_name: "Front Gate Box" },
        ],
        terminology: { member: { singular: "Tenant", plural: "Tenants" } },
        counts: { latches: 2, keys: 1, homes: 40, members_accepted: 87,
                  members_pending: 3, members_removed: 12 },
      },
    });
    const info = await c.community.info();
    expect(calls[0]!.url).toBe("https://api.nimbio.com/v1/community");
    expect(info.communityId).toBe(2585);
    expect(info.features.holdOpens).toBe(true);
    expect(info.features.eventKeys).toBe(false);
    expect(info.latches[0]!.latchId).toBe("l1");
    expect(info.latches[0]!.timezone).toBe("America/Los_Angeles");
    expect(info.counts.membersAccepted).toBe(87);
    expect(info.terminology.member).toEqual({ singular: "Tenant", plural: "Tenants" });
    expect(info.raw.community_uuid).toBe("6f1c2a80");
  });

  it("tolerates a multi-site community with no agreed timezone", async () => {
    const { client: c } = client({
      body: { name: "Two Sites", timezone: null,
              timezones: ["America/Los_Angeles", "America/Denver"] },
    });
    const info = await c.community.info();
    expect(info.timezone).toBeNull();
    expect(info.timezones).toHaveLength(2);
    expect(info.features.holdOpens).toBe(false); // absent -> false, never throws
    expect(info.latches).toEqual([]);
  });
});

describe("community.membersPage()", () => {
  it("sends the defaults and parses the page", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", bucket: "accepted", page: 1, size: 100, total: 137,
              has_more: true, members: [MEMBER_ROW] },
    });
    const page = await c.community.membersPage();
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/page?bucket=accepted&page=1&size=100");
    expect(page.total).toBe(137);
    expect(page.hasMore).toBe(true);
    const member = page.members[0]!;
    expect(member.fullName).toBe("Dana Lee");
    expect(member.phoneNumbers).toEqual(["+1 555-123-4567"]);
    expect(member.keys[0]!.keyName).toBe("Front Gate Key");
    expect(member.keys[0]!.disabled).toBe(false);
    expect(member.subkeyCount).toBe(1);
  });

  it("passes bucket, paging and search through", async () => {
    const { client: c, calls } = client({ body: { result: "ok", members: [] } });
    await c.community.membersPage({
      bucket: "unaccepted", page: 3, size: 25, search: "555-1234",
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("bucket")).toBe("unaccepted");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("size")).toBe("25");
    expect(url.searchParams.get("search")).toBe("555-1234");
  });

  it("reads a home row as a home, not a person", async () => {
    const { client: c } = client({
      body: {
        result: "ok", bucket: "accepted",
        members: [{ id: "h1", is_home: true, home_address: "12 Elm St",
                    members: [4021, 4022], member_names: ["Dana Lee", "Sam Ito"],
                    accepted: true, created_datetime: "2026-01-02" }],
      },
    });
    const home = (await c.community.membersPage()).members[0]!;
    expect(home.isHome).toBe(true);
    expect(home.homeAddress).toBe("12 Elm St");
    expect(home.memberIds).toEqual([4021, 4022]);
    expect(home.memberNames).toEqual(["Dana Lee", "Sam Ito"]);
    expect(home.phoneNumbers).toEqual([]);
  });
});

describe("community.member()", () => {
  it("fetches one member by account_community_id", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", bucket: "accepted", status: 1, ...MEMBER_ROW },
    });
    const member = await c.community.member(4021);
    expect(calls[0]!.url).toBe("https://api.nimbio.com/v1/community/members/4021");
    expect(member.bucket).toBe("accepted");
    expect(member.accountCommunityId).toBe(4021);
    expect(member.raw.status).toBe(1);
  });
});

describe("community.messages()", () => {
  it("reads the sent-message log with defaults", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok", limit: 50, offset: 0, has_more: false,
        messages: [{ message_id: 4821, message: "Gate service Thursday.",
                     sender_name: "Dana Lee", sender_account_id: "3f9c",
                     sent_at: "2026-06-09T18:02:00+00:00", community_uuid: "a1b2" }],
      },
    });
    const page = await c.community.messages();
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/messages?limit=50&offset=0");
    expect(calls[0]!.method).toBe("GET");
    expect(page.hasMore).toBe(false);
    expect(page.messages[0]!.messageId).toBe(4821);
    expect(page.messages[0]!.senderName).toBe("Dana Lee");
    expect(page.messages[0]!.sentAt).toBe("2026-06-09T18:02:00+00:00");
  });

  it("passes limit and offset", async () => {
    const { client: c, calls } = client({ body: { result: "ok", messages: [] } });
    await c.community.messages({ limit: 200, offset: 400 });
    expect(calls[0]!.url).toContain("limit=200");
    expect(calls[0]!.url).toContain("offset=400");
  });
});

describe("community.updateKey()", () => {
  it("PATCHes only the fields given and reports the blast radius", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok", request_id: "r1", descendant_key_count: 42,
        key: { id: "k1", name: "Contractor Key (revoked)", disabled: true,
               hidden: false, pending: false, is_favorite: false,
               latches: [{ latch_id: "l9", name: "Front Gate" }] },
      },
    });
    const res = await c.community.updateKey("k1", { disabled: true });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.nimbio.com/v1/community/keys/k1");
    expect(calls[0]!.body).toEqual({ disabled: true }); // name untouched
    expect(res.descendantKeyCount).toBe(42);
    expect(res.key!.disabled).toBe(true);
    expect(res.simulated).toBe(false);
  });

  it("sends both fields when both are given", async () => {
    const { client: c, calls } = client({ body: { result: "ok" } });
    await c.community.updateKey("k1", { name: "Pool Key", disabled: false });
    expect(calls[0]!.body).toEqual({ name: "Pool Key", disabled: false });
  });

  it("surfaces a test-mode simulation with wouldSet", async () => {
    const { client: c } = client({
      body: { result: "simulated", key_id: "k1", request_id: "r1",
              would_set: { disabled: true } },
    });
    const res = await c.community.updateKey("k1", { disabled: true });
    expect(res.simulated).toBe(true);
    expect(res.key).toBeNull();
    expect(res.wouldSet).toEqual({ disabled: true });
  });
});

describe("community.approveMember()", () => {
  it("posts the key ids and optional move-out date", async () => {
    const { client: c, calls } = client({
      body: { result: "member_approved", request_id: "r1",
              account_community_id: 4021, account_id: "a1",
              keys: [{ key_id: "k1" }] },
    });
    const res = await c.community.approveMember(4021, ["k1"], {
      moveOutDate: "2027-01-31",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/4021/approve");
    expect(calls[0]!.body).toEqual({ key_ids: ["k1"], move_out_date: "2027-01-31" });
    expect(res.result).toBe("member_approved");
    expect(res.raw.account_id).toBe("a1");
  });

  it("omits move_out_date and dry_run unless asked", async () => {
    const { client: c, calls } = client({ body: { result: "member_approved" } });
    await c.community.approveMember(4021, ["k1"]);
    expect(calls[0]!.body).toEqual({ key_ids: ["k1"] });
  });

  it("sends dry_run when requested", async () => {
    const { client: c, calls } = client({ body: { result: "simulated" } });
    const res = await c.community.approveMember(4021, ["k1"], { dryRun: true });
    expect(calls[0]!.body).toEqual({ key_ids: ["k1"], dry_run: true });
    expect(res.simulated).toBe(true);
  });

  it("raises ConflictError when the member is already accepted", async () => {
    const { client: c } = client({
      status: 409,
      body: { error: { code: "already_accepted", request_id: "r1",
                       message: "Member is already an accepted member" } },
    });
    await expect(c.community.approveMember(4021, ["k1"])).rejects.toThrow(
      ConflictError);
    await expect(c.community.approveMember(4021, ["k1"])).rejects.toMatchObject({
      status: 409, code: "already_accepted",
    });
  });
});

describe("bulk writes", () => {
  const BULK_GRANT_BODY = {
    result: "batch_processed", request_id: "r1", simulated: false,
    summary: { total: 3, succeeded: 2, failed: 1 },
    results: [
      { index: 0, account_community_id: 4021, ok: true,
        granted: { created: ["k1"], enabled: [], exists: [] } },
      { index: 1, account_community_id: 4022, ok: true,
        granted: { created: [], enabled: [], exists: ["k2"] } },
      { index: 2, account_community_id: 4023, ok: false,
        code: "member_not_accepted", message: "Member is not an accepted member" },
    ],
  };

  it("bulkGrantKeys() maps items to the wire shape and collects failures", async () => {
    const { client: c, calls } = client({ status: 207, body: BULK_GRANT_BODY });
    const res = await c.community.bulkGrantKeys([
      { accountCommunityId: 4021, keyIds: ["k1"] },
      { accountCommunityId: 4022, keyIds: ["k2"] },
      { accountCommunityId: 4023, keyIds: ["k1"] },
    ]);
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/keys/bulk-grant");
    expect(calls[0]!.body).toEqual({
      items: [
        { account_community_id: 4021, key_ids: ["k1"] },
        { account_community_id: 4022, key_ids: ["k2"] },
        { account_community_id: 4023, key_ids: ["k1"] },
      ],
    });
    expect(res.total).toBe(3);
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.results).toHaveLength(3);
    // A 207 does not mean every item worked.
    expect(res.failures.map((f) => f.index)).toEqual([2]);
    expect(res.failures[0]!.code).toBe("member_not_accepted");
    expect(res.results[0]!.raw.granted).toEqual({ created: ["k1"], enabled: [], exists: [] });
  });

  it("bulkRevokeKeys() posts to the revoke path", async () => {
    const { client: c, calls } = client({
      status: 207,
      body: { result: "batch_processed", summary: { total: 1, succeeded: 1, failed: 0 },
              results: [{ index: 0, account_community_id: 4021, ok: true,
                          revoked_key_ids: ["s1"],
                          already_revoked_community_key_ids: [] }] },
    });
    const res = await c.community.bulkRevokeKeys([
      { accountCommunityId: 4021, keyIds: ["k1"] },
    ]);
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/keys/bulk-revoke");
    expect(res.failures).toEqual([]);
    expect(res.results[0]!.raw.revoked_key_ids).toEqual(["s1"]);
  });

  it("bulkSetKeysDisabled() sends the batch-wide disabled flag", async () => {
    const { client: c, calls } = client({
      status: 207,
      body: { result: "batch_processed", summary: { total: 1, succeeded: 0, failed: 1 },
              results: [{ index: 0, account_community_id: 4022, ok: false,
                          disabled: true, code: "key_not_held",
                          message: "Member does not hold a key" }] },
    });
    const res = await c.community.bulkSetKeysDisabled(
      [{ accountCommunityId: 4022, keyIds: ["k1"] }], true);
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/keys/bulk-disabled");
    expect(calls[0]!.body).toEqual({
      items: [{ account_community_id: 4022, key_ids: ["k1"] }], disabled: true,
    });
    expect(res.failed).toBe(1);
    expect(res.failures[0]!.code).toBe("key_not_held");
  });

  it("bulkAddMembers() maps phone numbers and reports per-item results", async () => {
    const { client: c, calls } = client({
      status: 207,
      body: { result: "batch_processed", request_id: "r1",
              summary: { total: 2, succeeded: 1, failed: 1 },
              results: [
                { index: 0, phone_number: "+15551234567", ok: true,
                  account_community_id: 4021, account_id: "a1" },
                { index: 1, phone_number: "+15557654321", ok: false,
                  code: "already_member", message: "Already a member" },
              ] },
    });
    const res = await c.community.bulkAddMembers([
      { phoneNumber: "+15551234567", keyIds: ["k1"] },
      { phoneNumber: "+15557654321", keyIds: ["k1"] },
    ]);
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/bulk-add");
    expect(calls[0]!.body).toEqual({
      items: [
        { phone_number: "+15551234567", key_ids: ["k1"] },
        { phone_number: "+15557654321", key_ids: ["k1"] },
      ],
    });
    expect(res.results[0]!.phoneNumber).toBe("+15551234567");
    expect(res.failures[0]!.code).toBe("already_member");
  });

  it("reads a test-mode batch as simulated", async () => {
    const { client: c } = client({
      status: 207,
      body: { result: "batch_processed", simulated: true,
              summary: { total: 1, succeeded: 1, failed: 0 },
              results: [{ index: 0, ok: true }] },
    });
    const res = await c.community.bulkGrantKeys([
      { accountCommunityId: 4021, keyIds: ["k1"] },
    ]);
    expect(res.simulated).toBe(true);
  });
});
