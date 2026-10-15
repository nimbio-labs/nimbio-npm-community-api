/**
 * Coverage for the account-scoped directory-call surface:
 * `account.streamEvents()` (typed parse, filter, resume, error mapping) and
 * `account.directoryCalls()` / `iterDirectoryCalls()` (paging on `before`).
 */
import { describe, expect, it } from "vitest";
import {
  NimbioClient,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  BadRequestError,
  parseAccountEvent,
} from "../src/index.js";
import type {
  AccountStreamEvent,
  AccountStreamMessage,
  DirectoryCall,
} from "../src/index.js";
import { mockFetch, TEST_KEY, type MockResponseSpec } from "./helpers.js";

function client(responses: MockResponseSpec | MockResponseSpec[]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const RINGING = {
  directory_call_id: "dc1",
  placed_at: "2026-10-15T12:00:00+00:00",
  answer_window_ends_at: "2026-10-15T12:09:00+00:00",
  community: { id: 123, name: "Oak Grove" },
  latch: { id: "L1", name: "Front Gate" },
  called: { type: "home", home_id: 7, home_name: "Unit 4" },
  arrived_via: "nfc",
  caller: null,
};

const ENDED = {
  directory_call_id: "dc1",
  outcome: "opened",
  ended_at: "2026-10-15T12:02:00+00:00",
  ended_by: "caller",
  answered_at: "2026-10-15T12:00:30+00:00",
  answered_by_you: false,
  answered_by_first_name: "Sam",
  declined_by_you: true,
  opened_by_you: false,
};

function frame(id: string, event: string, data: Record<string, unknown>): string {
  const envelope = JSON.stringify({
    event,
    id,
    account_id: "acct-1",
    occurred_at: "2026-10-15T12:00:00+00:00",
    data,
  });
  return `id: ${id}\nevent: ${event}\ndata: ${envelope}\n\n`;
}

const OPEN = ": stream open\n\n";

async function collect(
  gen: AsyncGenerator<AccountStreamMessage>,
  n = Infinity,
): Promise<AccountStreamMessage[]> {
  const out: AccountStreamMessage[] = [];
  for await (const msg of gen) {
    out.push(msg);
    if (out.length >= n) break;
  }
  return out;
}

describe("parseAccountEvent", () => {
  it("types a ringing event with an anonymous caller", () => {
    const e = parseAccountEvent({
      event: "directory_call.ringing",
      id: "e1",
      account_id: "acct-1",
      occurred_at: "t",
      data: RINGING,
    });
    expect(e?.event).toBe("directory_call.ringing");
    if (e?.event !== "directory_call.ringing") throw new Error("narrowing");
    expect(e.accountId).toBe("acct-1");
    expect(e.data).toMatchObject({
      directoryCallId: "dc1",
      answerWindowEndsAt: "2026-10-15T12:09:00+00:00",
      community: { id: 123, name: "Oak Grove" },
      latch: { id: "L1", name: "Front Gate" },
      called: { type: "home", homeId: 7, homeName: "Unit 4" },
      arrivedVia: "nfc",
      caller: null,
    });
  });

  it("parses a full and a partial signed-in caller, and a null latch", () => {
    const full = parseAccountEvent({
      event: "directory_call.ringing",
      data: { ...RINGING, caller: { signed_in: true, first_name: "Ana", last_name: "Ruiz" } },
    });
    expect(full?.data).toMatchObject({
      caller: { signedIn: true, firstName: "Ana", lastName: "Ruiz" },
    });
    const partial = parseAccountEvent({
      event: "directory_call.ringing",
      data: { ...RINGING, latch: null, caller: { signed_in: true, first_name: "Ana" } },
    });
    expect(partial?.data).toMatchObject({
      latch: null,
      caller: { signedIn: true, firstName: "Ana", lastName: null },
    });
  });

  it("types an ended event and keeps an unknown outcome", () => {
    const e = parseAccountEvent({ event: "directory_call.ended", data: ENDED });
    if (e?.event !== "directory_call.ended") throw new Error("narrowing");
    expect(e.data).toMatchObject({
      outcome: "opened",
      endedBy: "caller",
      answeredByFirstName: "Sam",
      declinedByYou: true,
      openedByYou: false,
    });
    const odd = parseAccountEvent({
      event: "directory_call.ended",
      data: { ...ENDED, outcome: "voicemail", ended_by: "carrier" },
    });
    expect(odd?.data).toMatchObject({ outcome: "voicemail", endedBy: "carrier" });
  });

  it("returns null for an event type this client predates", () => {
    expect(parseAccountEvent({ event: "directory_call.transferred", data: {} })).toBeNull();
    expect(parseAccountEvent("junk")).toBeNull();
  });
});

describe("account.streamEvents", () => {
  it("yields typed events from the account stream", async () => {
    const { client: c, calls } = client({
      body: OPEN + frame("e1", "directory_call.ringing", RINGING) +
        frame("e2", "directory_call.ended", ENDED),
    });
    const got = (await collect(
      c.account.streamEvents({ reconnect: false }),
    )) as AccountStreamEvent[];
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/account/events/stream");
    expect(got.map((m) => m.id)).toEqual(["e1", "e2"]);
    expect(got[0]!.parsed?.event).toBe("directory_call.ringing");
    expect(got[1]!.parsed?.data).toMatchObject({ outcome: "opened" });
    expect(got[1]!.payload).toMatchObject({ outcome: "opened" });
  });

  it("passes unknown event types through with parsed: null", async () => {
    const { client: c } = client({ body: frame("e9", "directory_call.transferred", {}) });
    const [msg] = (await collect(
      c.account.streamEvents({ reconnect: false }),
    )) as AccountStreamEvent[];
    expect(msg).toMatchObject({ kind: "event", type: "directory_call.transferred", parsed: null });
  });

  it("falls back to the SSE event line when the envelope omits `event`", async () => {
    const body = `id: e1\nevent: directory_call.ended\ndata: ${JSON.stringify({ id: "e1", data: ENDED })}\n\n`;
    const { client: c } = client({ body });
    const [msg] = (await collect(
      c.account.streamEvents({ reconnect: false }),
    )) as AccountStreamEvent[];
    expect(msg!.parsed?.event).toBe("directory_call.ended");
  });

  it("sends the events filter and the resume cursor", async () => {
    const { client: c, calls } = client({ body: OPEN });
    await collect(
      c.account.streamEvents({
        events: ["directory_call.ringing"],
        lastEventId: "e7",
        reconnect: false,
      }),
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("events")).toBe("directory_call.ringing");
    expect(url.searchParams.get("last_event_id")).toBe("e7");
  });

  it("reconnects from the last seen id and passes resets through", async () => {
    const reset = 'event: stream.reset\ndata: {"reason":"replay_unavailable"}\n\n';
    const { client: c, calls } = client([
      { body: frame("e1", "directory_call.ringing", RINGING) },
      { body: reset + frame("e5", "directory_call.ended", ENDED) },
    ]);
    const got = await collect(c.account.streamEvents(), 3);
    expect(got[0]).toMatchObject({ kind: "event", id: "e1" });
    expect(got[1]).toEqual({ kind: "reset", reason: "replay_unavailable" });
    expect(got[2]).toMatchObject({ kind: "event", id: "e5" });
    expect(new URL(calls[1]!.url).searchParams.get("last_event_id")).toBe("e1");
  });

  it.each([
    [403, "not_account_key", PermissionDeniedError],
    [404, "feature_not_enabled", NotFoundError],
    [429, "stream_limit", RateLimitError],
    [400, "unknown_event_type", BadRequestError],
  ])("maps HTTP %i %s", async (status, code, cls) => {
    const { client: c } = client({ status, body: { error: { code, message: "x" } } });
    const err = await c.account.streamEvents().next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(cls);
    expect((err as { code: string }).code).toBe(code);
  });
});

describe("account.directoryCalls", () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    ...RINGING,
    ...ENDED,
    directory_call_id: id,
    state: "ended",
    ...extra,
  });

  it("reads one page with limit/before and parses the rows", async () => {
    const { client: c, calls } = client({
      body: {
        calls: [
          row("dc2", { state: "ringing", outcome: null, ended_at: null, ended_by: null }),
          row("dc1", { outcome: "missed", caller: { signed_in: true, first_name: null, last_name: "Ruiz" } }),
        ],
        next_before: "2026-10-14T00:00:00+00:00",
      },
    });
    const page = await c.account.directoryCalls({ limit: 2, before: "2026-10-16T00:00:00Z" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/account/directory-calls");
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.get("before")).toBe("2026-10-16T00:00:00Z");
    expect(page.nextBefore).toBe("2026-10-14T00:00:00+00:00");
    expect(page.calls[0]).toMatchObject({ directoryCallId: "dc2", state: "ringing", outcome: null, endedBy: null });
    expect(page.calls[1]).toMatchObject({
      outcome: "missed",
      caller: { signedIn: true, firstName: null, lastName: "Ruiz" },
      called: { type: "home", homeId: 7 },
    });
  });

  it("sends no query string by default", async () => {
    const { client: c, calls } = client({ body: { calls: [], next_before: null } });
    const page = await c.account.directoryCalls();
    expect(calls[0]!.url).not.toContain("?");
    expect(page).toMatchObject({ calls: [], nextBefore: null });
  });

  it("iterDirectoryCalls stops when the cursor does not advance", async () => {
    const stuck = { body: { calls: [row("dc1")], next_before: "c1" } };
    const { client: c, calls } = client([stuck, stuck, stuck]);
    const ids: (string | null)[] = [];
    for await (const call of c.account.iterDirectoryCalls({ before: "c1" }) as AsyncGenerator<DirectoryCall>) {
      ids.push(call.directoryCallId);
    }
    expect(ids).toEqual(["dc1"]);
    expect(calls).toHaveLength(1);
  });

  it("iterDirectoryCalls follows next_before to the end", async () => {
    const { client: c, calls } = client([
      { body: { calls: [row("dc3"), row("dc2")], next_before: "c2" } },
      { body: { calls: [row("dc1")], next_before: null } },
    ]);
    const ids: (string | null)[] = [];
    for await (const call of c.account.iterDirectoryCalls({ limit: 2 }) as AsyncGenerator<DirectoryCall>) {
      ids.push(call.directoryCallId);
    }
    expect(ids).toEqual(["dc3", "dc2", "dc1"]);
    expect(new URL(calls[1]!.url).searchParams.get("before")).toBe("c2");
    expect(new URL(calls[1]!.url).searchParams.get("limit")).toBe("2");
  });

  it("maps feature_not_enabled to NotFoundError", async () => {
    const { client: c } = client({
      status: 404,
      body: { error: { code: "feature_not_enabled", message: "x" } },
    });
    await expect(c.account.directoryCalls()).rejects.toBeInstanceOf(NotFoundError);
  });
});
