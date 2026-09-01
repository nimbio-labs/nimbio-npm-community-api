/**
 * Coverage for the access-code (keypad / GuestView PIN) surface.
 *
 * Two things here fail quietly if the client gets them wrong, so both are
 * pinned: the cleartext PIN exists in exactly one response and nowhere else,
 * and a `temporal` window goes on the wire as `start`/`end` — not the
 * `start_time`/`end_time` every other schedule in the API uses.
 */
import { describe, expect, it } from "vitest";
import { APIError, ConflictError, NimbioClient } from "../src/index.js";
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
    expect(created.entryCode).toBeNull();
  });

  it("in single_entry mode a row carries the preamble and a masked entry code", async () => {
    // The preamble is in clear (it is not a secret — it is derived from the
    // member's name), the code stays masked, and the two are pre-joined into
    // what the visitor would type.
    const { client: c } = client({
      body: {
        result: "ok",
        feature_enabled: true,
        access_codes: [{ ...CODE_ROW, preamble: "ESM", entry_code_masked: "ESM******" }],
      },
    });

    const row = (await c.community.accessCodes()).accessCodes[0]!;

    expect(row.preamble).toBe("ESM");
    expect(row.entryCodeMasked).toBe("ESM******");
    expect(row.codeMasked).toBe("******");
  });

  it("accessCodes() reports the mode the community runs beside the rows", async () => {
    // The list carries the mode so a caller rendering codes knows whether to
    // show `codeMasked` or `entryCodeMasked` without a second round trip.
    const { client: c } = client({
      body: {
        result: "ok",
        feature_enabled: true,
        access_code_mode: "single_entry",
        access_codes: [],
      },
    });

    const list = await c.community.accessCodes();

    expect(list.accessCodeMode).toBe("single_entry");
    expect(list.featureEnabled).toBe(true);
  });

  it("in per_member mode the preamble fields are null, not missing", async () => {
    const { client: c } = client({
      body: { result: "ok", feature_enabled: true, access_codes: [CODE_ROW] },
    });

    const list = await c.community.accessCodes();
    const row = list.accessCodes[0]!;

    expect(row.preamble).toBeNull();
    expect(row.entryCodeMasked).toBeNull();
    // An older server that does not send the mode parses as null, not "".
    expect(list.accessCodeMode).toBeNull();
  });

  it("createAccessCode() returns the full entry code once in single_entry mode", async () => {
    // `entry_code` is preamble + code — the string the visitor types. Like
    // `code`, this response is the only place it ever appears, so it is
    // lifted to the top level beside it.
    const { client: c } = client({
      body: {
        result: "ok",
        request_id: "r1",
        access_code: {
          directory_access_code_id: 413,
          code: "481502",
          code_normalized: "481502",
          preamble: "ESM",
          entry_code: "ESM481502",
          account_id: "a1",
          key_id: "k1",
          latch_ids: ["l1"],
        },
      },
    });

    const created = await c.community.createAccessCode("481502", ["l1"]);

    expect(created.accessCode!.preamble).toBe("ESM");
    expect(created.accessCode!.entryCode).toBe("ESM481502");
    expect(created.entryCode).toBe("ESM481502");
    expect(created.code).toBe("481502");
  });
});

