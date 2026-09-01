# AGENTS.md — using `@nimbio/community-api` from an LLM/agent

A compact, copy-pasteable reference for coding agents and quick sessions.
Everything here is real and current with the package.

## Install & import

```bash
npm install @nimbio/community-api
```

```ts
import { NimbioClient } from "@nimbio/community-api";   // ESM / TypeScript
// const { NimbioClient } = require("@nimbio/community-api");   // CommonJS
```

Runtime: Node 18+, browsers, Deno, Bun, edge. **Every method returns a Promise —
use `await`.** There is one client class; JS has no idiomatic sync HTTP.

## Authenticate

A key is required. It looks like `nimbio_test_<22 chars>` or `nimbio_live_<22 chars>`.

```ts
new NimbioClient("nimbio_test_...");                          // explicit
new NimbioClient();                                          // reads NIMBIO_API_KEY
new NimbioClient("nimbio_live_...", { environment: "dev" });
new NimbioClient("nimbio_test_...", { baseUrl: "http://localhost:8000" });
```

- `environment`: `"prod"` (default → api.nimbio.com), `"dev"` (→ api.nimbio.dev),
  `"local"` (→ localhost:8000). Or set `baseUrl` to override.
- **test vs live is the KEY, not a flag.** A `nimbio_test_*` key never fires a
  gate / sends a real message. Check with `client.mode` → `"test"` | `"live"`.
- Env vars: `NIMBIO_API_KEY`, `NIMBIO_ENV`, `NIMBIO_BASE_URL`.
- Other options: `timeout` (seconds, default 30), `maxRetries` (default 2),
  `defaultHeaders`, `fetch`, and `cache` / `cacheSize` — see below.

## Conditional requests: polling is cheap, ON BY DEFAULT

Every GET stores the response's `ETag` and replays it as `If-None-Match` next
time. When the server answers **304 Not Modified**, the client rebuilds the
result from what it stored. **A 304 is indistinguishable from a 200** — same
type, same values, a freshly parsed object each time, no `notModified` flag to
check. Write your polling loop as if nothing were cached; it already works.

```ts
const status = await client.community.gateStatus();  // 200 once, then 304s
client.cacheStats;   // { hits, misses, entries } — the only way to confirm it
client.clearCache(); // drop stored ETags (rarely needed)
new NimbioClient(key, { cache: false });   // opt out; cacheSize: 0 does too
```

- **A 304 refunds the MONTHLY QUOTA but still costs a PER-MINUTE request.**
  Do not read caching as permission to poll faster — the rate limit is there to
  protect the server and it counts every 304.
- **No latency win.** The server derives the ETag from the body it would have
  sent, so the upstream work still happens; only the body, the parse and the
  quota unit are saved.
- **It cannot serve stale data.** `Cache-Control: max-age` is ignored on
  purpose: every read still asks the server, so a cached body is only ever used
  when the server confirms nothing changed — which also means **writes need no
  cache invalidation**.
- GETs only. Writes and `streamEvents()` are never cached. `/v1/me`, the event
  stream and the API call log are non-cacheable server-side and never hit —
  `me()`'s payload *is* your live usage counters, so an ETag could never match.
- Bounded LRU, 256 entries by default; one client holds one API key, so cached
  entries can never cross tenants.

## The whole API

