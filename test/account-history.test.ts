/**
 * Coverage for account open history: `account.history()` (row parsing, query
 * forwarding, error mapping) and `account.iterHistory()` (paging on `page`).
 */
import { describe, expect, it } from "vitest";
import {
  APIError,
  BadRequestError,
  NimbioClient,
  NotFoundError,
  PermissionDeniedError,
} from "../src/index.js";
import type { AccountOpen } from "../src/index.js";
import { mockFetch, TEST_KEY, type MockResponseSpec } from "./helpers.js";

function client(responses: MockResponseSpec | MockResponseSpec[]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const WINDOW = { from: "2026-07-17T15:00:00+00:00", to: "2026-10-15T15:00:00+00:00" };

const MINE = {
  id: 90210417,
  opened_at: "2026-10-15T08:02:11-07:00",
  key: { id: "K1", name: "Front Gate Key" },
  latch: { id: "L1", name: "Front Gate" },
  opened_by: { is_you: true, name: null },
  guest_link: null,
  open_type: "open",
  result: "opened",
  open_type_id: 1,
  result_id: 1,
};

const SHARED = {
  ...MINE,
  id: 90210300,
  opened_at: "2026-10-14T18:30:00-07:00",
  opened_by: { is_you: false, name: "Sam Lee" },
};

const GUEST = {
  ...MINE,
  id: 90210201,
  opened_at: "2026-10-13T10:00:00-07:00",
  opened_by: { is_you: false, name: "Party Saturday" },
  guest_link: { id: 42, label: "Party Saturday" },
  open_type: "teleportation", // a name this client does not know
  open_type_id: 99,
};

function page(opens: unknown[], n = 0, hasMore = false): MockResponseSpec {
  return { body: { page: n, has_more: hasMore, ...WINDOW, opens } };
}

function params(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

async function collect(gen: AsyncGenerator<AccountOpen>): Promise<AccountOpen[]> {
  const out: AccountOpen[] = [];
  for await (const row of gen) out.push(row);
  return out;
}

describe("account.history", () => {
  it("parses your own open, someone else's, and a guest-link open", async () => {
    const { client: c } = client(page([MINE, SHARED, GUEST], 2, true));
    const result = await c.account.history();
    expect(result).toMatchObject({ page: 2, hasMore: true, dateFrom: WINDOW.from, dateTo: WINDOW.to });
    const [mine, shared, guest] = result.opens;
    expect(mine).toMatchObject({
      id: 90210417,
      openedAt: "2026-10-15T08:02:11-07:00",
      key: { id: "K1", name: "Front Gate Key" },
      latch: { id: "L1", name: "Front Gate" },
      openedBy: { isYou: true, name: null },
      guestLink: null,
      openType: "open",
      result: "opened",
      openTypeId: 1,
      resultId: 1,
    });
    expect(mine!.raw).toEqual(MINE);
    expect(shared!.openedBy).toEqual({ isYou: false, name: "Sam Lee" });
    expect(guest).toMatchObject({
      guestLink: { id: 42, label: "Party Saturday" },
      openType: "teleportation",
      openTypeId: 99,
    });
  });

  it("tolerates a malformed row and an empty body", async () => {
    const { client: c } = client([
      { body: { opens: [{ id: "abc", key: "nope", guest_link: "x", open_type_id: "abc" }] } },
      { body: {} },
    ]);
    const [row] = (await c.account.history()).opens;
    expect(row).toMatchObject({
      id: null,
      key: { id: null, name: null },
      openedBy: { isYou: false, name: null },
      guestLink: null,
      openTypeId: null,
    });
    expect(await c.account.history()).toMatchObject({
      opens: [],
      page: null,
      hasMore: false,
      dateFrom: null,
    });
  });

  it("sends only page by default", async () => {
    const { client: c, calls } = client(page([]));
    await c.account.history();
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/account/history");
    expect(params(calls[0]!.url)).toEqual({ page: "0" });
  });

  it("forwards from, to, key_id and page", async () => {
    const { client: c, calls } = client(page([], 3));
    await c.account.history({
      from: "2026-10-01",
      to: "2026-10-15T00:00:00Z",
      keyId: "K1",
      page: 3,
    });
    expect(params(calls[0]!.url)).toEqual({
      from: "2026-10-01",
      to: "2026-10-15T00:00:00Z",
      key_id: "K1",
      page: "3",
    });
  });

  it.each([
    [404, "key_not_found", NotFoundError],
    [404, "feature_not_enabled", NotFoundError],
    [403, "not_account_key", PermissionDeniedError],
    [403, "oauth_not_permitted", PermissionDeniedError],
    [400, "invalid_window", BadRequestError],
  ])("maps %i %s", async (status, code, cls) => {
    const { client: c } = client({ status, body: { error: { code, message: code } } });
    const err = await c.account.history().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(cls);
    expect((err as APIError).code).toBe(code);
  });

  it("surfaces a bad datetime as a 422 APIError", async () => {
    const { client: c } = client({
      status: 422,
      body: { error: { code: "invalid_datetime", message: "bad from" } },
    });
    const err = await c.account.history({ from: "yesterday" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err).toMatchObject({ status: 422, code: "invalid_datetime" });
  });
});

describe("account.iterHistory", () => {
  it("walks pages and pins the window the first page echoed", async () => {
    const { client: c, calls } = client([page([MINE, SHARED], 0, true), page([GUEST], 1, false)]);
    const rows = await collect(c.account.iterHistory({ keyId: "K1" }));
    expect(rows.map((r) => r.id)).toEqual([90210417, 90210300, 90210201]);
    expect(rows.map((r) => r.openedAt)).toEqual([
      MINE.opened_at,
      SHARED.opened_at,
      GUEST.opened_at,
    ]);
    expect(calls).toHaveLength(2);
    expect(params(calls[0]!.url)).toEqual({ page: "0", key_id: "K1" });
    expect(params(calls[1]!.url)).toEqual({ page: "1", key_id: "K1", ...WINDOW });
  });

  it("keeps a caller's window and honours startPage", async () => {
    const { client: c, calls } = client([page([MINE], 4, true), page([MINE], 5, false)]);
    await collect(c.account.iterHistory({ from: "2026-10-01", startPage: 4 }));
    expect(params(calls[0]!.url)).toEqual({ page: "4", from: "2026-10-01" });
    expect(params(calls[1]!.url)).toEqual({ page: "5", from: "2026-10-01", to: WINDOW.to });
  });

  it("stops on an empty page even if has_more is true", async () => {
    const { client: c, calls } = client([page([], 0, true), page([], 1, true)]);
    expect(await collect(c.account.iterHistory())).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("does not pin a window the server did not echo", async () => {
    const { client: c, calls } = client([
      { body: { page: 0, has_more: true, opens: [MINE] } },
      { body: { page: 1, has_more: false, opens: [] } },
    ]);
    await collect(c.account.iterHistory());
    expect(params(calls[1]!.url)).toEqual({ page: "1" });
  });
});
