import { describe, expect, it } from "vitest";
import {
  parseMe,
  parseHealth,
  parseLatch,
  parseGateStatus,
  parseMember,
  parseMembers,
  parseCommunityKey,
  parseCommunityKeys,
  parseKeyStatuses,
  parseOpenResult,
  parseWriteResult,
  parseAccessLogPage,
  parseMemberAccessLogPage,
  parseGateStatusLogPage,
} from "../src/models.js";

describe("model parsers", () => {
  it("parses Me and preserves unknown fields on raw", () => {
    const me = parseMe({
      account_id: "acct_1",
      key: { api_key_id: "k1", mode: "test", minute_count: 3 },
      future_field: "kept",
    });
    expect(me.accountId).toBe("acct_1");
    expect(me.key.apiKeyId).toBe("k1");
    expect(me.key.mode).toBe("test");
    expect(me.key.minuteCount).toBe(3);
    expect(me.raw.future_field).toBe("kept");
  });

  it("tolerates empty / non-object payloads", () => {
    expect(parseMe(null).accountId).toBeNull();
    expect(parseMe(undefined).key.apiKeyId).toBeNull();
    expect(parseHealth("nope").ok).toBe(false);
    expect(parseGateStatus({}).latches).toEqual([]);
  });

  it("parses Health", () => {
    const h = parseHealth({ ok: true, wamp: "connected" });
    expect(h.ok).toBe(true);
    expect(h.wamp).toBe("connected");
  });

  it("parses a Latch with id/name fallbacks", () => {
    const l = parseLatch({ id: "L1", name: "Front", status: "closed", offline: 1 });
    expect(l.latchId).toBe("L1");
    expect(l.latchName).toBe("Front");
    expect(l.offline).toBe(true);
  });

  it("derives Member.fullName", () => {
    expect(parseMember({ first_name: "Ada", last_name: "Lovelace" }).fullName).toBe(
      "Ada Lovelace",
    );
    expect(parseMember({ first_name: "Cher" }).fullName).toBe("Cher");
    expect(parseMember({}).fullName).toBe("");
  });

  it("parses Members buckets", () => {
    const m = parseMembers({
      accepted: [{ account_community_id: 1 }],
      unaccepted: [{ account_community_id: 2 }],
      removed: [],
    });
    expect(m.accepted).toHaveLength(1);
    expect(m.unaccepted[0]!.accountCommunityId).toBe(2);
    expect(m.removed).toEqual([]);
  });

  it("parses CommunityKey with nested structures", () => {
    const k = parseCommunityKey({
      id: "key_1",
      name: "Master",
      disabled: false,
      is_favorite: true,
      sharing: { max: 3 },
      latches: [{ id: "L1" }],
    });
    expect(k.id).toBe("key_1");
    expect(k.isFavorite).toBe(true);
    expect(k.sharing.max).toBe(3);
    expect(k.latches[0]!.id).toBe("L1");
    expect(k.expiry).toEqual({});
  });

  it("parses the keys() list envelope", () => {
    const keys = parseCommunityKeys({ keys: [{ id: "a" }, { id: "b" }] });
    expect(keys.map((k) => k.id)).toEqual(["a", "b"]);
    expect(parseCommunityKeys({})).toEqual([]);
  });

  it("parses KeyStatuses", () => {
    const ks = parseKeyStatuses({ keys: [{ id: "a" }], hold_opens: { L1: true } });
    expect(ks.keys).toHaveLength(1);
    expect(ks.holdOpens.L1).toBe(true);
  });

  it("computes OpenResult.opened / simulated", () => {
    const opened = parseOpenResult({ result: "opened", key_log_id: 99, latch_id: "L1" });
    expect(opened.opened).toBe(true);
    expect(opened.simulated).toBe(false);
    expect(opened.keyLogId).toBe(99);

    const sim = parseOpenResult({ result: "simulated" });
    expect(sim.simulated).toBe(true);
    expect(sim.opened).toBe(false);
  });

  it("computes WriteResult.simulated and keeps extras on raw", () => {
    const w = parseWriteResult({ result: "member_added", account_community_id: 7 });
    expect(w.result).toBe("member_added");
    expect(w.simulated).toBe(false);
    expect(w.raw.account_community_id).toBe(7);
    expect(parseWriteResult({ result: "simulated" }).simulated).toBe(true);
  });

  it("parses log pages with from/to and has_more", () => {
    const page = parseAccessLogPage({
      logs: [{ datetime: "2026-01-01", key_name: "Master" }],
      page: 0,
      has_more: true,
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(page.logs).toHaveLength(1);
    expect(page.logs[0]!.keyName).toBe("Master");
    expect(page.hasMore).toBe(true);
    expect(page.dateFrom).toBe("2026-01-01");
    expect(page.dateTo).toBe("2026-03-31");

    const mpage = parseMemberAccessLogPage({
      logs: [],
      account_community_id: 4,
      window: "last_30",
      truncated: true,
    });
    expect(mpage.accountCommunityId).toBe(4);
    expect(mpage.truncated).toBe(true);

    const gpage = parseGateStatusLogPage({
      logs: [{ latch_name: "Front", sense_line: 2, state: "open" }],
      page: 1,
      has_more: false,
    });
    expect(gpage.logs[0]!.senseLine).toBe(2);
    expect(gpage.hasMore).toBe(false);
  });
});