```ts
const client = new NimbioClient("nimbio_test_...");

await client.me();                       // -> Me           (accountId, key.*)
await client.health();                   // -> Health       (ok, wamp) — never throws on 503
client.mode;                             // -> "test" | "live" | null (no network)

// Reads (community-scoped key required)
await client.community.info();           // -> CommunityInfo  CALL THIS FIRST (ids, features, timezone)
await client.community.gateStatus();     // -> GateStatus   (.latches: Latch[])
await client.community.members();        // -> Members      (.accepted/.unaccepted/.removed)
await client.community.membersPage({ bucket: "accepted", page: 1, size: 100, search: "555" });
                                         // -> MembersPage  (paged + searchable; prefer for big rosters)
await client.community.member(ACCOUNT_COMMUNITY_ID);  // -> MemberDetail (.bucket)
await client.community.messages({ limit: 50, offset: 0 }); // -> MessagePage (sent messages, UTC)
await client.community.keyStatuses();    // -> KeyStatuses  (.keys, .holdOpens)
await client.community.keys();           // -> CommunityKey[]

// Writes (test key = simulated, live key = real)
await client.community.open("LATCH_ID", { note: "...", idempotencyKey: "..." }); // -> OpenResult
await client.community.message("text");                                          // -> WriteResult
await client.community.addMember("+15551234567", ["KEY_ID"]);                    // -> WriteResult
await client.community.grantKeys(ACCOUNT_COMMUNITY_ID, ["KEY_ID"]);              // -> WriteResult
await client.community.revokeKeys(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], { removeMember: false }); // -> WriteResult
await client.community.setKeysDisabled(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], true);               // -> WriteResult
await client.community.updateKey("KEY_ID", { name: "Pool Key", disabled: true });  // -> KeyUpdateResult
await client.community.approveMember(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], { moveOutDate: "2027-01-31" });

// Bulk writes — HTTP 207, at most 100 items, one result per item IN ORDER.
// A 207 means the batch ran, NOT that every item worked: always read .failures.
await client.community.bulkAddMembers([{ phoneNumber: "+15551234567", keyIds: ["KEY_ID"] }]);
await client.community.bulkGrantKeys([{ accountCommunityId: 4021, keyIds: ["KEY_ID"] }]);
await client.community.bulkRevokeKeys([{ accountCommunityId: 4021, keyIds: ["KEY_ID"] }]);
await client.community.bulkSetKeysDisabled([{ accountCommunityId: 4021, keyIds: ["KEY_ID"] }], true);

// Hold opens (community needs the Hold Opens feature; times are LATCH-LOCAL, never UTC)
await client.community.holdOpens();                       // -> HoldOpens (per latch, incl. .timezone)
await client.community.setHoldOpen("LATCH_ID", true);     // manual toggle
await client.community.addHoldOpenEvent("LATCH_ID", { start: "2026-08-01 09:00", end: "2026-08-01 10:00" });
await client.community.removeHoldOpenEvent("LATCH_ID", "EVENT_ID");             // idempotent
await client.community.addHoldOpenRecurring("LATCH_ID", "MTWHF", { startTime: "08:00", endTime: "17:00" });
await client.community.updateHoldOpenRecurring("LATCH_ID", "TEMPORAL_DATE_ID", { clearTimes: true });
await client.community.removeHoldOpenRecurring("LATCH_ID", "TEMPORAL_DATE_ID"); // NOT idempotent -> 404
await client.community.setHoldOpenDisabledUntil("LATCH_ID", "2026-12-25 23:59"); // null resumes

// Access schedules — WHEN the community's own keys may open (community keys only)
await client.community.keySchedules();                        // -> KeySchedules (.keys, .blocked)
await client.community.keySchedule("COMMUNITY_KEY_ID");       // -> KeySchedule
await client.community.setKeySchedule("COMMUNITY_KEY_ID", [   // replaces the WHOLE schedule
  { daysOfTheWeek: "MTWHF", startTime: "06:00", endTime: "18:00" },
]);                                                           // [] = always allowed

// Community settings — read `readOnly` to discover features instead of taking a 403
await client.community.settings();                       // -> CommunitySettings (.settings/.readOnly)
await client.community.updateSettings({ allowDirectoryViewing: false, memberTermCustom: "Tenant" });
                                         // partial, all-or-nothing; unknown key -> 422 invalid_setting

// Homes / units roster
await client.community.homes();                          // -> Home[]  (includeHidden defaults TRUE)
await client.community.addHome("12 Elm St, Unit 3");     // -> HomeWriteResult
await client.community.home("HOME_ID");                  // -> Home (.members, their moveOutDate)
await client.community.updateHome("HOME_ID", { hidden: true });   // setter, not toggle
await client.community.removeHome("HOME_ID");            // DETACHES residents — see .detachedMemberCount
await client.community.setMoveOutDate(ACCOUNT_COMMUNITY_ID, "2026-12-31"); // null clears

// My member-open notifications — the KEY OWNER's settings, not the community's
await client.community.myNotificationSettings();         // -> NotificationSettings
await client.community.setMyNotificationsEnabled(true);
await client.community.addQuietHours("MTWHF", { startTime: "22:00", endTime: "06:00" }); // ONE window
await client.community.removeQuietHours(QUIET_HOURS_ID);

// Guest links — a URL IS the credential. `token`/`url` come back from the LIST
// too, so treat the whole response as secret and DO NOT LOG IT.
await client.community.guestLinks({ includeInactive: true });   // -> GuestLink[] (token + url!)
await client.community.createGuestLink("event", ["LATCH_ID"], { // event: needs title + window
  title: "Rooftop party", windowStart: "2026-08-22T18:00:00Z", windowEnd: "2026-08-22T23:00:00Z",
});                                                             // -> GuestLinkResult
await client.community.createGuestLink("limited_use", ["LATCH_ID"], { maxUses: 6 }); // cap 20, 30d
await client.community.revokeGuestLink(GUEST_LINK_ID);          // TERMINAL — no un-revoke
await client.community.guestLinkLogs({ guestLinkId: GUEST_LINK_ID, limit: 50 }); // guest PII (IP, UA)
await client.community.guestLinkLatchExclusions();              // per link type; absence = permission

// Access codes (keypad / GuestView PINs) — the PIN is returned ONCE, by create
await client.community.accessCodes();                    // -> AccessCodes (masked; .apiManaged)
await client.community.createAccessCode("481502", ["LATCH_ID"], {
  expiresInHours: 6,                                     // XOR expiresInDays — both = 422
  temporal: { daysOfTheWeek: "MTWHF", start: "09:00", end: "17:00" }, // GATE-local, wire keys start/end
});                                                      // -> .code is the cleartext PIN, once
await client.community.updateAccessCode(DIRECTORY_ACCESS_CODE_ID, { disabled: true }); // API-made only
await client.community.deleteAccessCode(DIRECTORY_ACCESS_CODE_ID);
await client.community.accessCodeEligibleLatches();      // CM-set allowlist; read before writing
await client.community.accessCodeLogs({ limit: 50, offset: 0 });
await client.community.accessCodeMode();                 // -> .mode "per_member"|"single_entry", .flipPreview
await client.community.setAccessCodeMode("single_entry");                 // 409 ConflictError = preview, nothing changed
await client.community.setAccessCodeMode("single_entry", { confirm: true }); // DELETES EVERY CODE in the community

// GuestView Entry — master switch + eligible gates + recurring windows (LATCH-local)
await client.community.guestViewEntry();                 // -> GuestViewEntry  READ THIS FIRST
await client.community.setGuestViewEntryEnabled(false);  // setter, not toggle; keeps the config
await client.community.setGuestViewEntryLatches([...ids, NEW_ID]);  // REPLACES THE WHOLE SET
await client.community.guestViewEntryLogs({ success: false });      // visitor PII (name/phone/IP)
await client.community.addGuestViewEntrySchedule("MTWHF", ["LATCH_ID"], {
  startTime: "09:00", endTime: "17:00",                  // wraps past midnight; NO "24:00"
});
await client.community.removeGuestViewEntrySchedule(SCHEDULE_ID);   // WIDENS access

// GuestView short codes — the code on a placard. Permanent: no delete, ever.
await client.community.shortCodes();                     // -> ShortCode[]
await client.community.createShortCode({ latchId: "LATCH_ID" });    // omit `code` = server-generated
await client.community.assignShortCode("Kp7Rx2Q", "LATCH_ID");      // DETACHES the previous gate

// NFC tags — physical fobs/cards. ONE patch assigns, unassigns and disables.
await client.community.nfcTags({ search: "Unit 214", page: 1, resultsPerPage: 50 }); // -> NfcTagPage
await client.community.nfcTag(TAG_ID);                   // -> NfcTag (other communities' = 404)
await client.community.updateNfcTag(TAG_ID, { disabled: true });   // kills a lost fob AT THE GATE
await client.community.updateNfcTag(TAG_ID, { latchId: "LATCH_ID" });  // null detaches
await client.community.updateNfcTag(TAG_ID, { disabled: true, confirm: true }); // after a 409
await client.community.nfcScanLog({ tagUidHex: "04a1…", result: "ok" });  // -> NfcScanLogPage

// Sense lines — why a gate misreports. boxId REQUIRED on the single-line calls.
await client.community.senseLines({ boxId: "BOX_ID" });  // -> SenseLines (boxId here is a FILTER)
await client.community.senseLine(1, "BOX_ID");           // -> SenseLineDetail (.statusMap, .lastRecord)
await client.community.updateSenseLine(1, "BOX_ID", { senseLineOnline: false }); // FREEZES gate status
await client.community.senseLineRecords({ boxId: "BOX_ID", limit: 50 }); // raw transitions (status may be null)

// Map + geofences — coordinates of every entrance. Treat as physical security.
await client.community.map();                            // -> CommunityMap (COSTS QUOTA)
await client.community.updateGeofence("LATCH_ID", {      // partial; lat+long move together
  latitude: 36.1699, longitude: -115.1398, radiusMeters: 150, enabled: true, mode: "prompt",
});                                                      // radius < 100 -> 422, NOT clamped

// Webhooks + deliveries
await client.community.webhooks();
await client.community.createWebhook("https://example.com/hook", ["open.succeeded"]);
await client.community.updateWebhook("WEBHOOK_ID", { active: true });  // revives an auto-disabled hook
await client.community.webhookDeliveries("WEBHOOK_ID", { limit: 50 }); // -> WebhookDelivery[]
await client.community.retryFailedDeliveries("WEBHOOK_ID", { since: "2026-08-18T13:00:00Z", limit: 100 });
await client.community.replayDelivery("WEBHOOK_ID", "DELIVERY_ID");

// Logs (community must have Access Log History enabled)
await client.community.memberAccessLogs(ACCOUNT_COMMUNITY_ID, { window: "last_30" }); // last_30|30_60|60_90
await client.community.accessLog({ page: 0 });          // -> AccessLogPage (.logs, .hasMore)
await client.community.gateStatusLog({ page: 0 });      // -> GateStatusLogPage
for await (const row of client.community.iterAccessLog()) { /* auto-paginates */ }
await client.community.changeLogs("guest_link", { days: 30, limit: 500 }); // -> ChangeLogPage
                                        // CONFIG audit trail, 30-day retention (days is clamped)
await client.community.keyUsage("2026-06-01", "2026-06-10", { page: 0 });  // -> KeyUsageReport
                                        // community-LOCAL dates; >14d windows are CLAMPED, not refused

// Live events (SSE push — same payloads as webhooks, works behind NAT)
for await (const msg of client.community.streamEvents({
  events: ["sense_line.changed", "hold_open.changed"],  // filter optional
  signal: controller.signal,                            // AbortSignal to stop
})) {
  if (msg.kind === "reset") { /* gap not replayable: re-seed via gateStatus()/holdOpens() */ }
  else { msg.id; msg.type; msg.payload; }               // payload = event-specific fields
}
```

