/**
 * Coverage for the NFC tag surface.
 *
 * Two things here are worth pinning down. The PATCH is one call that assigns,
 * unassigns and disables, and the order it applies fields in decides whether a
 * two-field body works or is refused. And the 409 it can answer is a *warning*
 * — the intended flow is to catch it and repeat with confirmation, which is
 * exactly what a caller will get wrong if the client hides it.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const TAG = {
  tag_id: 4182,
  tag_serial: "NFC-7K2MQ9XA",
  tag_uid_hex: "04a1b2c3d4e580",
  latch_id: "3f1c",
  disabled: false,
  notes: "Unit 214 — resident fob",
  last_scan_at: "2026-08-17T18:42:11+00:00",
  created_at: "2026-05-02T09:15:00+00:00",
  last_updated_datetime: "2026-08-17T18:42:11+00:00",
};

const SCAN = {
  scan_log_id: 90211,
  scanned_at: "2026-08-17T18:42:11+00:00",
  tag_id: 4182,
  tag_serial: "NFC-7K2MQ9XA",
  tag_uid_hex: "04a1b2c3d4e580",
  latch_id: "3f1c",
  latch_name: "Pedestrian Gate",
  result: "ok",
  open_outcome: "opened",
  first_name: "Dana",
  last_name: "Lee",
};

describe("NFC tags", () => {
  it("nfcTags() pages with the documented defaults", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", items: [TAG], page: 1, results_per_page: 50, total: 1 },
    });

    const page = await c.community.nfcTags();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/community/nfc-tags");
    // 1-based paging, 50 per page — the server's own defaults, sent explicitly.
    expect(calls[0]!.url).toContain("page=1");
    expect(calls[0]!.url).toContain("results_per_page=50");
    // No search asked for, so no `search` at all: absence means "everything",
    // which is not what searching for "" would mean.
    expect(calls[0]!.url).not.toContain("search=");
    expect(page.total).toBe(1);
    expect(page.items[0]!.tagSerial).toBe("NFC-7K2MQ9XA");
    // The physical UID is published on purpose — it is the scan-log join key.
    expect(page.items[0]!.tagUidHex).toBe("04a1b2c3d4e580");
    expect(page.items[0]!.disabled).toBe(false);
    expect(page.items[0]!.notes).toBe("Unit 214 — resident fob");
  });

  it("nfcTags() forwards a search and explicit paging", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", items: [], page: 3, results_per_page: 200, total: 0 },
    });

    await c.community.nfcTags({ search: "Unit 214", page: 3, resultsPerPage: 200 });

    expect(calls[0]!.url).toContain("search=Unit+214");
    expect(calls[0]!.url).toContain("page=3");
    expect(calls[0]!.url).toContain("results_per_page=200");
  });

  it("nfcTag() unwraps the single-tag envelope", async () => {
    const { client: c, calls } = client({ body: { result: "ok", tag: TAG } });

    const tag = await c.community.nfcTag(4182);

    expect(calls[0]!.url).toContain("/v1/community/nfc-tags/4182");
    expect(tag.tagId).toBe(4182);
    expect(tag.latchId).toBe("3f1c");
  });

  it("another community's tag is an ordinary 404, not a hint that it exists", async () => {
    const { client: c } = client({
      status: 404,
      body: {
        error: {
          code: "tag_not_found",
          message: "Tag not found for this community",
          request_id: "r1",
        },
      },
    });

    // Same code an unknown tag gets: the API never confirms someone else's
    // tag exists.
    await expect(c.community.nfcTag("someone-elses-tag")).rejects.toMatchObject({
      code: "tag_not_found",
      status: 404,
    });
  });

  it("updateNfcTag() sends disabled as an explicit setter, never a toggle", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", request_id: "r1", tag: { ...TAG, disabled: true } },
    });

    const result = await c.community.updateNfcTag(4182, { disabled: true });

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ disabled: true });
    expect(result.tag!.disabled).toBe(true);
    expect(result.simulated).toBe(false);
  });

  it("updateNfcTag() sends a null latchId rather than dropping it", async () => {
    // null detaches the tag; omitting the field means "leave the binding
    // alone". Collapsing the two would make a detach silently do nothing.
    const { client: c, calls } = client({
      body: { result: "ok", tag: { ...TAG, latch_id: null } },
    });

    const result = await c.community.updateNfcTag(4182, { latchId: null });

    expect(calls[0]!.body).toEqual({ latch_id: null });
    expect(result.tag!.latchId).toBeNull();
  });

  it("a revive-then-bind sends both fields; disabled is applied first", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", tag: { ...TAG, disabled: false, latch_id: "l2" } },
    });

    await c.community.updateNfcTag(4182, { disabled: false, latchId: "l2" });

    expect(calls[0]!.body).toEqual({ disabled: false, latch_id: "l2" });
  });

  it("disabling and binding in one call is the server's 422, not a client guess", async () => {
    // A dead fob cannot be routed to a gate. The client forwards the pair as
    // written so the rejection names the real reason.
    const { client: c, calls } = client({
      status: 422,
      body: {
        error: {
          code: "conflicting_fields",
          message: "A disabled tag cannot be assigned to a gate; re-enable it first",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.updateNfcTag(4182, { disabled: true, latchId: "l2" }),
    ).rejects.toMatchObject({ code: "conflicting_fields", status: 422 });
    expect(calls[0]!.body).toEqual({ disabled: true, latch_id: "l2" });
  });

  it("an empty patch reaches the server as an empty body", async () => {
    const { client: c, calls } = client({
      status: 422,
      body: {
        error: {
          code: "empty_patch",
          message: "Provide 'disabled' and/or 'latch_id'",
          request_id: "r1",
        },
      },
    });

    await expect(c.community.updateNfcTag(4182, {})).rejects.toMatchObject({
      code: "empty_patch",
    });
    expect(calls[0]!.body).toEqual({});
  });

  it("409 requires_confirmation raises ConflictError, and confirm:true retries through", async () => {
    // The headline flow: killing the last working tag on a Scan Only gate is a
    // WARNING, not a veto — revoking a stolen fob has to stay possible. Catch
    // the ConflictError and repeat with confirmation.
    const { client: c, calls } = client([
      {
        status: 409,
        body: {
          error: {
            code: "requires_confirmation",
            message: "This is the last active NFC tag on a Scan Only gate.",
            request_id: "r1",
          },
        },
      },
      { body: { result: "ok", request_id: "r2", tag: { ...TAG, disabled: true } } },
    ]);

    let confirmed;
    try {
      await c.community.updateNfcTag(4182, { disabled: true });
      throw new Error("expected the warning");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect(e).toMatchObject({ code: "requires_confirmation", status: 409 });
      confirmed = await c.community.updateNfcTag(4182, {
        disabled: true,
        confirm: true,
      });
    }

    expect(confirmed.tag!.disabled).toBe(true);
    // The first call carried no confirmation; only the retry did.
    expect(calls[0]!.body).toEqual({ disabled: true });
    expect(calls[1]!.body).toEqual({ disabled: true, confirm: true });
    // A 409 is not retryable transport-wise, so exactly two round trips.
    expect(calls).toHaveLength(2);
  });

  it("a simulated write reports what it would have changed and no tag", async () => {
    // A test key must never revoke a real physical credential, so `tag` is
    // absent — reading `.tag` alone would look like the fob was killed.
    const { client: c } = client({
      body: {
        result: "simulated",
        would_change: { disabled: true },
        request_id: "r1",
      },
    });

    const result = await c.community.updateNfcTag(4182, { disabled: true });

    expect(result.simulated).toBe(true);
    expect(result.tag).toBeNull();
    expect(result.wouldChange).toEqual({ disabled: true });
  });

  it("nfcScanLog() filters by physical UID and scan result", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", items: [SCAN], limit: 50, offset: 0, total: 1 },
    });

    const page = await c.community.nfcScanLog({
      tagUidHex: "04a1b2c3d4e580",
      result: "ok",
      limit: 10,
      offset: 20,
    });

    expect(calls[0]!.url).toContain("/v1/community/nfc-tags/scan-log");
    expect(calls[0]!.url).toContain("tag_uid_hex=04a1b2c3d4e580");
    expect(calls[0]!.url).toContain("result=ok");
    expect(calls[0]!.url).toContain("limit=10");
    expect(calls[0]!.url).toContain("offset=20");
    // A tap that read fine but did not open is distinguishable from a refusal.
    expect(page.items[0]!.result).toBe("ok");
    expect(page.items[0]!.openOutcome).toBe("opened");
    // Attribution to a person is the point of the log.
    expect(page.items[0]!.firstName).toBe("Dana");
    expect(page.items[0]!.lastName).toBe("Lee");
    // The IP address and internal record ids are deliberately not exposed.
    expect(page.items[0]!.raw.client_ip).toBeUndefined();
  });

  it("an unresolved tap still yields a row, with no name on it", async () => {
    const { client: c } = client({
      body: {
        result: "ok",
        items: [{ ...SCAN, first_name: null, last_name: null, result: "unknown_tag" }],
        limit: 50,
        offset: 0,
        total: 1,
      },
    });

    const page = await c.community.nfcScanLog();

    expect(page.items[0]!.firstName).toBeNull();
    expect(page.items[0]!.result).toBe("unknown_tag");
  });
});
