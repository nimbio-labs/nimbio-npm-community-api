import { describe, expect, it } from "vitest";
import { NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY, LIVE_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

describe("community writes", () => {
  it("open() posts note + idempotency and URL-encodes the latch id", async () => {
    const { client: c, calls } = client({
      body: { result: "simulated", request_id: "req_1" },
    });
    const res = await c.community.open("latch/1", {
      note: "front gate",
      idempotencyKey: "idem-1",
    });

    expect(res.simulated).toBe(true);
    expect(res.requestId).toBe("req_1");
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.nimbio.com/v1/community/latches/latch%2F1/open");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toEqual({ note: "front gate", idempotency_key: "idem-1" });
  });

  it("open() with a live key returns opened", async () => {
    const mf = mockFetch({ body: { result: "opened", key_log_id: 5, latch_id: "L1" } });
    const c = new NimbioClient(LIVE_KEY, { fetch: mf.fetchImpl });
    const res = await c.community.open("L1");
    expect(res.opened).toBe(true);
    expect(res.keyLogId).toBe(5);
    expect(mf.calls[0]!.body).toEqual({});
  });

  it("message() posts the message body", async () => {
    const { client: c, calls } = client({ body: { result: "sent" } });
    const res = await c.community.message("hello all");
    expect(res.result).toBe("sent");
    expect(calls[0]!.url).toBe("https://api.nimbio.com/v1/community/messages");
    expect(calls[0]!.body).toEqual({ message: "hello all" });
  });

  it("addMember() posts phone_number + key_ids", async () => {
    const { client: c, calls } = client({
      body: { result: "member_added", account_community_id: 7 },
    });
    const res = await c.community.addMember("+15551234567", ["K1", "K2"]);
    expect(res.result).toBe("member_added");
    expect(res.raw.account_community_id).toBe(7);
    expect(calls[0]!.body).toEqual({ phone_number: "+15551234567", key_ids: ["K1", "K2"] });
  });

  it("grantKeys() targets the member and posts key_ids", async () => {
    const { client: c, calls } = client({ body: { result: "keys_granted" } });
    await c.community.grantKeys(42, ["K1"]);
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/42/grant-keys",
    );
    expect(calls[0]!.body).toEqual({ key_ids: ["K1"] });
  });

  it("revokeKeys() defaults remove_member to false and honors the flag", async () => {
    const noRemove = client({ body: { result: "keys_revoked" } });
    await noRemove.client.community.revokeKeys(42, ["K1"]);
    expect(noRemove.calls[0]!.body).toEqual({ key_ids: ["K1"], remove_member: false });

    const withRemove = client({ body: { result: "member_removed" } });
    await withRemove.client.community.revokeKeys(42, ["K1"], { removeMember: true });
    expect(withRemove.calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/42/revoke-keys",
    );
    expect(withRemove.calls[0]!.body).toEqual({ key_ids: ["K1"], remove_member: true });
  });

  it("setKeysDisabled() posts the disabled flag", async () => {
    const { client: c, calls } = client({ body: { result: "keys_disabled" } });
    await c.community.setKeysDisabled(42, ["K1"], true);
    expect(calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/42/keys-disabled",
    );
    expect(calls[0]!.body).toEqual({ key_ids: ["K1"], disabled: true });
  });
});

describe("community logs", () => {
  it("memberAccessLogs() defaults the window and passes it as a query param", async () => {
    const dflt = client({ body: { logs: [], account_community_id: 42 } });
    await dflt.client.community.memberAccessLogs(42);
    expect(dflt.calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/members/42/access-logs?window=last_30",
    );

    const custom = client({ body: { logs: [] } });
    await custom.client.community.memberAccessLogs(42, { window: "30_60" });
    expect(custom.calls[0]!.url).toContain("window=30_60");
  });

  it("accessLog() and gateStatusLog() send the page query param", async () => {
    const a = client({ body: { logs: [], page: 2, has_more: false } });
    await a.client.community.accessLog({ page: 2 });
    expect(a.calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/access-logs?page=2",
    );

    const g = client({ body: { logs: [], page: 0, has_more: false } });
    await g.client.community.gateStatusLog();
    expect(g.calls[0]!.url).toBe(
      "https://api.nimbio.com/v1/community/gate-status-log?page=0",
    );
  });
});

describe("pagination iterators", () => {
  it("iterAccessLog walks pages until has_more is false", async () => {
    const { client: c, calls } = client([
      { body: { logs: [{ key_name: "A" }], page: 0, has_more: true } },
      { body: { logs: [{ key_name: "B" }], page: 1, has_more: false } },
    ]);

    const names: (string | null)[] = [];
    for await (const row of c.community.iterAccessLog()) {
      names.push(row.keyName);
    }
    expect(names).toEqual(["A", "B"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("page=1");
  });

  it("iterGateStatusLog walks pages and honors startPage", async () => {
    const { client: c, calls } = client([
      { body: { logs: [{ latch_name: "Front" }], page: 5, has_more: true } },
      { body: { logs: [{ latch_name: "Back" }], page: 6, has_more: false } },
    ]);

    const rows = [];
    for await (const row of c.community.iterGateStatusLog({ startPage: 5 })) {
      rows.push(row.latchName);
    }
    expect(rows).toEqual(["Front", "Back"]);
    expect(calls[0]!.url).toContain("page=5");
    expect(calls[1]!.url).toContain("page=6");
  });
});
