/**
 * Coverage for the live event stream: the SSE parser, frame→model mapping,
 * and `community.streamEvents()` (reconnect, resume cursor, reset handling,
 * error mapping, abort).
 */
import { describe, expect, it } from "vitest";
import { NimbioClient, RateLimitError, APIConnectionError } from "../src/index.js";
import {
  SSEParser,
  backoffDelay,
  frameToModel,
  streamParams,
  RECONNECT_BACKOFF_MAX,
} from "../src/sse.js";
import type { StreamEvent, StreamMessage } from "../src/models.js";
import { mockFetch, TEST_KEY, type MockResponseSpec } from "./helpers.js";

function client(responses: MockResponseSpec | MockResponseSpec[]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

function evtFrame(i: number, etype = "sense_line.changed"): string {
  const data = JSON.stringify({
    event: etype,
    id: `e${i}`,
    community_id: 5,
    occurred_at: "2026-07-31T12:00:00+00:00",
    data: { latch_id: "L1", n: i },
  });
  return `id: e${i}\nevent: ${etype}\ndata: ${data}\n\n`;
}

const OPEN = ": stream open\n\n";

async function collect(
  it_: AsyncGenerator<StreamMessage>,
  n: number,
): Promise<StreamMessage[]> {
  const out: StreamMessage[] = [];
  for await (const msg of it_) {
    out.push(msg);
    if (out.length >= n) break;
  }
  return out;
}

describe("SSE parser", () => {
  it("assembles frames and skips comments", () => {
    const p = new SSEParser();
    expect(p.feed(": ping")).toBeNull();
    expect(p.feed("")).toBeNull(); // blank after comment: no frame
    expect(p.feed("id: e1")).toBeNull();
    expect(p.feed("event: sense_line.changed")).toBeNull();
    expect(p.feed('data: {"a":1}')).toBeNull();
    expect(p.feed("")).toEqual({
      id: "e1",
      event: "sense_line.changed",
      data: '{"a":1}',
    });
    expect(p.feed("")).toBeNull(); // state reset after dispatch
  });

  it("handles multi-line data and colon-less values", () => {
    const p = new SSEParser();
    p.feed("event:x");
    p.feed("id:e9");
    p.feed("data: line1");
    p.feed("data: line2");
    expect(p.feed("")).toEqual({ id: "e9", event: "x", data: "line1\nline2" });
  });

  it("frameToModel maps events, resets, and rejects junk", () => {
    const ok = frameToModel({
      id: "e1",
      event: "open.succeeded",
      data: '{"data":{"latch_id":"L"}}',
    });
    expect(ok).toMatchObject({ kind: "event", id: "e1", type: "open.succeeded" });
    expect((ok as StreamEvent).payload).toEqual({ latch_id: "L" });

    expect(
      frameToModel({ id: null, event: "stream.reset", data: '{"reason":"replay_unavailable"}' }),
    ).toEqual({ kind: "reset", reason: "replay_unavailable" });
    expect(frameToModel({ id: null, event: "stream.reset", data: "junk" })).toEqual({
      kind: "reset",
      reason: null,
    });

    expect(frameToModel({ id: null, event: "x", data: "{}" })).toBeNull();
    expect(frameToModel({ id: "e", event: null, data: "{}" })).toBeNull();
    expect(frameToModel({ id: "e", event: "x", data: "junk" })).toBeNull();
    expect(frameToModel({ id: "e", event: "x", data: "" })).toMatchObject({
      kind: "event",
      data: {},
      payload: {},
    });
    expect(frameToModel({ id: "e", event: "x", data: "[1]" })).toMatchObject({
      kind: "event",
      data: {},
    });
  });

  it("streamParams and backoffDelay", () => {
    expect(streamParams(undefined, null)).toBeUndefined();
    expect(streamParams(["a", "b"], "e1")).toEqual({ events: "a,b", last_event_id: "e1" });
    expect(backoffDelay(0)).toBe(0.5);
    expect(backoffDelay(20)).toBe(RECONNECT_BACKOFF_MAX);
  });
});

describe("community.streamEvents", () => {
  it("yields events from a single connection", async () => {
    const { client: c } = client({
      body: OPEN + evtFrame(1) + evtFrame(2, "hold_open.changed"),
      headers: { "content-type": "text/event-stream" },
    });
    const got: StreamMessage[] = [];
    for await (const msg of c.community.streamEvents({ reconnect: false })) {
      got.push(msg);
    }
    expect(got.map((m) => (m as StreamEvent).id)).toEqual(["e1", "e2"]);
    expect((got[1] as StreamEvent).type).toBe("hold_open.changed");
    expect((got[0] as StreamEvent).payload).toMatchObject({ latch_id: "L1" });
  });

  it("sends the filter and resume cursor", async () => {
    const { client: c, calls } = client({ body: OPEN + evtFrame(2) });
    for await (const _ of c.community.streamEvents({
      events: ["sense_line.changed", "hold_open.changed"],
      lastEventId: "e1",
      reconnect: false,
    })) {
      void _;
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/events/stream");
    expect(url.searchParams.get("events")).toBe("sense_line.changed,hold_open.changed");
    expect(url.searchParams.get("last_event_id")).toBe("e1");
  });

  it("reconnects and resumes from the last seen id", async () => {
    const { client: c, calls } = client([
      { body: OPEN + evtFrame(1) },
      { body: OPEN + evtFrame(2) },
    ]);
    const got = await collect(c.community.streamEvents(), 2);
    expect(got.map((m) => (m as StreamEvent).id)).toEqual(["e1", "e2"]);
    expect(calls.length).toBe(2);
    expect(new URL(calls[1]!.url).searchParams.get("last_event_id")).toBe("e1");
  });

  it("yields reset and clears the cursor", async () => {
    const reset = 'event: stream.reset\ndata: {"reason":"replay_unavailable"}\n\n';
    const { client: c, calls } = client([
      { body: reset + evtFrame(3) },
      { body: OPEN + evtFrame(4) },
    ]);
    const got = await collect(c.community.streamEvents({ lastEventId: "expired" }), 3);
    expect(got[0]).toEqual({ kind: "reset", reason: "replay_unavailable" });
    expect((got[1] as StreamEvent).id).toBe("e3");
    expect((got[2] as StreamEvent).id).toBe("e4");
    // After the reset the cursor restarted from e3, not "expired".
    expect(new URL(calls[1]!.url).searchParams.get("last_event_id")).toBe("e3");
  });

  it("throws mapped HTTP errors (stream_limit)", async () => {
    const { client: c } = client({
      status: 429,
      body: { error: { code: "stream_limit", message: "cap" } },
    });
    await expect(c.community.streamEvents().next()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws on transport error when reconnect is off", async () => {
    const c = new NimbioClient(TEST_KEY, {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(
      c.community.streamEvents({ reconnect: false }).next(),
    ).rejects.toBeInstanceOf(APIConnectionError);
  });

  it("reconnects across a transport error", async () => {
    let n = 0;
    const mf = mockFetch({ body: OPEN + evtFrame(1) });
    const c = new NimbioClient(TEST_KEY, {
      fetch: (url, init) => {
        n += 1;
        if (n === 1) return Promise.reject(new TypeError("fetch failed"));
        return mf.fetchImpl(url, init);
      },
    });
    const got = await collect(c.community.streamEvents(), 1);
    expect((got[0] as StreamEvent).id).toBe("e1");
    expect(n).toBe(2);
  });

  it("returns cleanly when the signal aborts", async () => {
    const controller = new AbortController();
    const { client: c } = client({ body: OPEN + evtFrame(1) });
    const got: StreamMessage[] = [];
    for await (const msg of c.community.streamEvents({ signal: controller.signal })) {
      got.push(msg);
      controller.abort(); // stop after the first event
    }
    expect(got.length).toBe(1);
  });
});