`streamEvents()` iterates forever by default (auto-reconnect with backoff,
resuming from the last seen event id); pass `reconnect: false` to consume one
connection and return. HTTP errors throw (`RateLimitError` with code
`stream_limit` = too many concurrent streams; the cap is 3 per key).
Connecting charges one per-minute request; delivered events are quota-free.

## Known vocabularies (don't hand-type these)

```ts
import {
  CAPABILITIES, ACCOUNT_KEY_CAPABILITIES, STREAM_EVENT_TYPES, hasCapability,
  GEOFENCE_MODES, CHANGE_LOG_TYPES, KEY_USAGE_REPORT_TYPES,
} from "@nimbio/community-api";

const me = await client.me();
if (!hasCapability(me.key, "hold_opens")) throw new Error("key lacks hold_opens");
```

`GUEST_LINK_TYPES` (`"event"`, `"limited_use"`) and `GUEST_LINK_STATES`
(`active`, `upcoming`, `expired`, `spent`, `revoked`, `feature_disabled`) cover
guest links. The link **types** are a closed set — the API validates against
exactly those two, and `GuestLinkType` is typed closed so the compiler catches
the mix-up; the **states** are server-computed and open like the rest.

`KEY_USAGE_REPORT_TYPES` (`"commercial"`, `"residential"`) is what
`keyUsage().reportType` reports — server-computed from the property type, never
something you send, and open like the rest.

