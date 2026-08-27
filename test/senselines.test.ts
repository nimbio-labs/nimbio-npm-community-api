/**
 * Coverage for the sense-line surface — the feedback loop behind gate status.
 *
 * The trap this suite guards is `box_id`. The OpenAPI schema marks it optional
 * on the single-sense-line routes, but a sense line id is an input number
 * unique only within its box, so omitting it is a 422 rather than a guess.
 * The client makes it required, which turns that runtime error into a compile
 * error; the tests below pin both halves of that.
 */
import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const LATCH = { latch_id: "l1", latch_name: "Main Gate" };

const SENSE_LINE = {
  box_id: "b1",
  box_name: "Front Entrance Box",
  sense_line_id: 1,
  sense_line_online: true,
  latch_data_online: true,
  reporting: true,
  latches: [LATCH],
  created_at: "2026-01-04T18:02:11+00:00",
  updated_at: "2026-06-30T09:14:52+00:00",
};

const DETAIL = {
  ...SENSE_LINE,
  status_map: [
    { sense_line_state: 0, latch_id: "l1", latch_name: "Main Gate", status: "Closed", transient_ms: 0 },
    { sense_line_state: 1, latch_id: "l1", latch_name: "Main Gate", status: "Open", transient_ms: 1500 },
  ],
  last_record: { state: 0, logged_at: "2026-08-17T22:41:07+00:00" },
};

