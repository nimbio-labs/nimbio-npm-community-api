/**
 * Coverage for the access-code (keypad / GuestView PIN) surface.
 *
 * Two things here fail quietly if the client gets them wrong, so both are
 * pinned: the cleartext PIN exists in exactly one response and nowhere else,
 * and a `temporal` window goes on the wire as `start`/`end` — not the
 * `start_time`/`end_time` every other schedule in the API uses.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const CODE_ROW = {
  directory_access_code_id: 412,
  account_id: "a1",
  owner_name: "Front Desk",
  api_managed: true,
  code_masked: "******",
  code_length: 6,
  disabled: false,
  expires_at: "2026-08-19T17:00:00+00:00",
  has_schedule: false,
  latch_ids: ["l1"],
  latches: [{ id: "l1", name: "Service Entrance" }],
  created_at: "2026-08-18T16:12:00+00:00",
};

describe("access codes", () => {
  it("accessCodes() lists codes WITHOUT the PIN", async () => {
    // code_masked is asterisks and there is no `code` field: a lost PIN is not
    // recoverable, which is the whole reason createAccessCode() matters.
    const { client: c, calls } = client({
      body: { result: "ok", feature_enabled: true, access_codes: [CODE_ROW] },
    });

    const result = await c.community.accessCodes();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/community/access-codes");
    expect(result.featureEnabled).toBe(true);
    expect(result.accessCodes[0]!.codeMasked).toBe("******");
    expect(result.accessCodes[0]!.codeLength).toBe(6);
    expect(result.accessCodes[0]!.apiManaged).toBe(true);
    expect(result.accessCodes[0]!.raw.code).toBeUndefined();
    // The list spells its gates id/name; they land on the same two fields.
    expect(result.accessCodes[0]!.latches[0]!.latchId).toBe("l1");
    expect(result.accessCodes[0]!.latches[0]!.latchName).toBe("Service Entrance");
  });

  it("createAccessCode() returns the cleartext PIN, once", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        request_id: "r1",
        access_code: {
          directory_access_code_id: 412,
          code: "481502",
          code_normalized: "481502",
          account_id: "a1",
          key_id: "k1",
          latch_ids: ["l1"],
        },
      },
    });

    const created = await c.community.createAccessCode("481502", ["l1"], {
      expiresInHours: 6,
    });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      code: "481502",
      latch_ids: ["l1"],
      expires_in_hours: 6,
    });
    expect(created.accessCode!.code).toBe("481502");
    // Lifted to the top level because this is the only place it ever appears.
    expect(created.code).toBe("481502");
    expect(created.directoryAccessCodeId).toBe(412);
  });

  it("a temporal window goes on the wire as start/end, not start_time/end_time", async () => {
    // The one schedule shape in the API spelled this way. Sending the other
    // spelling is a 422, and hand-writing it is exactly the mistake the
    // camelCase input shape exists to prevent.
    const { client: c, calls } = client({ body: { result: "ok", access_code: {} } });

    await c.community.createAccessCode("481502", ["l1"], {
      temporal: {
        daysOfTheWeek: "MTWHF",
        start: "09:00",
        end: "17:00",
        recurringWeek: 1,
      },
    });

    expect(calls[0]!.body).toEqual({
      code: "481502",
      latch_ids: ["l1"],
      temporal: {
        days_of_the_week: "MTWHF",
        start: "09:00",
        end: "17:00",
        recurring_week: 1,
      },
    });
  });

  it("updateAccessCode() PATCHes only the fields given", async () => {
    // Omitted fields keep their stored value; there is no way to CLEAR a
    // cutoff or a window, so nothing may be invented to pad the body.
    const { client: c, calls } = client({
      body: {
        result: "ok",
        request_id: "r2",
        access_code: { directory_access_code_id: 412, disabled: true },
      },
    });

    const result = await c.community.updateAccessCode(412, { disabled: true });

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/v1/community/access-codes/412");
    expect(calls[0]!.body).toEqual({ disabled: true });
    expect(result.directoryAccessCodeId).toBe(412);
    expect(result.disabled).toBe(true);
  });

  it("updateAccessCode() re-points gates and pushes out the cutoff together", async () => {
    const { client: c, calls } = client({ body: { result: "ok", access_code: {} } });

    await c.community.updateAccessCode(412, {
      latchIds: ["l1", "l2"],
      expiresInDays: 3,
      temporal: { daysOfTheWeek: "SU" },
    });

    expect(calls[0]!.body).toEqual({
      latch_ids: ["l1", "l2"],
      expires_in_days: 3,
      temporal: { days_of_the_week: "SU" },
    });
  });

  it("deleteAccessCode() DELETEs by id", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", request_id: "r3", directory_access_code_id: 412 },
    });

    const result = await c.community.deleteAccessCode(412);

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/v1/community/access-codes/412");
    expect(result.directoryAccessCodeId).toBe(412);
    expect(result.accessCode).toBeNull();
    expect(result.disabled).toBeNull();
    expect(result.simulated).toBe(false);
  });

  it("accessCodeEligibleLatches() reports the CM-set allowlist", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        feature_enabled: false,
        latches: [{ latch_id: "l1", latch_name: "Service Entrance" }],
      },
    });

    const eligible = await c.community.accessCodeEligibleLatches();

    expect(calls[0]!.url).toContain("/v1/community/access-codes/eligible-latches");
    expect(eligible.latches[0]!.latchId).toBe("l1");
    // feature_enabled false means every WRITE 403s — worth reading first.
    expect(eligible.featureEnabled).toBe(false);
  });

  it("accessCodeLogs() paginates and masks the entered code", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        limit: 50,
        offset: 0,
        logs: [
          {
            directory_access_code_log_id: 9001,
            directory_access_code_id: 412,
            account_id: "a1",
            owner_name: "Front Desk",
            latch_id: "l1",
            log_datetime: "2026-08-18T17:04:11+00:00",
            result: "opened",
            code_entered_masked: "****",
            client_ip: "203.0.113.9",
          },
        ],
      },
    });

    const page = await c.community.accessCodeLogs({ limit: 200, offset: 20 });

    expect(calls[0]!.url).toContain("limit=200");
    expect(calls[0]!.url).toContain("offset=20");
    expect(page.logs[0]!.result).toBe("opened");
    // Never the typed digits: a successful attempt's entry IS a working PIN.
    expect(page.logs[0]!.codeEnteredMasked).toBe("****");
    // Set whenever the entry matched a code, which is how a row correlates
    // back to a PIN this key minted.
    expect(page.logs[0]!.directoryAccessCodeId).toBe(412);
    expect(page.logs[0]!.clientIp).toBe("203.0.113.9");
    expect(page.offset).toBe(0);
  });

  it("accessCodeLogs() defaults to the first page of 50", async () => {
    const { client: c, calls } = client({ body: { result: "ok", logs: [] } });

    await c.community.accessCodeLogs();

    expect(calls[0]!.url).toContain("limit=50");
    expect(calls[0]!.url).toContain("offset=0");
  });

  it("a simulated create reports what it would have minted", async () => {
    const { client: c } = client({
      body: { result: "simulated", would_create: { directory_access_code_id: 0 } },
    });

    const created = await c.community.createAccessCode("481502", ["l1"]);

    expect(created.simulated).toBe(true);
    expect(created.accessCode!.directoryAccessCodeId).toBe(0);
    // Nothing was minted, so there is no PIN to hand out.
    expect(created.code).toBeNull();
  });
});