`GEOFENCE_MODES` (`"prompt"`, `"auto_open"`) and `CHANGE_LOG_TYPES`
(`hold_open`, `key_schedule`, `guest_view`, `guest_link`) are **closed** too:
the API validates both against exactly those values, so `GeofenceMode` and
`ChangeLogType` are typed closed and a typo is a compile error rather than a
422. `community.map()` echoes the server's own mode list as `geofenceModes`.

`CAPABILITIES` is the 22 endpoint families a community-scoped key can carry;
`ACCOUNT_KEY_CAPABILITIES` is what an account-scoped key gets — `open`, and
nothing else. `STREAM_EVENT_TYPES` is the ten event types, one vocabulary used
by both webhook subscriptions and `streamEvents()`.

All of these are **open** vocabularies: the server may add to any of them and
nothing here rejects an unknown value. `community.webhookEventTypes()` is the
authoritative runtime list — the constant is a snapshot for autocomplete and
typo-avoidance.

## Behaviours that bite (read before writing)

- **A guest-link response is a set of working gate links — including the LIST.**
  `guestLinks()` returns each link's `token` and ready-to-send `url`, exactly as
  `createGuestLink()` did. Whoever holds the URL opens the gate: no account, no
  key, no login. **Do not log these responses** — dumping them at debug level
  writes working gate links to disk. (It is deliberate that they are listable: a
  guest who lost the text message does not need a new link.)