describe("sense lines", () => {
  it("senseLines() treats boxId as a real filter and omits it by default", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        sense_lines: [SENSE_LINE],
        boxes: [{ box_id: "b1", box_name: "Front Entrance Box", latches: [LATCH] }],
      },
    });

    const lines = await c.community.senseLines();

    expect(calls[0]!.url).toContain("/v1/community/sense-lines");
    // Optional here, unlike the single-sense-line routes: no box_id means
    // every box in the community.
    expect(calls[0]!.url).not.toContain("box_id");
    expect(lines.senseLines[0]!.senseLineId).toBe(1);
    expect(lines.senseLines[0]!.reporting).toBe(true);
    expect(lines.boxes[0]!.latches[0]!.latchName).toBe("Main Gate");
  });

  it("senseLines({ boxId }) narrows to one box", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", sense_lines: [SENSE_LINE], boxes: [] },
    });

    await c.community.senseLines({ boxId: "b1" });

    expect(calls[0]!.url).toContain("box_id=b1");
  });

  it("reporting:false is the configuration diagnosis, not a stuck gate", async () => {
    // Either flag off means transitions never reach gate status. The derived
    // flag is what a caller should branch on.
    const { client: c } = client({
      body: {
        result: "ok",
        sense_lines: [
          { ...SENSE_LINE, latch_data_online: false, reporting: false },
        ],
        boxes: [],
      },
    });

    const lines = await c.community.senseLines();
    const line = lines.senseLines[0]!;

    expect(line.senseLineOnline).toBe(true);
    expect(line.latchDataOnline).toBe(false);
    expect(line.reporting).toBe(false);
  });

  it("senseLine() requires boxId and always sends it", async () => {
    const { client: c, calls } = client({ body: { result: "ok", ...DETAIL } });

    const line = await c.community.senseLine(1, "b1");

    expect(calls[0]!.url).toContain("/v1/community/sense-lines/1");
    // Required, not optional: half the identity of a sense line.
    expect(calls[0]!.url).toContain("box_id=b1");
    expect(line.statusMap).toHaveLength(2);
    expect(line.statusMap[1]!.status).toBe("Open");
    // Non-zero transient_ms: shown briefly, then reverts.
    expect(line.statusMap[1]!.transientMs).toBe(1500);
    expect(line.lastRecord!.loggedAt).toBe("2026-08-17T22:41:07+00:00");
  });

  it("omitting boxId is a compile error, not a runtime 422", async () => {
    // The whole point of encoding the prose contract rather than the schema's:
    // the server answers 422 box_id_required, and the type system gets there
    // first. If this line ever stops erroring, the guard has been lost.
    const { client: c } = client({ body: { result: "ok", ...DETAIL } });

    // @ts-expect-error boxId is required — sense line ids are per box
    const call = () => c.community.senseLine(1);

    expect(typeof call).toBe("function");
  });

  it("a server that still 422s on a missing box_id surfaces its own code", async () => {
    const { client: c } = client({
      status: 422,
      body: {
        error: {
          code: "box_id_required",
          message:
            "box_id is required: sense line numbers are unique per box, not per community",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.senseLine(1, ""),
    ).rejects.toMatchObject({ code: "box_id_required", status: 422 });
  });

  it("updateSenseLine() sends only the flags given, as explicit sets", async () => {
    // Re-sending the same call is a no-op: these are sets, not toggles.
    const { client: c, calls } = client({
      body: { result: "ok", ...DETAIL, sense_line_online: false, reporting: false },
    });

    const line = await c.community.updateSenseLine(1, "b1", {
      senseLineOnline: false,
    });

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/v1/community/sense-lines/1");
    expect(calls[0]!.url).toContain("box_id=b1");
    // latch_data_online untouched, so it must not appear in the body at all.
    expect(calls[0]!.body).toEqual({ sense_line_online: false });
    // Switching it off freezes the gate's reported status for every surface.
    expect(line.reporting).toBe(false);
  });

  it("updateSenseLine() can send both flags", async () => {
    const { client: c, calls } = client({ body: { result: "ok", ...DETAIL } });

    await c.community.updateSenseLine(1, "b1", {
      senseLineOnline: true,
      latchDataOnline: true,
    });

    expect(calls[0]!.body).toEqual({
      sense_line_online: true,
      latch_data_online: true,
    });
  });

  it("an empty patch travels empty so the server's no_fields wins", async () => {
    const { client: c, calls } = client({
      status: 422,
      body: {
        error: {
          code: "no_fields",
          message: "Supply sense_line_online and/or latch_data_online",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.updateSenseLine(1, "b1", {}),
    ).rejects.toMatchObject({ code: "no_fields" });
    expect(calls[0]!.body).toEqual({});
  });

  it("a simulated reconfigure reconfigures no real hardware", async () => {
    const { client: c } = client({
      body: {
        result: "simulated",
        ...DETAIL,
        simulated: true,
        would_set: { sense_line_online: false },
      },
    });

    const line = await c.community.updateSenseLine(1, "b1", {
      senseLineOnline: false,
    });

    expect(line.simulated).toBe(true);
    expect(line.wouldSet).toEqual({ sense_line_online: false });
    // The echoed line is still the stored one — nothing moved.
    expect(line.senseLineOnline).toBe(true);
  });

  it("senseLineRecords() returns raw transitions, including unmapped states", async () => {
    // Rows are written even when a sense line is switched off, which is what
    // makes a healthy stream here alongside a stale gate status a proof that
    // the wiring is fine and the configuration is not. A state with no
    // configured meaning comes back with a null status rather than being
    // dropped — the unmapped state IS the finding.
    const { client: c, calls } = client({
      body: {
        result: "ok",
        records: [
          { box_id: "b1", box_name: "Front Entrance Box", sense_line_id: 1, state: 1, status: "Open", logged_at: "2026-08-17T22:41:07+00:00" },
          { box_id: "b1", box_name: "Front Entrance Box", sense_line_id: 1, state: 7, status: null, logged_at: "2026-08-17T22:40:12+00:00" },
        ],
        limit: 50,
        offset: 0,
        has_more: true,
      },
    });

    const page = await c.community.senseLineRecords({
      boxId: "b1",
      senseLineId: 1,
      limit: 2,
      offset: 4,
    });

    expect(calls[0]!.url).toContain("/v1/community/sense-lines/records");
    expect(calls[0]!.url).toContain("box_id=b1");
    expect(calls[0]!.url).toContain("sense_line_id=1");
    expect(calls[0]!.url).toContain("limit=2");
    expect(calls[0]!.url).toContain("offset=4");
    expect(page.records).toHaveLength(2);
    expect(page.records[0]!.status).toBe("Open");
    expect(page.records[1]!.state).toBe(7);
    expect(page.records[1]!.status).toBeNull();
    expect(page.hasMore).toBe(true);
  });

  it("senseLineRecords() defaults to every box and the documented window", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", records: [], limit: 50, offset: 0, has_more: false },
    });

    await c.community.senseLineRecords();

    expect(calls[0]!.url).not.toContain("box_id");
    expect(calls[0]!.url).not.toContain("sense_line_id");
    expect(calls[0]!.url).toContain("limit=50");
    expect(calls[0]!.url).toContain("offset=0");
  });
});
