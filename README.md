# @nimbio/community-api

Official TypeScript/JavaScript client for the **Nimbio community API** ([api.nimbio.com](https://api.nimbio.com)).

Manage a Nimbio community programmatically: read gate status, open gates, add and
manage members and their keys, keep the homes roster and community settings in
step with your own system of record, send community messages, and pull access
logs — from Node, the browser, Deno, Bun, or edge runtimes, with full type
definitions.

```bash
npm install @nimbio/community-api
# or: pnpm add @nimbio/community-api / yarn add @nimbio/community-api / bun add @nimbio/community-api
```

- ✅ **Fully typed** — TypeScript-first, ships `.d.ts`; every response is a typed object with autocomplete.
- ✅ **Promise-based** — one `async`/`await` API. Works the same in Node, browsers, Deno, Bun, and edge.
- ✅ **Zero runtime dependencies** — built on the platform `fetch`.
- ✅ **ESM + CommonJS** — `import` and `require` both work.
- ✅ **Test vs live** — inferred automatically from your API key.
- ✅ **Built-in retries**, a clean error hierarchy, and log pagination helpers.

> **Requirements:** Node.js 18+ (for global `fetch`), or any runtime with a
> `fetch` global. On older runtimes, pass your own via the `fetch` option.

---

## Quickstart

```ts
import { NimbioClient } from "@nimbio/community-api";

const client = new NimbioClient("nimbio_test_your_key_here");

// Who am I?
const me = await client.me();
console.log(me.accountId);

// Read gate status
for (const latch of (await client.community.gateStatus()).latches) {
  console.log(latch.latchName, "->", latch.status);
}

// Open a gate. A test key simulates; a live key fires the gate.
const result = await client.community.open("latch-id-123", { note: "front gate" });
console.log(result.result); // "simulated" (test key) or "opened" (live key)
```

CommonJS is identical, just with `require`:

```js
const { NimbioClient } = require("@nimbio/community-api");
```

### "Sync or async?"

JavaScript has no idiomatic blocking HTTP, so **every method returns a Promise** —
use `await` (or `.then()`). There is a single client class; there is no separate
"async client" because there is nothing else to be.

---

## Configuration

```ts
new NimbioClient("nimbio_test_...");                              // explicit key
new NimbioClient();                                              // reads NIMBIO_API_KEY
new NimbioClient("nimbio_live_...", { environment: "dev" });     // staging host
new NimbioClient("nimbio_test_...", { baseUrl: "http://localhost:8000" });
```

**Options** (second argument):

| Option           | Type                       | Default   | Meaning |
|------------------|----------------------------|-----------|---------|
| `environment`    | `"prod" \| "dev" \| "local"` | `"prod"` | Which deployment. Ignored if `baseUrl` is set. |
| `baseUrl`        | `string`                   | —         | Override the URL entirely. |
| `timeout`        | `number \| null`           | `30`      | Read timeout in **seconds**. `null` disables it. |
| `maxRetries`     | `number`                   | `2`       | Automatic retries for 429/5xx. |
| `defaultHeaders` | `Record<string,string>`    | `{}`      | Extra headers on every request. |
| `fetch`          | `typeof fetch`             | global    | Custom `fetch` (testing, proxies, older runtimes). |
| `cache`          | `boolean`                  | `true`    | Conditional GETs (ETag / `If-None-Match`). See [Conditional requests](#conditional-requests-etag-caching). |
| `cacheSize`      | `number`                   | `256`     | Max cached ETags (LRU). `0` disables the cache. |

**Environments:** `prod` → `api.nimbio.com`, `dev` → `api.nimbio.dev`,
`local` → `localhost:8000`.

**Environment variables** (used when the matching argument is omitted):
`NIMBIO_API_KEY`, `NIMBIO_ENV`, `NIMBIO_BASE_URL`.

### Test vs live is the **key**, not a flag

A `nimbio_test_*` key never fires a gate or sends a real message — it runs the
full pipeline (auth, rate limit, scope, validation) and returns a simulated
result. A `nimbio_live_*` key performs the real action. Both work against any
environment. Check which you hold — no network call — with `client.mode`:

```ts
if (client.mode !== "test") throw new Error("refusing to run live");
```

### Conditional requests (ETag caching)

**On by default. No code changes needed to benefit.**

Most GETs on this API answer **304 Not Modified** when nothing has changed since
you last read them. The client remembers each response's `ETag`, sends it back
as `If-None-Match` on the next identical GET, and rebuilds the result from what
it stored when the server says "unchanged". A 304 and a 200 are
indistinguishable to your code — same types, same values, a fresh object every
time.

```ts
const client = new NimbioClient("nimbio_live_...");

for (;;) {
  const status = await client.community.gateStatus(); // 200 first, then 304s
  render(status);
  await sleep(30_000);
}

client.cacheStats; // { hits: 119, misses: 1, entries: 1 }
```

**What you save — and what you don't:**

- ✅ **Your monthly quota.** A 304 is not billed against it. The API declines to
  charge for data it did not send, so a poller that mostly sees unchanged data
  mostly stops consuming quota.
- ✅ **Bandwidth and parse time.** A 304 has no body.
- ❌ **The per-minute rate limit.** A 304 still counts. It is a real request that
  did real work on the server, and that limit exists to protect it — **caching
  is not permission to poll faster.**
- ❌ **Latency.** The API derives the ETag from the response it would have sent,
  so the upstream work still happens. The round trip is the same length.

**Why it is safe to leave on:**

- **It can never serve stale data.** `Cache-Control: max-age` is deliberately
  ignored; every read still asks the server, and a stored body is only ever used
  when the server itself confirms nothing changed.
- **Writes need no invalidation.** A `POST`/`PATCH`/`DELETE` cannot strand a
  stale entry, because the next read revalidates regardless.
- **It is bounded.** LRU, 256 entries by default (`cacheSize`), so a long-lived
  polling client cannot leak memory.
- **It is single-tenant.** The cache lives on the client instance and a client
  holds exactly one API key, so entries can never cross keys.
- **It is opportunistic.** The client caches whatever carries an `ETag` — it
  ships no hardcoded list of cacheable routes, so it cannot drift from the API.

Only GETs are cached; writes and the SSE event stream never are. A few routes
are deliberately non-cacheable server-side and simply never produce a hit —
`/v1/me` (its payload *is* your live usage counters, so an ETag could never
match), the event stream, and the API call log.

Turn it off with `{ cache: false }` (or `{ cacheSize: 0 }`); `client.clearCache()`
drops stored entries without disabling anything.

---

## The whole API

```ts
const client = new NimbioClient("nimbio_test_...");

// Account
await client.me();                       // -> Me       (accountId, key usage…)
await client.health();                   // -> Health   (ok, wamp) — never throws on 503
client.mode;                             // -> "test" | "live" | null (no network)

// Reads (community-scoped key required)
await client.community.info();           // -> CommunityInfo — call this first
await client.community.gateStatus();     // -> GateStatus   (.latches)
await client.community.members();        // -> Members      (.accepted/.unaccepted/.removed)
await client.community.membersPage({ bucket: "accepted", page: 1, size: 100, search: "555" });
                                         // -> MembersPage  (paged + searchable)
await client.community.member(ACCOUNT_COMMUNITY_ID);        // -> MemberDetail
await client.community.messages({ limit: 50, offset: 0 });  // -> MessagePage (sent messages)
await client.community.keyStatuses();    // -> KeyStatuses  (.keys, .holdOpens)
await client.community.keys();           // -> CommunityKey[]

// Writes (test key = simulated, live key = real)
await client.community.open("LATCH_ID", { note: "…", idempotencyKey: "…" }); // -> OpenResult
await client.community.message("text");                                       // -> WriteResult
await client.community.addMember("+15551234567", ["KEY_ID"]);                 // -> WriteResult
await client.community.grantKeys(ACCOUNT_COMMUNITY_ID, ["KEY_ID"]);           // -> WriteResult
await client.community.revokeKeys(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], { removeMember: false }); // -> WriteResult
await client.community.setKeysDisabled(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], true);               // -> WriteResult
await client.community.updateKey("KEY_ID", { name: "Pool Key", disabled: true });             // -> KeyUpdateResult
await client.community.approveMember(ACCOUNT_COMMUNITY_ID, ["KEY_ID"]);                       // -> WriteResult

// Bulk writes — 207 Multi-Status, ≤100 items, one result per item in order
await client.community.bulkAddMembers([{ phoneNumber: "+15551234567", keyIds: ["KEY_ID"] }]);
await client.community.bulkGrantKeys([{ accountCommunityId: 4021, keyIds: ["KEY_ID"] }]);
await client.community.bulkRevokeKeys([{ accountCommunityId: 4021, keyIds: ["KEY_ID"] }]);
await client.community.bulkSetKeysDisabled([{ accountCommunityId: 4021, keyIds: ["KEY_ID"] }], true);

// Hold opens — times are the LATCH's local time, never UTC
await client.community.holdOpens();                        // -> HoldOpens (per latch, incl. timezone)
await client.community.setHoldOpen("LATCH_ID", true);      // manual toggle
await client.community.addHoldOpenEvent("LATCH_ID", { start: "2026-08-01 09:00", end: "2026-08-01 10:00" });
await client.community.removeHoldOpenEvent("LATCH_ID", "EVENT_ID");
await client.community.addHoldOpenRecurring("LATCH_ID", "MTWHF", { startTime: "08:00", endTime: "17:00" });
await client.community.updateHoldOpenRecurring("LATCH_ID", "TEMPORAL_DATE_ID", { clearTimes: true });
await client.community.removeHoldOpenRecurring("LATCH_ID", "TEMPORAL_DATE_ID");
await client.community.setHoldOpenDisabledUntil("LATCH_ID", "2026-12-25 23:59"); // null resumes

// Webhooks + their delivery attempts
await client.community.webhooks();
await client.community.createWebhook("https://example.com/hook", ["open.succeeded"]);
await client.community.updateWebhook("WEBHOOK_ID", { active: true });
await client.community.webhookDeliveries("WEBHOOK_ID", { limit: 50 });   // -> WebhookDelivery[]
await client.community.retryFailedDeliveries("WEBHOOK_ID", { limit: 100 });
await client.community.replayDelivery("WEBHOOK_ID", "DELIVERY_ID");

// Access schedules — limit WHEN the community's keys may open their gates
await client.community.keySchedules();              // -> KeySchedules (.keys, .blocked)
                                                    //    the community's OWN key(s) only
await client.community.keySchedule("COMMUNITY_KEY_ID");       // -> KeySchedule
await client.community.setKeySchedule("COMMUNITY_KEY_ID", [   // replaces the WHOLE schedule
  { daysOfTheWeek: "MTWHF", startTime: "06:00", endTime: "18:00" },
]);
await client.community.setKeySchedule("COMMUNITY_KEY_ID", []); // [] = always allowed

// Community settings — `readOnly` tells you which features are provisioned
await client.community.settings();                  // -> CommunitySettings
await client.community.updateSettings({             // partial; all-or-nothing
  allowDirectoryViewing: false,
  memberTermCustom: "Tenant",
  memberTermCustomPlural: "Tenants",
});

// Homes / units roster
await client.community.homes();                     // -> Home[]  (includeHidden defaults to TRUE)
await client.community.addHome("12 Elm St, Unit 3");           // -> HomeWriteResult
await client.community.home("HOME_ID");                        // -> Home (+ .members)
await client.community.updateHome("HOME_ID", { ownerOccupied: true });
await client.community.removeHome("HOME_ID");                  // DETACHES its residents
await client.community.setMoveOutDate(ACCOUNT_COMMUNITY_ID, "2026-12-31"); // null clears

// My member-open notifications — the KEY OWNER's own settings
await client.community.myNotificationSettings();    // -> NotificationSettings
await client.community.setMyNotificationsEnabled(true);
await client.community.addQuietHours("MTWHF", { startTime: "22:00", endTime: "06:00" });
await client.community.removeQuietHours(QUIET_HOURS_ID);

// Guest links — the URL IS the credential, and the LIST returns it too
await client.community.guestLinks();                // -> GuestLink[]  SECRET: token + url
await client.community.createGuestLink("event", ["LATCH_ID"], {
  title: "Rooftop party",
  windowStart: "2026-08-22T18:00:00Z",              // naive strings are read as UTC
  windowEnd: "2026-08-22T23:00:00Z",                // ≤ 8h by default, may not be in the past
});
await client.community.createGuestLink("limited_use", ["LATCH_ID"], { maxUses: 6 });
await client.community.revokeGuestLink(GUEST_LINK_ID);            // terminal — no un-revoke
await client.community.guestLinkLogs({ guestLinkId: GUEST_LINK_ID });  // guest PII
await client.community.guestLinkLatchExclusions();  // per link type; absence = permission

// Access codes (keypad / GuestView PINs) — cleartext PIN returned ONCE, on create
await client.community.accessCodes();               // -> AccessCodes (masked PINs)
await client.community.createAccessCode("481502", ["LATCH_ID"], { expiresInHours: 6 });
await client.community.updateAccessCode(DIRECTORY_ACCESS_CODE_ID, { disabled: true });
await client.community.deleteAccessCode(DIRECTORY_ACCESS_CODE_ID);
await client.community.accessCodeEligibleLatches(); // CM-set allowlist (read-only here)
await client.community.accessCodeLogs({ limit: 50 });
await client.community.accessCodeMode();            // -> AccessCodeModeStatus (.mode, .flipPreview)
await client.community.setAccessCodeMode("single_entry", { confirm: true }); // DELETES EVERY CODE

// GuestView Entry — master switch, eligible gates, recurring windows (latch-local)
await client.community.guestViewEntry();            // -> GuestViewEntry — read before writing
await client.community.setGuestViewEntryEnabled(true);            // setter, not toggle
await client.community.setGuestViewEntryLatches(["LATCH_ID"]);    // REPLACES THE WHOLE SET
await client.community.guestViewEntryLogs({ success: false });    // visitor PII
await client.community.addGuestViewEntrySchedule("MTWHF", ["LATCH_ID"], {
  startTime: "09:00", endTime: "17:00",
});
await client.community.removeGuestViewEntrySchedule(SCHEDULE_ID); // widens access

// GuestView short codes — placard codes. Global namespace, and permanent.
await client.community.shortCodes();                // -> ShortCode[]
await client.community.createShortCode({ latchId: "LATCH_ID" });  // omit `code` to generate
await client.community.assignShortCode("Kp7Rx2Q", "LATCH_ID");    // detaches the old gate

// NFC tags — physical fobs/cards. One PATCH assigns, unassigns and disables.
await client.community.nfcTags({ search: "Unit 214" });   // -> NfcTagPage
await client.community.nfcTag(TAG_ID);                    // -> NfcTag
await client.community.updateNfcTag(TAG_ID, { disabled: true });     // 409 -> retry with confirm
await client.community.updateNfcTag(TAG_ID, { latchId: null });      // null detaches
await client.community.nfcScanLog({ tagUidHex: "04a1…" }); // -> NfcScanLogPage

// Sense lines — the gate-status feedback loop. boxId required on the single-line calls.
await client.community.senseLines();                      // -> SenseLines (boxId = optional filter)
await client.community.senseLine(1, "BOX_ID");            // -> SenseLineDetail
await client.community.updateSenseLine(1, "BOX_ID", { senseLineOnline: false });
await client.community.senseLineRecords({ boxId: "BOX_ID" });  // -> SenseLineRecordPage

// Map + geofences — where the gates are (consumes quota; treat as sensitive)
await client.community.map();                             // -> CommunityMap
await client.community.updateGeofence("LATCH_ID", { radiusMeters: 150, enabled: true });

// Logs (community must have Access Log History enabled)
await client.community.memberAccessLogs(ACCOUNT_COMMUNITY_ID, { window: "last_30" }); // last_30 | 30_60 | 60_90
await client.community.accessLog({ page: 0 });      // -> AccessLogPage   (.logs, .hasMore)
await client.community.gateStatusLog({ page: 0 });  // -> GateStatusLogPage
await client.community.changeLogs("guest_link", { days: 30 });   // -> ChangeLogPage (config audit)
await client.community.keyUsage("2026-06-01", "2026-06-10");    // -> KeyUsageReport (14-day window)

// Auto-paginate every page
for await (const row of client.community.iterAccessLog()) { /* … */ }
for await (const row of client.community.iterGateStatusLog()) { /* … */ }
```

### Known vocabularies

```ts
import {
  CAPABILITIES,
  ACCOUNT_KEY_CAPABILITIES,
  STREAM_EVENT_TYPES,
  GUEST_LINK_TYPES,
  GUEST_LINK_STATES,
  GEOFENCE_MODES,
  CHANGE_LOG_TYPES,
  KEY_USAGE_REPORT_TYPES,
  hasCapability,
} from "@nimbio/community-api";

const me = await client.me();
if (!hasCapability(me.key, "hold_opens")) throw new Error("this key cannot hold gates open");
```

`CAPABILITIES` is the 22 endpoint families a community-scoped key can be
granted; `ACCOUNT_KEY_CAPABILITIES` is the account-scoped set — `open`, and
nothing else. `STREAM_EVENT_TYPES` is the ten event types, and it is one
vocabulary rather than two: the same catalog a webhook subscription accepts is
what `streamEvents()` filters on.

`GUEST_LINK_TYPES` is `"event"` and `"limited_use"`, and `GUEST_LINK_STATES`
the six states a link can report (`active`, `upcoming`, `expired`, `spent`,
`revoked`, `feature_disabled`).

`GEOFENCE_MODES` is `"prompt"` (notify the member on arrival, they tap to open)
and `"auto_open"`; `CHANGE_LOG_TYPES` is the four configuration trails
`changeLogs()` can read (`hold_open`, `key_schedule`, `guest_view`,
`guest_link`).

`KEY_USAGE_REPORT_TYPES` is `"commercial"` and `"residential"` — the two
attribution rules `keyUsage()` reports. The server derives it from the
community's property type, so it is a vocabulary for *reading* `reportType`,
never for writing.

Most of these are **open** vocabularies — with three exceptions. The API
validates a guest link's `link_type`, a geofence `mode`, and a change-log `type`
against exactly the listed values, so `GuestLinkType`, `GeofenceMode` and
`ChangeLogType` are typed **closed**, which is what lets the compiler catch a
mix-up before it becomes a 422. Otherwise the server may add to any of them at
any time, and nothing in this client rejects a value it does not recognize.
`community.webhookEventTypes()` is the authoritative list at runtime — the
constant is a convenience snapshot for autocomplete and typo-avoidance, and can
lag a newer server.

### Bulk writes

The four bulk calls take at most 100 items and return **HTTP 207** with one
result per input item, in request order.

- A **whole-batch rejection** throws (422) with nothing applied: an item naming
  another community's member or key, an over-size batch, a duplicate phone
  number. Every item is validated before any is applied.
- **A 207 does not mean every item succeeded.** Each item reports its own `ok`;
  read `.failures` and re-submit just those.
- Grants and disables are idempotent, so re-submitting a batch is safe.
  `bulkAddMembers` is the one to be careful with: each successful item may
  create an account, mint keys, push a notification and fire a
  `member.approved` webhook, none of it undoable.
- Quota: one monthly-quota unit **per item**, one call against the per-minute
  limit. Test keys validate everything and change nothing.

```ts
const res = await client.community.bulkGrantKeys([
  { accountCommunityId: 4021, keyIds: ["KEY_ID"] },
]);
res.total; res.succeeded; res.failed;
for (const bad of res.failures) console.log(bad.index, bad.code, bad.message);
```

### Hold opens

Times are `"HH:MM"` (or `"YYYY-MM-DD HH:MM"`) in the **latch's own local time** —
the `timezone` `holdOpens()` reports for it. Never UTC, and no offset is
accepted: `"08:00"` means 08:00 at the gate.

Recurring days are letters from `MTWHFSU` — **`H` is Thursday**, `S` is
Saturday, `U` is Sunday (a 1–127 bitmask is accepted too). Omit both times for
an all-day schedule. A window may not wrap past midnight: split `22:00`–`06:00`
into `22:00`–`"24:00"` plus `"00:00"`–`06:00` the next day, using `"24:00"`
rather than `"23:59"` so the halves leave no gap.

`removeHoldOpenRecurring()` is **deliberately not idempotent** — an id that is
not on that latch throws `NotFoundError`, because succeeding silently would let
you believe you had cancelled a schedule that is still holding a gate open. The
one-time `removeHoldOpenEvent()` *is* idempotent.

`setHoldOpenDisabledUntil()` suspends **every** scheduled hold open on one latch
(not the community) until the given latch-local moment, releasing any hold
already active; `null` resumes. All four writes require the community's Hold
Opens feature — otherwise 403 `hold_opens_disabled`.

### Webhook deliveries and replays

`webhookDeliveries()` shows what your receiver returned and when — enough to
tell a silently-broken endpoint from one Nimbio never fired at. `lastError`
includes the first part of your own endpoint's response body, so keep secrets
out of your error pages.

`replayDelivery()` and `retryFailedDeliveries()` **re-send the original
`event_id` and the original payload byte for byte**, and the
`X-Nimbio-Delivery` header carries the **event** id, not the delivery id. A
consumer that de-duplicates on that header handles a replay correctly; **one
that ignores it applies the event twice** — a second charge, a second gate
open. Only the `deliveryId` is new, so a replay appears in the delivery list
next to the original, which keeps its failure record.

The replay is signed with the webhook's **current** secret, so a delivery
replayed after a secret rotation fails a receiver still validating against the
old one. `retryFailedDeliveries()` re-sends only deliveries in the terminal
`failed` state, oldest first, skipping ones Nimbio is still retrying
(`skippedInFlight`) and collapsing duplicates by event id
(`skippedDuplicateEvent`); `limit` is 1–100 (default 50). Both throw
`ConflictError` (409) when the webhook is disabled — clear it with
`updateWebhook(id, { active: true })` — and **a test-mode key enqueues nothing**,
returning `result: "simulated"`.

### Access schedules

`daysOfTheWeek` is a letter string from `MTWHFSU` — **`H` is Thursday**, `S` is
Saturday, `U` is Sunday. Times are `"HH:MM"` in each gate's own local time.

Five rules worth knowing before you write one:

- **Community keys only.** These endpoints take one of the community's own keys.
  An individual member's key — even a member of this same community — is refused
  with `not_a_community_key` (403). A member's own schedule is not a community
  manager's to read or rewrite; the community-wide rule is what this API sets.
- **`setKeySchedule` replaces the entire schedule.** Send every window you want
  to keep; `[]` removes the restriction so the key may open at any time.
- **Windows cannot run past midnight.** `22:00`–`06:00` is rejected with
  `overnight_not_supported`. Send two windows instead — the first ending
  `"24:00"` and the second starting `"00:00"` on the following day. Use
  `"24:00"` (the end-of-day sentinel), not `"23:59"`, or the two halves leave a
  one-minute gap every night.
- **A schedule on the community key applies to every member key beneath it.**
  Check `descendantKeyCount` before writing one — it counts **live** member keys
  only, since a revoked key is refused at the gate whatever the schedule says.
- **A schedule covers every gate the key opens** — there is no per-gate
  override.

`restricted` means the key is genuinely time-limited. `permanentlyBlocked`
means it has windows saved but the restriction is switched off, which denies
every open at every hour — a fault, not a working schedule. `keySchedules()`
collects those under `.blocked`; saving a schedule repairs one.

`keySchedules()` lists only the windows **in force today**; any whose date range
has passed are counted in `inactiveWindowCount` instead, so an expired schedule
never reads as "no restriction". `keySchedule(keyId)` returns every window,
expired ones included, because a write replaces the whole schedule.

### Community settings

`settings()` returns four blocks: `settings` (the fifteen keys you may change),
`readOnly` (what Nimbio provisions), `terminology` (the labels in force) and
`terminologyOptions` (what the property type offers instead of a custom label).

**`readOnly` is the reason to call it.** Several endpoint families are gated on
those flags, and without this read the only way to learn a feature is off is to
call it and take a 403: `allowHoldOpens` false 403s every hold-open path,
`isOpenLogHistoryEnabled` false 403s `accessLog()` and `gateStatusLog()`, and
`readOnly.eventKeysEnabled` is the *resolved* answer for event keys — the
settable `eventKeysOverride` (`inherit`/`allow`/`deny`) combined with the
property type's default. Unlike `info()`, this read **does** consume the monthly
quota: it is setup-time configuration, not something to poll.

`updateSettings()` is a partial update with two guarantees:

- **All-or-nothing.** The whole patch is validated before anything is written,
  so a batch with one bad value applies **nothing** — you never have to reason
  about a half-applied profile. `changed` names the keys actually applied.
- **An unknown key is rejected, never ignored** — 422 `invalid_setting` naming
  it. Keys outside the typed fifteen are forwarded verbatim rather than dropped
  here, so that rejection reaches you (and a snake_case key copied out of the
  REST docs works unchanged).

Within a terminology side (`member*` / `home*`) a custom label and a picker
option are **mutually exclusive** — setting one clears the other. Labels cap at
255 characters, icons at 64, control characters are refused, and `""` or null
clears a custom label back to the default.

The read-only flags plus the two per-community caps
(`event_key_max_window_hours`, `limited_use_link_max_uses`) are Nimbio
provisioning decisions — nobody changes them from the CM portal either. Sending
one is a 422 telling you to contact support.

### Homes and move-out dates

`homes()` includes hidden homes by **default** — a roster sync wants the whole
set; pass `{ includeHidden: false }` to match what the portal lists. List rows
carry `memberCount`; `home(homeId)` adds the residents themselves and their
move-out dates. `updateHome()` is partial, and `hidden` is a **setter, not a
toggle**, so a retried PATCH is safe (hiding a home that still has residents is
409 `home_occupied`).

**`removeHome()` detaches every resident attached to the home.** They remain
members of the community and keep their keys, but they are no longer associated
with any unit, and **nothing restores the association automatically** — you
would have to re-add the home and re-attach each resident by hand. The result's
`detachedMemberCount` reports how many were affected; call `home(homeId)` first
if you want to know before committing. A test key reports the count it *would*
detach and changes nothing.

`setMoveOutDate(accountCommunityId, "YYYY-MM-DD")` records a move-out so access
lapses without anyone remembering to revoke it; pass `null` to clear one.

### My member-open notifications

These four calls are scoped to **the community manager who owns the API key**,
not to the community. A key acts as its owner, so a community with several
managers has several independent settings objects: two keys owned by two
managers of the same community return two different objects, and turning
`enabled` off through one does **not** stop the other manager's alerts. All four
return the full settings object, so no write needs a follow-up read.

`featureAvailable` false means the community disallows member-open notifications
entirely — all three writes then return 403 `open_notifications_disabled` and
`enabled` has no effect.

Quiet hours are **additive**: one `addQuietHours()` appends one window, one
`removeQuietHours()` removes one. To replace a schedule, delete the windows you
no longer want. A `quietHoursId` belonging to a different manager — including
another manager of the same community — is a 404 that deletes nothing; the API
deliberately does not distinguish "not yours" from "does not exist".

**The midnight rule here is the opposite of everywhere else:**

| Surface | Wraps past midnight? | `"24:00"` accepted? |
|---|---|---|
| Key access schedules | **No** — send two windows | n/a |
| Recurring hold opens | **No** — split, using `"24:00"` | **Yes** |
| **Quiet hours** | **Yes** — `22:00`–`06:00` is ONE window | **No** |

A developer who has just written hold-open code will otherwise carry the wrong
rule across, and the failure is **silent**: a window that never suppresses. A
start equal to its end is refused (422 `invalid_time`) — a zero-length window
suppresses nothing. Omit both times for an all-day window.

**A window is evaluated in the local timezone of the gate that was opened** —
each device carries its own — not the manager's timezone and not UTC. A
community with gates in two timezones suppresses each gate's alerts on that
gate's own clock; getting this backwards is the other way a window silently
fails to suppress real alerts.

### Guest links

A guest link is a **bearer credential in a URL**: whoever holds it opens the
gate, with no account, no key and no login. That makes it the fastest way to
give a guest access — a booking system can issue the link when a reservation is
confirmed and revoke it at checkout — and it makes every response in this family
secret material.

> **`token` and `url` come back from `guestLinks()`, not only from
> `createGuestLink()`.** A leaked listing is a leaked set of working gate links.
> Treat the response the way you would treat a password, and **do not log it** —
> logging responses at debug level writes working gate links to disk.

That the secrets are listable is deliberate: a guest who deleted the text
message does not need a new link.

The two link types take different limits:

| Type | Requires | Limit |
|---|---|---|
| `event` | `title`, `windowStart`, `windowEnd` | unlimited opens inside the window; window ≤ the community cap (**8h** unless raised) and may not have already ended |
| `limited_use` | `maxUses` | 1 to the community cap (**20** by default); optional `expiresAt` backstop, default and max **30 days** |

Datetimes are ISO-8601. An offset (including `Z`) is honoured, and **a naive
string is read as UTC** — communities carry no timezone of their own — so
`"2026-08-20T18:00:00"` means 18:00 UTC, not 18:00 at the gate. Everything
returned is UTC, and a datetime that does not parse is rejected outright rather
than treated as absent.

`keyId` names the community key behind the link and decides which gates it could
ever reach; omit it only when the community has exactly one key. Every id in
`latchIds` must be openable by that key and must not appear in
`guestLinkLatchExclusions()` **for that link type** — naming an excluded gate is
a 422. `state` is computed live: `active`, `upcoming`, `expired`, `spent`,
`revoked`, `feature_disabled`.

`guestLinkLatchExclusions()` is **read-only on purpose, and absence is
permission**: an empty answer means every gate the backing key opens is
offerable. The setter behind it narrows what a link type may ever cover — a
safety control — so exposing it to API callers was deliberately deferred, not
forgotten.

One deliberate widening: **an API key can mint an `event` link even when the
community has event keys switched off.** That switch aims at *members*, and has
never applied to a manager acting on the management surface, so a settings flip
cannot break links a manager handed out for tonight; an API key inherits the
carve-out. If your integration should honour the community setting, read
`features.eventKeys` from `info()` and branch on it yourself.

Revocation is **terminal** — there is no un-revoke, so mint a new link instead —
but revoking an already-revoked link is a successful no-op, so retries are safe.
`guestLinkLogs()` is **guest PII**: rows carry the redeemer's IP and user agent.

### Access codes

Keypad / GuestView PINs. **The cleartext PIN is returned exactly once**, by
`createAccessCode()`, on `.code`. `accessCodes()` shows `codeMasked` asterisks
and there is no read-back: a lost PIN means delete-and-recreate.

A community runs one of two access-code systems — read `accessCodeMode()`.
In `per_member` mode (the default) a visitor picks the member in the GuestView
directory and types that member's code. In `single_entry` mode there is one
entry field for the whole community: every member carries a 3-letter
**preamble** derived from their name, and the visitor types preamble + code
(`ESM481502`). In that mode `createAccessCode()` also returns `entryCode` —
the full string to hand out, returned once like `code` — and each
`accessCodes()` row carries `preamble` / `entryCodeMasked`.

**`setAccessCodeMode()` deletes every access code in the community**, in either
direction, residents' own included, and notifies the affected members. It is
the same handshake as `updateNfcTag()`: without `{ confirm: true }` a switch
that would change anything throws `ConflictError` (409 `requires_confirmation`)
and changes nothing; read `accessCodeMode().flipPreview` (or the error's
`response.error.preview`), show the counts to a human, then repeat with
`{ confirm: true }`. Already in that mode is `changed: false`. A test key runs
the handshake and answers `simulated: true` with `wouldChange` instead of
deleting anything. The mode is also on `settings().readOnly.accessCodeMode`;
sending it to `updateSettings()` is a 422, on purpose.

Three independent limits, which do different things:

- `expiresInHours` / `expiresInDays` — **mutually exclusive** (both is a 422).
  One absolute cutoff, computed **in UTC from the moment of the call**, so
  re-sending an unchanged value on update silently extends the code.
- `temporal` — a **recurring weekly window**, evaluated in the **gate's own
  local timezone** at redemption. It never expires on its own. Its wire keys are
  `start` and `end` — the only schedule in the API spelled that way; the
  camelCase `AccessCodeTemporalInput` is translated for you.

A code carrying both must satisfy both. Omitting both makes a code that works
until it is disabled or deleted.

`updateAccessCode()` and `deleteAccessCode()` reach **only codes this API key
created** (`apiManaged: true`); a resident's own PIN, or another community's
code, is a 404. Every id in `latchIds` must appear in
`accessCodeEligibleLatches()` — a CM-portal-only allowlist this API can read but
not change — or the write is rejected with `invalid_latch`.

### GuestView Entry

Guest entry from the community's directory: a master switch (`allowed`), the set
of gates it covers (`eligibleLatches`), and the recurring windows during which
it works (`schedule`). Every call here except the log read returns the whole
settings object, so no write needs a follow-up read.

> **`setGuestViewEntryLatches()` REPLACES the whole set.** Any currently
> eligible latch you leave out loses guest eligibility, **and its schedule
> windows are deleted with it**. A caller who adds one gate by sending a
> one-element list silently destroys every other gate's schedule.

Read-modify-write, always:

```ts
const current = await client.community.guestViewEntry();
const ids = current.eligibleLatches.map((l) => l.latchId!);
await client.community.setGuestViewEntryLatches([...ids, newLatchId]);
```

`[]` removes guest entry from every gate — and every window with it. To suspend
guest entry **without** losing the configuration, call
`setGuestViewEntryEnabled(false)`: it leaves the set and the schedule intact, and
it is an explicit setter rather than a toggle precisely so a retry cannot flip
guest access back open.

The schedule is a **whitelist of permitted times**: a latch with **no** windows
is available to guests at any hour, so the first window you add is what starts
restricting it — and removing a latch's last window *widens* access. Each window
is evaluated in **that latch's own local timezone**, at the moment a visitor taps
open.

**The midnight rule here matches quiet hours, not hold opens:**

| Surface | Wraps past midnight? | `"24:00"` accepted? |
|---|---|---|
| Key access schedules | **No** — send two windows | n/a |
| Recurring hold opens | **No** — split, using `"24:00"` | **Yes** |
| Quiet hours | **Yes** | **No** |
| **GuestView Entry schedule** | **Yes** — `22:00`–`06:00` is ONE window | **No** |

`days_of_the_week` letters come from `MTWHFSU` (**H is Thursday, U is Sunday**)
and name the day the window **starts** on. `guestViewEntryLogs()` identifies
visitors — name, phone number and IP — and is readable whether or not the
feature is currently switched on.

### Short codes

A GuestView short code is what a visitor types, or reaches via the QR on a
placard, to open the community's guest directory. `latchId` is the gate it
routes to, or null for a code that opens the directory without preselecting one.

> **`assignShortCode()` silently detaches the gate the code pointed at before.**
> Assignment is exclusive — a code routes to exactly one gate — so repointing a
> placard's code takes it away from the old gate, effective for the next visitor
> who types it. Nothing in the response mentions the gate that just lost it.

**Short codes are unique across all of Nimbio**, not just your community: a code
already in use anywhere is 409 `short_code_taken`, including one that differs
only in letter case, since a placard is read by a person. Omit `code` on create
and the server generates one (7 letters and digits), retrying on collision.

**There is no way to delete a short code** — not through this API and not
through the portal. Mint them for signage you intend to print, not per booking.
An unknown code and a code owned by another community both answer 404
`short_code_not_found`; the namespace is global, so the API deliberately gives
no way to tell those two apart.

### NFC tags

An NFC tag is a physical fob or card that opens the gate it is **bound to** —
not a member's key. One `PATCH` does all three jobs: bind, detach, disable.

> **A 409 here is a warning, not a veto.** A write that would leave a Scan Only
> gate with no working tag answers 409 `requires_confirmation`. Catch
> `ConflictError` and repeat with `confirm: true` — the intended flow, kept
> deliberately non-fatal because revoking a stolen fob has to stay possible.

```ts
import { ConflictError } from "@nimbio/community-api";

try {
  await client.community.updateNfcTag(tagId, { disabled: true });
} catch (e) {
  if (!(e instanceof ConflictError)) throw e;
  await client.community.updateNfcTag(tagId, { disabled: true, confirm: true });
}
```

`disabled` is an **explicit setter, never a toggle**, so revoking a stolen fob
never depends on state you read a moment ago and a retry is safe. `{ disabled:
true }` takes effect for physical gate taps: the next tap on any gate is
refused. `{ latchId: null }` detaches a tag while leaving it in the community
for later reassignment.

**Order matters when you send both fields.** `disabled` is applied first, so
`{ disabled: false, latchId }` revives and then binds in one call, while
`{ disabled: true, latchId }` is refused 422 `conflicting_fields` — a dead fob
cannot be routed to a gate.

`tagUidHex` is the fob's **physical, publicly readable UID, not a secret** — it
is how you join a tag to its rows in `nfcScanLog()`. No cryptographic tag
material is ever returned, `notes` is readable but not writable here, and
programming a blank fob is a separate operator-side job with a card reader. An
unknown tag and another community's tag are the same 404 `tag_not_found`.

### Sense lines

A sense line is a physical input on a Nimbio box that reports whether a gate
actually moved — the feedback loop behind `gateStatus()`, `gateStatusLog()` and
the `sense_line.changed` event. This is the surface that answers *"why does this
gate always report closed?"*.

> **`boxId` is required on `senseLine()` and `updateSenseLine()`.** A sense line
> id is an input number on a board, unique only within its box — two boxes in
> one community both have a "sense line 1" — so the server answers 422
> `box_id_required` rather than guessing. On `senseLines()` and
> `senseLineRecords()` it is a genuine optional filter.

Read **`reporting`** first. It is true only when `senseLineOnline` and
`latchDataOnline` are both on, which is exactly the condition for a transition
to update gate status or fire `sense_line.changed`. **A gate stuck on one status
with `reporting: false` is a configuration problem, not a stuck gate.**

`senseLineRecords()` returns the **raw** transitions, and they are written **even
when a sense line is switched off** — so a healthy record stream beside a stale
`gateStatus()` proves the wiring is fine and the configuration is not. A record's
`status` is `null` when that state has no configured meaning; an unmapped state
is itself a finding, so those rows are returned rather than dropped.

`updateSenseLine()` writes **configuration only**, as explicit sets rather than
toggles (re-sending is a no-op; sending neither flag is 422 `no_fields`).
**Switching either flag off freezes the gate's status at its last known value**
for every app, for `gateStatus()`, for the `sense_line.changed` event, and for
hold-open logic that reads gate state. Turning a miswired input off is a
legitimate repair; doing it by accident is not. The state-to-label wiring
(`statusMap`) is set at installation and is read-only here, and the observed
gate state is what the hardware reports — deliberately not something an API key
can fabricate.

### Map and geofences

`map()` returns the community centre, each Nimbio device with its own location,
and every gate with its geofence. Coordinates are **WGS84 decimal degrees**;
`radiusMeters` is in **metres**.

> **A radius below `minRadiusMeters` (100) is rejected with 422
> `radius_below_minimum`, not silently raised.** Android's Geofence API and iOS
> region monitoring both degrade below ~100 m, so a smaller fence would read as
> configured and never fire. Do not "fix" this by clamping client-side — let the
> rejection reach the caller.

`updateGeofence()` is a **partial update**, which is why it is a `PATCH`:
`latitude` and `longitude` move together (send both or neither), and there is
deliberately **no way to clear a configured centre**, because a silent clear
would disable proximity behaviour on a real gate with nothing to show for it. A
body with nothing to change is 400 `nothing_to_update`.

A gate whose `geofence.center` is `null` has never had one configured — use that
latch's `boxLocation` as the suggested centre. Enabling a fence requires a
centre, the gate's own or its device's location as a fallback. `mode` is
`"prompt"` or `"auto_open"`.

**`map()` consumes monthly quota**, unlike `gateStatus()`: a map is setup-time
configuration that changes when a human moves a pin, not a poll substitute. And
its coordinates say exactly where a property's entrances are — the response is
scoped to your community key, and treating it as physical-security information
downstream is on you.

### Audit trails and reporting

`changeLogs(type)` is the **configuration** audit trail — who changed what, when
— across four trails: `hold_open`, `key_schedule`, `guest_view`, `guest_link`.
It is easy to confuse with the others: `accessLog()` tells you a gate opened,
`changeLogs()` tells you someone rewrote the schedule that let it open, and
`gateStatusLog()` tells you the gate physically moved. Every trail is pruned at
**30 days**, so a wider `days` is clamped rather than rejected — the window
actually used comes back as `days` / `dateFrom` / `dateTo`. `logId` is unique
only within its own `logType`, and timestamps are UTC.

`keyUsage(from, to)` is the CM portal's Access Logs report: inclusive
`YYYY-MM-DD` days in the **community's** timezone, with each row's `datetime` in
that same local zone.

> **Read `reportType` before interpreting `user`.** The server picks the
> attribution rule from the community's property type — there is no parameter
> for it, because getting it wrong would misreport who opened a gate.
> `"commercial"` names the actual opener; `"residential"` reports
> `"<master key owner> Keychain"` for every open on a household's keys. That
> groups by household; it does not anonymize.

`report.residential` is the derived accessor for the household rule — prefer it
over comparing `reportType` by hand, since a misspelled comparison fails
silently and the failure misreports who opened a gate. It is one-sided:
`residential === false` means "not the household rule", not "commercial", since
the server could add a third.

A window wider than `maxRangeDays` (14) is **clamped** to the most recent allowed
span rather than rejected — `dateFrom`/`dateTo` are what was used,
`requestedFrom`/`requestedTo` what you asked for, and `clamped` says whether they
differ. That caps the *width* of one request, not how far back it may sit. Rows
carry personal data, and `phone` does **not** mean what it means on
`accessLog()`: here it is whatever the open recorded — the visitor's number on
guest opens, `null` on ordinary member ones.

### ID vocabulary

- **`latchId`** — from `gateStatus().latches[i].latchId`.
- **`keyId`** (community key id) — from `keys()[i].id` or `keyStatuses()`. Used
  wherever keys are granted/revoked/disabled.
- **`accountCommunityId`** — a member's id, from
  `members().accepted[i].accountCommunityId`. Used to address a member.
- **`temporalDateId`** — a recurring hold-open schedule, from
  `addHoldOpenRecurring()` or `holdOpens()`.
- **`deliveryId`** / **`eventId`** — from `webhookDeliveries()`. Replays are
  addressed by delivery id; de-duplicate on the **event** id.
- **`homeId`** — a unit, from `homes()[i].homeId`.
- **`quietHoursId`** — one of your own quiet-hours windows, from
  `myNotificationSettings().quietHours[i].quietHoursId`.
- **`guestLinkId`** — a guest link, from `guestLinks()[i].guestLinkId`.
- **`directoryAccessCodeId`** — an access code, from
  `accessCodes().accessCodes[i].directoryAccessCodeId` (only `apiManaged` rows
  are writable through the API).
- **`scheduleId`** — a GuestView Entry window, from
  `guestViewEntry().schedule[i].scheduleId` — a different id space from
  `temporalDateId`.
- **`shortCode`** — the code string is its own id, and the namespace is global
  across Nimbio rather than per community.
- **`tagId`** — an NFC tag, from `nfcTags().items[i].tagId`. **`tagUidHex`** is
  the fob's physical UID and joins a tag to its `nfcScanLog()` rows.
- **`boxId`** — a Nimbio device, from `senseLines().boxes[i].boxId` or
  `map().boxes[i].boxId`. Required to address a sense line.
- **`senseLineId`** — an input number on one board, **unique per box only**, so
  it is never an id on its own.

### Return values

Every model exposes typed fields **and** the full server payload on `.raw`, so
newly added server fields are never lost. Writes return a `WriteResult` whose
`.result` is the outcome string (`"member_added"`, `"keys_granted"`, `"sent"`,
or `"simulated"` for test-mode calls); extras live on `.raw`.

```ts
const r = await client.community.addMember("+15551234567", ["KEY_ID"]);
r.result;                          // "member_added" (live) or "simulated" (test)
r.simulated;                       // true on a test key
r.raw.account_community_id;        // endpoint-specific extras
```

---

## Error handling

```ts
import {
  APIError,
  AuthenticationError,
  ConflictError,
  PermissionDeniedError,
  RateLimitError,
  GateNotOpenedError,
} from "@nimbio/community-api";

try {
  await client.community.open("LATCH_ID");
} catch (e) {
  if (e instanceof GateNotOpenedError) {
    // 504 — gate didn't confirm in time
  } else if (e instanceof PermissionDeniedError) {
    console.log(e.code); // e.g. "open_denied", "not_community_key"
  } else if (e instanceof ConflictError) {
    console.log(e.code); // 409 — usually recoverable: "webhook_disabled", …
  } else if (e instanceof RateLimitError) {
    console.log(e.retryAfter); // seconds, may be null
  } else if (e instanceof APIError) {
    console.log(e.status, e.code, e.message, e.requestId);
  } else {
    throw e; // config/network errors — see below
  }
}
```

**Hierarchy** (all extend `NimbioError`, which extends `Error`):

- `NimbioConfigError` — bad config (missing key, unknown environment). Thrown
  **before** any request.
- `APIConnectionError` / `APITimeoutError` — the request never got a response.
- `APIError` — any HTTP ≥ 400, with `.status`, `.code`, `.message`, `.requestId`,
  `.response`, `.headers`. Subclasses: `BadRequestError` (400),
  `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError`
  (404), `ConflictError` (409), `RateLimitError` (429, adds `.retryAfter`),
  `GateNotOpenedError` (504), `UpstreamError` (502/503), `ServerError` (other
  5xx).

`ConflictError` is worth catching by itself: this API uses 409 for an actionable
state rather than a generic failure. `delivery_in_flight` means Nimbio is still
retrying that delivery — let its backoff finish. `webhook_disabled` means the
hook is inactive or was auto-disabled; re-enable it with
`updateWebhook(id, { active: true })` and retry. `requires_confirmation` is a
warning, not a veto: the same call succeeds with `confirm: true`.
`already_accepted` means the member was already approved.

Retries are automatic for 429 and 500/502/503/504 (up to `maxRetries`, honoring
`Retry-After`, exponential backoff otherwise).

---

## Using in the browser

The client works in browsers, but **your API key is a secret** — do not ship a
`nimbio_live_*` key in front-end code. For browser use, proxy requests through
your own backend, or use a scoped test key in trusted internal tools only. CORS
must also be permitted by the API for direct browser calls.

---

## Development

```bash
npm install
npm run build       # tsup -> dist/ (ESM + CJS + .d.ts)
npm test            # vitest (fully mocked; no network)
npm run coverage    # vitest with coverage thresholds
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run check       # version:check + lint + typecheck + coverage (publish gate; ci.yml runs lint/typecheck/coverage/build as separate steps)
```

Tests mock `fetch` entirely, so the suite never touches the network. The wire
contract lives in exactly one place — the `endpoints` registry in
[`src/base.ts`](src/base.ts). When adding or changing an endpoint, edit that
registry (and add a model + parser in [`src/models.ts`](src/models.ts) if the
shape is new), then add the thin wrapper method to `Community` in
[`src/client.ts`](src/client.ts).

---

## Related

- **Python client** — [`nimbio-community-api`](https://pypi.org/project/nimbio-community-api/)
  (`pip install nimbio-community-api`). Same API, same model.
- **Public API** — the REST service this client wraps ([api.nimbio.com](https://api.nimbio.com), see `/docs`).

## License

MIT © Nimbio

---

**About Nimbio** — [Nimbio](https://nimbio.com) is cellular gate and door access for gated
communities, apartment buildings, and commercial properties. Developer docs and integration guides:
[nimbio.com/developers](https://nimbio.com/developers/).