- **`setGuestViewEntryLatches()` replaces the WHOLE set.** Every currently
  eligible latch you leave out loses guest eligibility **and its schedule
  windows are deleted with it**. Read `guestViewEntry()` and send back a
  modified copy; never compose the list from memory. `[]` removes guest entry
  from every gate — to suspend it without losing the configuration use
  `setGuestViewEntryEnabled(false)`, which leaves the set and schedule intact.
- **`assignShortCode()` silently detaches the previous gate.** A code routes to
  exactly one gate, so repointing a placard's code takes it away from whatever
  it pointed at, effective for the next visitor who types it. Nothing in the
  response mentions the old gate. Short codes are also **global and permanent**:
  a name in use anywhere is 409 `short_code_taken`, and none can ever be deleted.
- **Guest-link datetimes: a naive string is read as UTC.** ISO-8601 throughout;
  an offset (`Z` included) is honoured, but communities carry no timezone of
  their own, so `"2026-08-20T18:00:00"` means 18:00 UTC, not 18:00 at the gate.
  Everything returned is UTC, and a datetime that does not parse is rejected
  rather than treated as absent. `event` windows may not exceed the community
  cap (**8h** by default) nor have already ended; `limited_use` takes `maxUses`
  1–20 (default cap) and an `expiresAt` backstop capped at **30 days**.
- **`guestLinkLatchExclusions()` is per link type, and absence is permission.**
  An empty answer means every gate the backing key opens is offerable; naming an
  excluded gate is a 422, so read it before creating. It is deliberately
  **read-only** — the setter narrows what a link type may ever cover, a safety
  control that stays in the CM portal. Not a gap.
- **An API key can mint an `event` link even when the community has event keys
  switched off.** That switch aims at *members* and has never applied to a
  manager acting on the management surface, so a settings flip cannot break
  links a manager handed out for tonight — and an API key inherits the carve-out.
  This is a real widening: to honour the community setting, read
  `features.eventKeys` from `info()` and branch on it yourself.
- **The access-code PIN exists in exactly one response.** `createAccessCode()`
  returns the cleartext on `.code`; `accessCodes()` shows asterisks and there is
  no read-back. Lose it and the only fix is delete-and-recreate. `expiresInHours`
  and `expiresInDays` are **mutually exclusive** (both = 422) and are recomputed
  from *now*, so re-sending an unchanged value on update silently extends the
  code. A `temporal` window is evaluated in the **gate's** local timezone, never
  expires on its own, and its wire keys are `start`/`end` — the only schedule in
  the API spelled that way. Update and delete reach **only codes this key
  created** (`apiManaged`); a resident's own PIN is a 404.