describe("access-code mode", () => {
  const PREVIEW = {
    mode: "per_member",
    new_mode: "single_entry",
    codes_to_delete: 14,
    members_affected: 9,
    members_to_assign_preamble: 112,
  };

  it("accessCodeMode() reports the mode in force and the cost of flipping it", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        mode: "per_member",
        flip_preview: {
          new_mode: "single_entry",
          codes_to_delete: 14,
          members_affected: 9,
          members_to_assign_preamble: 112,
        },
      },
    });

    const status = await c.community.accessCodeMode();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/community/access-codes/mode");
    expect(status.mode).toBe("per_member");
    expect(status.flipPreview.newMode).toBe("single_entry");
    // EVERY code in the community, residents' own included.
    expect(status.flipPreview.codesToDelete).toBe(14);
    expect(status.flipPreview.membersAffected).toBe(9);
    expect(status.flipPreview.membersToAssignPreamble).toBe(112);
    // The status carries the current mode; the preview does not repeat it.
    expect(status.flipPreview.mode).toBeNull();
  });

  it("setAccessCodeMode() to the current mode is a no-op, with or without confirm", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", mode: "per_member", changed: false, request_id: "r1" },
    });

    const result = await c.community.setAccessCodeMode("per_member");

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("/v1/community/access-codes/mode");
    // `confirm` is always a JSON boolean on the wire; absent means false.
    expect(calls[0]!.body).toEqual({ mode: "per_member", confirm: false });
    expect(result.changed).toBe(false);
    expect(result.mode).toBe("per_member");
    expect(result.deletedCodes).toBeNull();
    expect(result.notifiedMembers).toBeNull();
    expect(result.wouldChange).toBeNull();
    expect(result.simulated).toBe(false);
    expect(result.requestId).toBe("r1");
  });

  it("an unconfirmed switch throws ConflictError carrying the preview, and confirm:true goes through", async () => {
    // The headline flow, and the same one updateNfcTag() uses: the 409 is a
    // warning with the blast radius attached, not a veto. Nothing changed on
    // the first call; only the confirmed retry deletes anything.
    const { client: c, calls } = client([
      {
        status: 409,
        body: {
          error: {
            code: "requires_confirmation",
            message: "Switching access code mode deletes every existing access code…",
            preview: PREVIEW,
            request_id: "r1",
          },
        },
      },
      {
        body: {
          result: "ok",
          mode: "single_entry",
          changed: true,
          deleted_codes: 14,
          notified_members: 9,
          request_id: "r2",
        },
      },
    ]);

    let switched;
    try {
      await c.community.setAccessCodeMode("single_entry");
      throw new Error("expected the warning");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect(e).toMatchObject({ code: "requires_confirmation", status: 409 });
      // The preview rides on the raw envelope, snake_case, for a caller that
      // wants to show it without a second round trip to accessCodeMode().
      expect((e as ConflictError).response).toMatchObject({
        error: { preview: PREVIEW },
      });
      switched = await c.community.setAccessCodeMode("single_entry", { confirm: true });
    }

    expect(switched.changed).toBe(true);
    expect(switched.mode).toBe("single_entry");
    expect(switched.deletedCodes).toBe(14);
    expect(switched.notifiedMembers).toBe(9);
    expect(switched.simulated).toBe(false);
    expect(switched.wouldChange).toBeNull();
    expect(calls[0]!.body).toEqual({ mode: "single_entry", confirm: false });
    expect(calls[1]!.body).toEqual({ mode: "single_entry", confirm: true });
    // A 409 is not retryable transport-wise, so exactly two round trips.
    expect(calls).toHaveLength(2);
  });

  it("a confirmed switch on a test key is simulated: nothing deleted, the preview returned", async () => {
    // `changed` must read false — a test key never touches real codes — and
    // the mode is taken from the preview so a caller can still log intent.
    const { client: c } = client({
      body: { result: "simulated", would_change: PREVIEW, request_id: "r3" },
    });

    const result = await c.community.setAccessCodeMode("single_entry", { confirm: true });

    expect(result.simulated).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.mode).toBe("single_entry");
    expect(result.wouldChange!.mode).toBe("per_member");
    expect(result.wouldChange!.newMode).toBe("single_entry");
    expect(result.wouldChange!.codesToDelete).toBe(14);
    expect(result.wouldChange!.membersAffected).toBe(9);
    expect(result.wouldChange!.membersToAssignPreamble).toBe(112);
    expect(result.deletedCodes).toBeNull();
    expect(result.notifiedMembers).toBeNull();
  });

  it("an unknown mode is the server's 422 invalid_mode, forwarded verbatim", async () => {
    // The type is closed so TypeScript catches this; a JS caller still gets
    // the server's own rejection rather than a client guess.
    const { client: c, calls } = client({
      status: 422,
      body: {
        error: {
          code: "invalid_mode",
          message: "Unknown access code mode 'keypad'; expected per_member or single_entry",
          request_id: "r4",
        },
      },
    });

    await expect(
      c.community.setAccessCodeMode("keypad" as unknown as "per_member"),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(APIError);
      expect(e).toMatchObject({ code: "invalid_mode", status: 422 });
      return true;
    });
    expect(calls[0]!.body).toEqual({ mode: "keypad", confirm: false });
  });

  it("only a literal `true` confirms; anything else is sent as false", async () => {
    // The server honours only the JSON boolean true, so the client never
    // forwards a truthy-but-not-true value that would silently be a dry run
    // on one side and look like a confirmation on the other.
    const { client: c, calls } = client({
      body: { result: "ok", mode: "per_member", changed: false },
    });

    await c.community.setAccessCodeMode("per_member", { confirm: undefined });
    await c.community.setAccessCodeMode("per_member", {});

    expect(calls[0]!.body).toEqual({ mode: "per_member", confirm: false });
    expect(calls[1]!.body).toEqual({ mode: "per_member", confirm: false });
  });
});
