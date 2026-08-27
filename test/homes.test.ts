/**
 * Coverage for the homes/units roster: the include-hidden default, the partial
 * update, the move-out date write, and the one call that reaches beyond its own
 * resource — deleting a home detaches its residents, so the count has to reach
 * the caller.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const HOME = {
  home_id: "h1",
  name: null,
  address: "12 Elm St, Unit 3",
  owner_occupied: false,
  hidden: false,
  home_phone: null,
  home_email: null,
  owner_name: null,
  created_datetime: "2026-08-18T17:04:11+00:00",
  member_count: 2,
};

describe("homes", () => {
  it("homes() includes hidden homes by default — a roster sync wants them all", async () => {
    const { client: c, calls } = client({ body: { result: "ok", homes: [HOME] } });

    const homes = await c.community.homes();

    expect(calls[0]!.url).toContain("/v1/community/homes?include_hidden=true");
    expect(homes).toHaveLength(1);
    expect(homes[0]!.homeId).toBe("h1");
    expect(homes[0]!.address).toBe("12 Elm St, Unit 3");
    expect(homes[0]!.memberCount).toBe(2);
    expect(homes[0]!.hidden).toBe(false);
    // The list read carries counts, not people.
    expect(homes[0]!.members).toEqual([]);
  });

  it("include_hidden false is sent explicitly, never omitted", async () => {
    // The server defaults this parameter to true, so dropping it on `false`
    // would quietly return the hidden homes the caller asked to exclude.
    const { client: c, calls } = client({ body: { homes: [] } });

    await c.community.homes({ includeHidden: false });

    expect(calls[0]!.url).toContain("include_hidden=false");
  });

  it("addHome() POSTs the address and returns the created resource", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", home: HOME, request_id: "r1" },
    });

    const result = await c.community.addHome("12 Elm St, Unit 3");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ home_address: "12 Elm St, Unit 3" });
    expect(result.home!.homeId).toBe("h1");
    expect(result.homeId).toBe("h1");
    expect(result.requestId).toBe("r1");
  });

  it("a test-mode add creates nothing and echoes what it would have created", async () => {
    const { client: c } = client({
      body: {
        result: "simulated",
        would_create: { address: "12 Elm St, Unit 3" },
        request_id: "r1",
      },
    });

    const result = await c.community.addHome("12 Elm St, Unit 3");

    expect(result.simulated).toBe(true);
    expect(result.home).toBeNull();
    expect(result.wouldSet).toEqual({ address: "12 Elm St, Unit 3" });
  });

  it("home() returns the residents and their move-out dates", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        home: {
          ...HOME,
          members: [
            {
              account_community_id: 4021,
              account_id: "a1",
              first_name: "Dana",
              last_name: "Lee",
              phone_numbers: ["+1 555 123 4567", 17],
              accepted: true,
              move_out_date: "2026-12-31",
            },
          ],
        },
      },
    });

    const home = await c.community.home("h1");

    expect(calls[0]!.url).toContain("/v1/community/homes/h1");
    expect(home.members).toHaveLength(1);
    expect(home.members[0]!.fullName).toBe("Dana Lee");
    expect(home.members[0]!.accountCommunityId).toBe(4021);
    expect(home.members[0]!.moveOutDate).toBe("2026-12-31");
    expect(home.members[0]!.accepted).toBe(true);
    // Non-string entries are dropped rather than typed as strings.
    expect(home.members[0]!.phoneNumbers).toEqual(["+1 555 123 4567"]);
  });

  it("encodes the home id in the path", async () => {
    const { client: c, calls } = client({ body: { home: HOME } });
    await c.community.home("a/b");
    expect(calls[0]!.url).toContain("/v1/community/homes/a%2Fb");
  });

  it("updateHome() sends only the fields supplied", async () => {
    const { client: c, calls } = client({ body: { result: "ok", home: HOME } });

    await c.community.updateHome("h1", { ownerOccupied: true });

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ owner_occupied: true });
  });

  it("hidden is a setter, not a toggle — the same value twice is safe", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", home: { ...HOME, hidden: true } },
    });

    await c.community.updateHome("h1", { hidden: true, homeAddress: "1 New St" });
    await c.community.updateHome("h1", { hidden: true });

    expect(calls[0]!.body).toEqual({ home_address: "1 New St", hidden: true });
    expect(calls[1]!.body).toEqual({ hidden: true });
  });

  it("hiding a home with residents attached is a 409, not a silent success", async () => {
    const { client: c } = client({
      status: 409,
      body: {
        error: {
          code: "home_occupied",
          message:
            "Home still has residents attached; move them out before hiding it",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.updateHome("h1", { hidden: true }),
    ).rejects.toMatchObject({ code: "home_occupied", status: 409 });
  });

  it("removeHome() surfaces detached_member_count — the blast radius", async () => {
    // Deleting a home detaches every resident attached to it, irreversibly.
    // A caller that cannot see the count cannot tell a no-op delete from one
    // that just stripped two people of their unit.
    const { client: c, calls } = client({
      body: {
        result: "ok",
        home_id: "h1",
        deleted: true,
        detached_member_count: 2,
        request_id: "r1",
      },
    });

    const result = await c.community.removeHome("h1");

    expect(calls[0]!.method).toBe("DELETE");
    expect(result.deleted).toBe(true);
    expect(result.detachedMemberCount).toBe(2);
    expect(result.homeId).toBe("h1");
  });

  it("a test-mode delete reports the count it WOULD detach", async () => {
    // Test mode names the same number `would_detach_member_count`; reading it
    // as 0 would advertise a harmless delete for one that detaches two people.
    const { client: c } = client({
      body: {
        result: "simulated",
        home_id: "h1",
        would_detach_member_count: 2,
        request_id: "r1",
      },
    });

    const result = await c.community.removeHome("h1");

    expect(result.simulated).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.detachedMemberCount).toBe(2);
  });

  it("removeHome() 404s for a home on another community", async () => {
    const { client: c } = client({
      status: 404,
      body: {
        error: {
          code: "home_not_found",
          message: "Home not found for this community",
          request_id: "r1",
        },
      },
    });

    await expect(c.community.removeHome("h9")).rejects.toMatchObject({
      code: "home_not_found",
    });
  });

  it("setMoveOutDate() records a date", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        account_community_id: 4021,
        move_out_date: "2026-12-31",
        request_id: "r1",
      },
    });

    const result = await c.community.setMoveOutDate(4021, "2026-12-31");

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("/v1/community/members/4021/move-out-date");
    expect(calls[0]!.body).toEqual({ move_out_date: "2026-12-31" });
    expect(result.moveOutDate).toBe("2026-12-31");
    expect(result.accountCommunityId).toBe(4021);
  });

  it("an explicit null clears the date rather than being omitted", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", account_community_id: 4021, move_out_date: null },
    });

    const result = await c.community.setMoveOutDate(4021, null);

    expect(calls[0]!.body).toEqual({ move_out_date: null });
    expect(result.moveOutDate).toBeNull();
  });

  it("a test-mode move-out write echoes the date under would_set", async () => {
    const { client: c } = client({
      body: {
        result: "simulated",
        account_community_id: 4021,
        would_set: "2026-12-31",
        request_id: "r1",
      },
    });

    const result = await c.community.setMoveOutDate(4021, "2026-12-31");

    expect(result.simulated).toBe(true);
    expect(result.moveOutDate).toBe("2026-12-31");
  });

  it("tolerates a malformed payload without throwing", async () => {
    const { client: c } = client({ body: { homes: "not-an-array" } });
    expect(await c.community.homes()).toEqual([]);
  });

  it("missing counts read as 0, never undefined", async () => {
    const { client: c } = client([
      { body: { homes: [{ home_id: "h1" }] } },
      { body: { result: "ok", home_id: "h1", deleted: true } },
    ]);

    expect((await c.community.homes())[0]!.memberCount).toBe(0);
    expect((await c.community.removeHome("h1")).detachedMemberCount).toBe(0);
  });
});