- **`setAccessCodeMode()` deletes EVERY access code in the community** — this
  key's, other integrations', residents' own — in either direction, and
  notifies every affected member. Read `accessCodeMode()` first: `.mode` is
  `"per_member"` (visitor picks the member, types their code) or
  `"single_entry"` (one field; visitor types the member's 3-letter preamble +
  code, `ESM481502`), and `.flipPreview` says what a switch would cost
  (`codesToDelete`, `membersAffected`, `membersToAssignPreamble`). The write is
  the NFC handshake: without `{ confirm: true }` it throws `ConflictError`
  (409 `requires_confirmation`, preview on `response.error.preview`) and
  changes nothing; show the counts to a human, then repeat with
  `{ confirm: true }`. Already in that mode is `changed: false`. A test key
  answers `simulated: true` + `wouldChange`. In `single_entry` mode hand the
  visitor `createAccessCode().entryCode` (preamble + PIN, returned once), not
  `code`; `accessCodes()` rows carry `preamble` / `entryCodeMasked`. The mode
  is read-only on `settings().readOnly.accessCodeMode`; PATCHing it there is
  a 422 on purpose.
- **GuestView Entry windows wrap past midnight and reject `"24:00"`** — same
  rule as quiet hours, the opposite of hold opens and key schedules. The
  schedule is a **whitelist**: a latch with no windows is open to guests at any
  hour, so removing a latch's last window *widens* access. Each window is read
  in that **latch's** own timezone.
- **Recurring hold opens.** Days are letters from `MTWHFSU` — **H is Thursday,
  S is Saturday, U is Sunday**; a 1–127 bitmask also works. Times are `"HH:MM"`
  in the **latch's own timezone** (from `holdOpens()`), never UTC. A window may
  not wrap past midnight: split `22:00`–`06:00` into `22:00`–`"24:00"` and
  `"00:00"`–`06:00`, using `"24:00"` (not `"23:59"`, which leaves a gap). Omit
  both times for an all-day schedule.
- **`removeHoldOpenRecurring` is not idempotent** — an id that is not on the
  latch throws `NotFoundError`, deliberately, so you can never believe you
  cancelled a schedule that is still holding a gate open. (The one-time
  `removeHoldOpenEvent` *is* idempotent.)
- **`setHoldOpenDisabledUntil` is per latch, not per community**, takes
  `"YYYY-MM-DD HH:MM"` in latch-local time, and requires the argument: pass
  `null` to resume.
- **Replays re-send the ORIGINAL `event_id` and payload byte for byte.** The
  `X-Nimbio-Delivery` header carries the *event* id, not the delivery id — a
  receiver that de-duplicates on it handles a replay correctly, **one that
  ignores it applies the event twice** (a second charge, a second gate open).
  The replay is signed with the **current** secret, so a delivery replayed
  after a rotation fails a receiver still validating the old one.
- **`retryFailedDeliveries`** re-sends only deliveries in the terminal `failed`
  state, oldest first; `limit` is 1–100 (default 50), candidates are
  de-duplicated by `event_id`, and the result reports what was actually
  enqueued (`replayedCount`, `skippedInFlight`, `skippedDuplicateEvent`).
- **Both delivery writes enqueue nothing on a test key** — `result:
  "simulated"`. With a live key they POST a real event at your real receiver.
- **Quiet hours wrap past midnight; hold opens and key schedules do not.** Same
  `"HH:MM"` field, three different rules. `addQuietHours("MTWHF", { startTime:
  "22:00", endTime: "06:00" })` is **one** window; `"24:00"` is **rejected**
  here, though it is the required end-of-day sentinel for
  `addHoldOpenRecurring` / `setKeySchedule`, which cannot wrap and need two
  windows. Carrying the hold-open habit across fails **silently** — the window
  suppresses nothing at the hours you meant. A start equal to its end is 422
  `invalid_time`; omit both times for all day.
- **Quiet hours are evaluated in the OPENED GATE's timezone** — not the
  manager's, not UTC. A community with gates in two timezones suppresses each
  gate's alerts on that gate's own clock.
- **The four `*NotificationSettings` / quiet-hours calls are per MANAGER, not
  per community.** An API key acts as its owning community manager, so two keys
  owned by two managers of one community read and write two different objects.
  Turning `enabled` off through one key does nothing to the other manager's
  alerts, and another manager's `quietHoursId` is a 404 that deletes nothing.
  Quiet hours are additive: one POST appends one window, one DELETE removes one.
- **`removeHome()` detaches every resident attached to the home**, irreversibly.
  They stay members and keep their keys, but lose their unit association and
  nothing restores it. Check `detachedMemberCount` on the result, or call
  `home(homeId)` first to see the blast radius before committing.
