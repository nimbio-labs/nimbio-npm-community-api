/**
 * Coverage for the guest-link surface.
 *
 * The security property that matters here is pinned by tests rather than left
 * to the docs: `token` and `url` are bearer credentials for a gate, and they
 * come back from the **list** read as well as from create. If the API ever
 * stopped returning them from the list, the warning on `guestLinks()` would be
 * over-strict and this test would say so; while it passes, the warning is
 * literally true.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient, GUEST_LINK_TYPES, GUEST_LINK_STATES } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const LINK = {
  guest_link_id: 4417,
  community_id: 2585,
  link_type: "limited_use",
  state: "active",
  title: "Booking 8841 — Unit 4",
  subtitle: "Front gate access",
  token: "Q1w2E3r4T5y6U7i8O9p0aA",
  url: "https://d.nimbio.com/l/Q1w2E3r4T5y6U7i8O9p0aA",
  key_id: "k1a2",
  key_name: "Main Entrance",
  latches: [{ latch_id: "l1", latch_name: "Main Entrance" }],
  max_uses: 6,
  uses_consumed: 2,
  total_opens: 2,
  notify_on_use: false,
  revoked: false,
  expires_at: "2026-08-25T11:00:00+00:00",
  last_used_at: "2026-08-19T14:02:11+00:00",
  created_at: "2026-08-18T09:15:00+00:00",
  created_by_account_id: "a1b2",
  created_by_cm: true,
  created_by_name: "Dana Lee",
};

describe("guest links", () => {
  it("guestLinks() lists links and parses them", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", guest_links: [LINK] },
    });

    const links = await c.community.guestLinks();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/community/guest-links");
    expect(links).toHaveLength(1);
    expect(links[0]!.guestLinkId).toBe(4417);
    expect(links[0]!.linkType).toBe("limited_use");
    expect(links[0]!.state).toBe("active");
    expect(links[0]!.maxUses).toBe(6);
    expect(links[0]!.usesConsumed).toBe(2);
    expect(links[0]!.createdByCm).toBe(true);
    expect(links[0]!.latches[0]!.latchName).toBe("Main Entrance");
    // Nothing is lost on the way through.
    expect(links[0]!.raw.guest_link_id).toBe(4417);
  });

  it("THE LIST RESPONSE CARRIES token AND url — it is secret material", async () => {
    // This is the wave's most important fact. A leaked listing is a leaked set
    // of working gate links: the URL alone opens the gate, with no account, no
    // key and no login. The docstring on guestLinks() says so; this test is
    // what keeps that claim true if the API changes.
    const { client: c } = client({ body: { result: "ok", guest_links: [LINK] } });

    const [link] = await c.community.guestLinks();

    expect(link!.token).toBe("Q1w2E3r4T5y6U7i8O9p0aA");
    expect(link!.url).toBe("https://d.nimbio.com/l/Q1w2E3r4T5y6U7i8O9p0aA");
  });

  it("includeInactive is always sent, so `false` really narrows the list", async () => {
    // The server defaults it to true; omitting it on false would keep listing
    // revoked and expired links while the caller believed otherwise.
    const { client: c, calls } = client({ body: { result: "ok", guest_links: [] } });

    await c.community.guestLinks({ includeInactive: false });
    await c.community.guestLinks();

    expect(calls[0]!.url).toContain("include_inactive=false");
    expect(calls[1]!.url).toContain("include_inactive=true");
  });

  it("createGuestLink() sends an event link's window fields", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", request_id: "r1", guest_link: { ...LINK, link_type: "event" } },
    });

    const created = await c.community.createGuestLink("event", ["l1", "l2"], {
      keyId: "k1a2",
      title: "Rooftop party",
      subtitle: "Saturday",
      windowStart: "2026-08-22T18:00:00Z",
      windowEnd: "2026-08-22T23:00:00Z",
      notifyOnUse: true,
    });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      link_type: "event",
      latch_ids: ["l1", "l2"],
      key_id: "k1a2",
      title: "Rooftop party",
      subtitle: "Saturday",
      window_start: "2026-08-22T18:00:00Z",
      window_end: "2026-08-22T23:00:00Z",
      notify_on_use: true,
    });
    expect(created.guestLink!.linkType).toBe("event");
    // The URL to hand the guest — returned once here, and re-readable later.
    expect(created.guestLink!.url).toContain("https://");
    expect(created.requestId).toBe("r1");
  });

  it("createGuestLink() sends a limited-use link's caps and omits what was not given", async () => {
    const { client: c, calls } = client({ body: { result: "ok", guest_link: LINK } });

    await c.community.createGuestLink("limited_use", ["l1"], {
      maxUses: 6,
      expiresAt: "2026-08-25T11:00:00Z",
    });

    expect(calls[0]!.body).toEqual({
      link_type: "limited_use",
      latch_ids: ["l1"],
      max_uses: 6,
      expires_at: "2026-08-25T11:00:00Z",
    });
  });

  it("revokeGuestLink() DELETEs by id and reports the revoked link", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        request_id: "r2",
        guest_link: {
          ...LINK,
          revoked: true,
          state: "revoked",
          revoked_datetime: "2026-08-20T10:00:00+00:00",
        },
      },
    });

    const result = await c.community.revokeGuestLink(4417);

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/v1/community/guest-links/4417");
    expect(result.guestLink!.revoked).toBe(true);
    expect(result.guestLink!.state).toBe("revoked");
    expect(result.guestLinkId).toBe(4417);
  });

  it("a simulated revoke still reports what it would have killed", async () => {
    // Test mode leaves the link live and echoes it under a would_* name; a
    // caller inspecting the blast radius must get it either way.
    const { client: c } = client({
      body: { result: "simulated", would_revoke: LINK },
    });

    const result = await c.community.revokeGuestLink(4417);

    expect(result.simulated).toBe(true);
    expect(result.guestLink!.guestLinkId).toBe(4417);
  });

  it("guestLinkLogs() paginates and can narrow to one link", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        limit: 50,
        offset: 0,
        logs: [
          {
            guest_link_log_id: 91002,
            guest_link_id: 4417,
            link_title: "Booking 8841 — Unit 4",
            link_type: "limited_use",
            latch_id: "l1",
            latch_name: "Main Entrance",
            log_datetime: "2026-08-19T14:02:11+00:00",
            result: "opened",
            use_number: 2,
            client_ip: "203.0.113.7",
            user_agent: "Mozilla/5.0 (iPhone)",
          },
        ],
      },
    });

    const page = await c.community.guestLinkLogs({ guestLinkId: 4417, limit: 10 });

    expect(calls[0]!.url).toContain("guest_link_id=4417");
    expect(calls[0]!.url).toContain("limit=10");
    expect(calls[0]!.url).toContain("offset=0");
    expect(page.logs[0]!.result).toBe("opened");
    expect(page.logs[0]!.useNumber).toBe(2);
    // Guest PII: it is parsed, and the docs say to treat it accordingly.
    expect(page.logs[0]!.clientIp).toBe("203.0.113.7");
    expect(page.logs[0]!.userAgent).toContain("iPhone");
    expect(page.limit).toBe(50);
  });

  it("guestLinkLatchExclusions() splits the exclusions per link type", async () => {
    // Absence is permission, and the lists are independent: a gate barred from
    // event links may still back a limited-use one.
    const { client: c, calls } = client({
      body: { result: "ok", excluded_latch_ids: { event: ["l9"], limited_use: [] } },
    });

    const exclusions = await c.community.guestLinkLatchExclusions();

    expect(calls[0]!.url).toContain("/v1/community/guest-links/latch-exclusions");
    expect(exclusions.event).toEqual(["l9"]);
    expect(exclusions.limitedUse).toEqual([]);
    expect(exclusions.excludedLatchIds).toEqual({ event: ["l9"], limited_use: [] });
  });

  it("an unknown link type in the exclusions map survives", async () => {
    // The map is keyed by whatever the server sends, so a link type this
    // client predates is still readable through excludedLatchIds.
    const { client: c } = client({
      body: { result: "ok", excluded_latch_ids: { delivery: ["l4"] } },
    });

    const exclusions = await c.community.guestLinkLatchExclusions();

    expect(exclusions.excludedLatchIds.delivery).toEqual(["l4"]);
    expect(exclusions.event).toEqual([]);
  });

  it("the link-type and state vocabularies are exported", () => {
    expect(GUEST_LINK_TYPES).toEqual(["event", "limited_use"]);
    expect(GUEST_LINK_STATES).toContain("feature_disabled");
  });
});