- **`updateSettings()` is all-or-nothing** — the whole patch is validated before
  anything is written, so one bad value applies nothing. An unknown key is
  **rejected** (422 `invalid_setting` naming it), never ignored, and this client
  forwards unrecognized keys verbatim so that rejection reaches you. The
  read-only flags (`allowHoldOpens`, `isOpenLogHistoryEnabled`,
  `allowGuestViewEntry`, plus the two per-community caps) are 422s too — read
  them from `settings().readOnly`, which is how you discover a feature is off
  without provoking a 403. Unlike `info()`, `settings()` **does** cost quota.
- **`updateKey({ disabled: true })` can deny the whole community.** Member keys
  are children of the community key and inherit its disabled state; check
  `descendantKeyCount` on the result.
- **The NFC 409 is a warning, not a veto.** `updateNfcTag()` answers 409
  `requires_confirmation` when the write would leave a Scan Only gate with no
  working tag. Catch `ConflictError` and repeat with `confirm: true` — that is
  the intended flow, because revoking a stolen fob has to stay possible.
  `disabled` is an explicit setter (never a toggle) and is applied **before**
  `latchId`, so `{ disabled: false, latchId }` revives-then-binds in one call
  while `{ disabled: true, latchId }` is 422 `conflicting_fields`.
- **`boxId` is REQUIRED on `senseLine()` and `updateSenseLine()`**, even though
  the OpenAPI schema marks it optional. A sense line id is an input number on a
  board, unique only within its box — two boxes in one community both have a
  "sense line 1" — so omitting it is 422 `box_id_required`, not a guess. On
  `senseLines()` and `senseLineRecords()` it is a genuine optional filter.
- **`reporting: false` means a configuration problem, not a stuck gate.** It is
  true only when `senseLineOnline` and `latchDataOnline` are both on, which is
  exactly the condition for a transition to update gate status or fire
  `sense_line.changed`. Turning either flag off **freezes the gate's status at
  its last known value** for every app, for `gateStatus()`, for the event, and
  for hold-open logic that reads gate state. `senseLineRecords()` keeps
  recording either way, so a healthy record stream beside a stale `gateStatus()`
  proves the wiring is fine and the configuration is not.
- **A geofence radius below 100 m is REJECTED (422 `radius_below_minimum`), not
  clamped.** Android's Geofence API and iOS region monitoring both degrade below
  ~100 m, so a smaller fence would read as configured and never fire. Do not
  "fix" this by clamping client-side. `latitude`/`longitude` move together, and
  there is deliberately no way to clear a configured centre.
- **`map()` costs monthly quota** (unlike `gateStatus()`) and its coordinates say
  exactly where a property's entrances are — it is setup-time configuration, not
  a poll substitute, and the response is physical-security information.
- **`keyUsage()` attribution is decided by the server, not by you.** Read
  `reportType`: `"commercial"` names the actual opener, `"residential"` reports
  `"<master key owner> Keychain"` for every open on a household's keys. Prefer
  the derived `report.residential` boolean over comparing the string yourself —
  a typo'd comparison is silently false and misreports who opened a gate. It is
  one-sided: false means "not the household rule", not "commercial". A window
  wider than 14 days is **clamped** to the most recent allowed span rather than
  rejected — compare `dateFrom`/`dateTo` against `requestedFrom`/`requestedTo`.
- **Bulk calls cost one monthly-quota unit per item** and reject the whole batch
  (422, nothing applied) if any item names another community's member or key.

## ID vocabulary (important)

- **`latchId`** — from `gateStatus().latches[i].latchId`.
- **`keyId`** (community key id) — from `keys()[i].id` or `keyStatuses()`. Used
  everywhere keys are granted/revoked/disabled.
- **`accountCommunityId`** — a member's id, from
  `members().accepted[i].accountCommunityId`. Used to address a member.
- **`temporalDateId`** — a recurring hold-open schedule's id, from
  `addHoldOpenRecurring()` or `holdOpens().latches[id].recurring`.
- **`deliveryId`** / **`eventId`** — from `webhookDeliveries()`. Replays take
  the delivery id; de-duplication uses the **event** id.
- **`tagId`** — an NFC tag, from `nfcTags().items[i].tagId`. **`tagUidHex`** is
  the fob's physical (publicly readable) UID and is what joins a tag to its
  `nfcScanLog()` rows — it is not a secret, and no cryptographic tag material is
  ever returned.
- **`boxId`** — a Nimbio device, from `senseLines().boxes[i].boxId` or
  `map().boxes[i].boxId`. Required to address a sense line.
- **`senseLineId`** — an input number on one board, **unique per box only**.
- **`homeId`** — a unit, from `homes()[i].homeId`. `home(homeId)` adds the
  residents (and each one's `accountCommunityId`) that `homes()` only counts.
- **`quietHoursId`** — one of *your own* quiet-hours windows, from
  `myNotificationSettings().quietHours[i].quietHoursId`. Another manager's id
  is a 404.
- **`guestLinkId`** — a guest link, from `guestLinks()[i].guestLinkId`. Another
  community's id is a 404, identical to an unknown one.
- **`directoryAccessCodeId`** — an access code, from
  `accessCodes().accessCodes[i].directoryAccessCodeId`. Only rows with
  `apiManaged: true` can be updated or deleted through the API.
- **`scheduleId`** — one GuestView Entry window, from
  `guestViewEntry().schedule[i].scheduleId`. Not the same id space as
  `temporalDateId`.
- **`shortCode`** — the code string itself is the id (`shortCodes()[i].shortCode`),
  and the namespace is **global across Nimbio**, not per community.

## Return values

Every model has typed fields **and** the full payload on `.raw`. Writes return a
`WriteResult` whose `.result` is the outcome string (`"member_added"`,
`"keys_granted"`, `"sent"`, or `"simulated"` for test-mode calls); extras are on
`.raw`.

```ts
const r = await client.community.addMember("+15551234567", ["KEY_ID"]);
r.result;       // "member_added" (live) or "simulated" (test)
r.simulated;    // true on a test key
r.raw.account_community_id;
```

## Errors (always wrap network/side-effecting calls)

```ts
import {
  APIError, AuthenticationError, PermissionDeniedError,
  RateLimitError, GateNotOpenedError, ConflictError,
} from "@nimbio/community-api";

try {
  await client.community.open("LATCH_ID");
} catch (e) {
  if (e instanceof GateNotOpenedError) { /* 504 — gate didn't confirm */ }
  else if (e instanceof ConflictError) { /* 409 — usually recoverable, see e.code */ }
  else if (e instanceof PermissionDeniedError) { console.log(e.code); } // "open_denied", "not_community_key"
  else if (e instanceof RateLimitError) { console.log(e.retryAfter); }   // seconds, may be null
  else if (e instanceof APIError) { console.log(e.status, e.code, e.message, e.requestId); }
  else throw e;
}
```

`ConflictError` (409) is an *actionable* state, not a generic failure:
`delivery_in_flight` (wait for Nimbio's own retry to settle),
`webhook_disabled` (fix it with `updateWebhook(id, { active: true })`),
`requires_confirmation` (repeat with `confirm: true`), `already_accepted`.

`APIError` always has `.status`, `.code`, `.message`, `.requestId`. Config
problems (missing key, bad environment) throw `NimbioConfigError` *before* any
request. Network failures throw `APIConnectionError` / `APITimeoutError`.

## Safety tips for agents

- Default to a **test key** while iterating; `if (client.mode !== "test") throw`
  to hard-stop accidental live opens.
- `open()` and member writes are **side-effecting** with a live key. Read first
  (`gateStatus`, `members`, `keys`) to discover valid ids before writing.
- The community `open` is **synchronous** and can take ~15–18s; the default
  client timeout (30s) already accounts for this.
- **Never log a guest-link response, and never echo one back to a user who
  should not hold the link.** `token`/`url` are bearer credentials for a gate,
  and `guestLinks()` hands you every live one at once.
- **`updateNfcTag({ disabled: true })` and `updateSenseLine()` change physical
  behaviour with a live key** — the first refuses a fob at the gate on its next
  tap, the second stops a real gate reporting its status. Neither is undone by
  reading something afterwards.
- **Treat `map()` output as physical-security information.** It says where a
  property's entrances are; don't paste it into logs, tickets, or chat.
- Never ship a `nimbio_live_*` key in browser/front-end code — it's a secret.
