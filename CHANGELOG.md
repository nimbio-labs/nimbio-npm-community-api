# Changelog

All notable changes to `@nimbio/community-api` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [0.7.0] - 2026-09-01

Single-entry access codes. A community can now run one of two access-code
systems, and this release wraps the two new operations that read and switch
between them (`nimbio-public-api` 0.12.0), plus the fields the existing
access-code responses gained.

### Added

- **`community.accessCodeMode()`** → `AccessCodeModeStatus`: the mode in force
  (`"per_member"`, the default, or `"single_entry"`) and `flipPreview`, a
  read-only dry run of switching to the other one — `codesToDelete`,
  `membersAffected`, `membersToAssignPreamble`.
- **`community.setAccessCodeMode(mode, { confirm })`** → `AccessCodeModeChange`.
  **Switching is destructive in both directions**: it deletes **every** access
  code in the community — this key's, other integrations', and residents' own
  — because a code's meaning changes with the mode (`481502` versus
  `ESM481502`). Affected members are notified and a community-wide message is
  sent. So the call is the same two-step handshake `updateNfcTag()` uses:
  without `confirm: true` a switch that would change anything throws
  `ConflictError` (409 `requires_confirmation`), and nothing happens; repeat
  with `{ confirm: true }` to switch. Already in that mode is `changed: false`.
  A test key runs the handshake and then answers `simulated: true` with
  `wouldChange` instead of deleting anything — and `mode: null`, since
  nothing moved (matching the Python client).
- **`ConflictError.preview`** — the parsed `error.preview` of a 409 as an
  `AccessCodeModePreview` (`codesToDelete`, `membersAffected`,
  `membersToAssignPreamble`), so the cost of an unconfirmed
  `setAccessCodeMode()` can be shown without digging through the snake_case
  envelope or making a second call. Null on every other 409; the raw envelope
  stays on `.response`. Matches the Python client's `ConflictError.preview`.
- `ACCESS_CODE_MODES` / `AccessCodeMode` — the closed pair the PUT accepts;
  anything else is 422 `invalid_mode`. `AccessCodeModePreview` is the shared
  preview shape.
- `AccessCode.preamble` / `AccessCode.entryCodeMasked` on `accessCodes()` rows
  and `NewAccessCode.preamble` / `NewAccessCode.entryCode` (mirrored as
  `AccessCodeCreateResult.entryCode`) on `createAccessCode()`. In
  `single_entry` mode every member carries a 3-letter preamble and the visitor
  types preamble + code, so `entryCode` is the string to hand out — returned
  once, like `code`. All four are null in `per_member` mode.
- `AccessCodes.accessCodeMode` — the mode beside the rows on `accessCodes()`,
  so a caller rendering codes knows which masked field to show without a
  second round trip. Neither mode call is gated on the Directory Access Codes
  setting: they work, and never answer 403 `access_codes_disabled`, while the
  feature is off.
- `CommunitySettingsReadOnly.accessCodeMode` — the mode, read-only on
  `settings()`. Sending `access_code_mode` to `updateSettings()` is 422
  `invalid_setting`, deliberately, so a generic settings write can never wipe
  every code by accident.
- `"access_code_mode"` in `CAPABILITIES` (now 22).

## [0.6.0] - 2026-08-27

Full parity with the public REST API. The client now wraps **all 93 documented
API operations**, up from 32 at 0.5.0.

### Added

- **61 endpoints**, closing every gap against `nimbio-public-api` 0.11.0:
  - *Webhook deliveries* — `webhookDeliveries()`, `replayDelivery()`,
    `retryFailedDeliveries()`.
  - *Recurring hold opens* — `addHoldOpenRecurring()`,
    `updateHoldOpenRecurring()`, `removeHoldOpenRecurring()`,
    `setHoldOpenDisabledUntil()`.
  - *Community & roster* — `info()`, `membersPage()`, `member()`, `messages()`,
    `approveMember()`, `updateKey()`, `bulkAddMembers()`, `bulkGrantKeys()`,
    `bulkRevokeKeys()`, `bulkSetKeysDisabled()`.
  - *Settings, homes & notifications* — `settings()`, `updateSettings()`,
    `homes()`, `home()`, `addHome()`, `updateHome()`, `removeHome()`,
    `setMoveOutDate()`, `myNotificationSettings()`,
    `setMyNotificationsEnabled()`, `addQuietHours()`, `removeQuietHours()`.
  - *Guest access* — guest links, directory access codes, GuestView Entry and
    short codes (20 methods).
  - *Diagnostics, geography & audit* — NFC tags, sense lines, the community map
    and geofences, change logs and key usage (12 methods).
- **Transparent conditional requests, on by default.** The client stores the
  `ETag` from any GET that carries one and revalidates with `If-None-Match`. A
  `304` refunds the **monthly** quota, so polling integrations stop paying for
  unchanged data. Bounded LRU (256, `cacheSize`), disable with `cache: false`,
  inspect with `cacheStats`. The cache never answers on its own — every read
  still asks the server — so it cannot serve stale data and needs no
  write-invalidation.
- **`ConflictError`** for HTTP 409, which this API uses for actionable states
  (`delivery_in_flight`, `webhook_disabled`, `requires_confirmation`) rather
  than generic failure.
- **Exported constants** — `CAPABILITIES`, `ACCOUNT_KEY_CAPABILITIES`,
  `STREAM_EVENT_TYPES`, `GUEST_LINK_TYPES`, `GUEST_LINK_STATES`,
  `GEOFENCE_MODES`, `CHANGE_LOG_TYPES`, `KEY_USAGE_REPORT_TYPES`, and
  `hasCapability()`. Convenience snapshots, not closed sets — an unrecognised
  value is still accepted.
- `surface.json` + a test that regenerates it from the `endpoints` registry, so
  the client's HTTP surface is machine-readable and cannot silently go stale.
  Consumed by `nimbioCore`'s `./nimbio.sh sdk-parity`.

### Notes

- Guest-link responses carry `token` and a working `url` — **from the list call
  as well as create**. Treat them as secret material and do not log them.
- `setGuestViewEntryLatches()` replaces the whole set; omitted latches lose
  eligibility and their schedule windows.
- `removeHome()` detaches every resident, irreversibly.
- Quiet-hours windows **may** wrap past midnight and reject `"24:00"` — the
  opposite of recurring hold opens and key schedules.
- `boxId` is required when addressing a single sense line, despite the OpenAPI
  schema marking it optional.

## [0.5.0] - 2026-08-26

### Changed
- **Breaking: `keySchedules()`, `keySchedule()` and `setKeySchedule()` are
  community-keys-only.** A community manager is not permitted to change one
  member's key schedule. `keySchedules()` now returns the community's own
  key(s) and nothing else, and passing a member's `keyId` to either single-key
  method rejects with a 403 carrying `code: "not_a_community_key"`. Nothing you
  could legitimately do is lost: a schedule on the community key already
  cascades to every member key beneath it, which is how a community-wide rule
  is expressed. Tracks the same narrowing in the REST API — see the Public API
  notes for why this was taken as a break rather than a deprecation.
- `KeySchedule.descendantKeyCount` counts only **live** member keys. It
  previously included revoked and hidden ones, overstating how many members a
  restriction actually reaches.

### Added
- `KeySchedule.inactiveWindowCount` — how many windows the list endpoint left
  out because their date range no longer covers today. `keySchedules()` returns
  only what is in force; `keySchedule(keyId)` still returns every window,
  expired ones included, because `setKeySchedule()` replaces the whole
  schedule.

## [0.4.0] - 2026-08-17

### Added
- Key access schedules: `client.community.keySchedules()`,
  `keySchedule(keyId)` and `setKeySchedule(keyId, windows)` — limit which days
  and times a key may open its gates. `setKeySchedule` replaces the whole
  schedule; `[]` removes the restriction entirely. New `KeySchedule`,
  `KeySchedules`, `ScheduleWindow` and `ScheduleWindowInput` types.
  `keySchedules().blocked` collects keys that are denied at **all** times
  because a saved schedule is switched off — a fault worth surfacing, since
  the windows in that state block rather than restrict. Reads are
  quota-exempt. Mirrors the Python SDK's `key_schedules()` (released
  together).

  Two server rules the types cannot express, so they are documented instead:
  a window cannot run past midnight (`22:00`–`06:00` is rejected with
  `overnight_not_supported` — send two windows), and a schedule on the
  community key cascades to every member key beneath it (check
  `descendantKeyCount`).

## [0.3.0] - 2026-07-31

### Added
- Live event stream: `client.community.streamEvents()` — an async iterator
  over Server-Sent Events from `GET /v1/events/stream`, carrying the exact
  webhook event payloads (`sense_line.changed`, `hold_open.changed`,
  `open.*`, `device.*`, `member.*`, `directory.call`) over an outbound
  connection, so integrations behind NAT get live push without exposing an
  endpoint. Automatic reconnect with exponential backoff resumes from the
  last seen event id; a `{ kind: "reset" }` message is yielded when the
  server cannot replay a gap (re-seed via the status reads). New
  `StreamEvent` / `StreamReset` / `StreamMessage` types, an `events` filter,
  `reconnect: false` single-connection mode, and `AbortSignal` support.
  Mirrors the Python SDK's `stream_events()` (released together).

## [0.2.1] - 2026-07-28

### Fixed
- Webhook signature verification now works on Node 18: Web Crypto is resolved
  lazily (`globalThis.crypto` where present, `node:crypto`'s `webcrypto`
  otherwise) instead of assuming a global `crypto`, which Node only exposes
  from 19 on. Browsers/Deno/Bun/edge are unaffected.

## [0.2.0] - 2026-07-28

### Added
- Account surface for account-scoped (member) keys: `client.account.keys()`
  (your keys with latches nested) and `client.account.open(keyId, latchId)` —
  new `Account` namespace with `AccountKey` / `AccountLatch` models. Enables
  member-key integrations (e.g. Home Assistant) without bespoke HTTP.
- Hold-open control surface: `community.holdOpens()`,
  `community.setHoldOpen(latchId, state)` (manual toggle),
  `community.addHoldOpenEvent(latchId, {start, end})` (one-time timed window),
  and `community.removeHoldOpenEvent(latchId, eventId)` — with typed
  `HoldOpens` / `ManualHoldOpenResult` / `HoldOpenEventAdded` /
  `HoldOpenEventRemoved` models.
- Webhook self-management: `community.webhookEventTypes()`, `webhooks()`,
  `createWebhook()`, `updateWebhook()`, `deleteWebhook()`,
  `rotateWebhookSecret()`, and `testWebhook()`. The signing secret is returned
  once on create/rotate (`WebhookWriteResult` / `WebhookSecret`).
- Webhook delivery verification helpers (Web Crypto, all runtimes):
  `computeSignature`, `verifySignature`, `constructEvent`, and
  `WebhookSignatureError` — Stripe-style `sha256=<hex>` HMAC over
  `"{timestamp}.{body}"` with a replay-tolerance window.
- `me().key` now carries `type` (`"account"` | `"community"`),
  `communityId`, and a `capabilities` array for feature discovery.
- `Latch.possibleStatuses` — the latch's configured status vocabulary
  (`{status, transient}` entries) from `community.gateStatus()`, for
  classifying a latch without hardcoding label sets.

### Notes
- Gate-status, key-statuses, hold-opens reads and `/v1/me` no longer consume
  the key's monthly quota server-side (per-minute limit still applies), so
  polling integrations can re-sync freely.

## [0.1.1] - 2026-07-06

### Added
- Release guards: a version-consistency check (`npm run version:check`, enforced
  in CI) that keeps `package.json`, `src/version.ts`, and this changelog in sync,
  and a publish-workflow gate that verifies the pushed tag matches `package.json`.

### Changed
- No changes to the published API surface. This release also validates the
  automated npm Trusted Publishing (OIDC) pipeline end to end.

## [0.1.0] - 2026-07-06

### Added
- Initial release.
- Promise-based `NimbioClient` with a `community` namespace, working in Node
  18+, browsers, Deno, Bun, and edge runtimes on the platform `fetch` (zero
  runtime dependencies).
- `client.me()`, `client.health()`, and the `client.community.*` surface
  covering gate status, members, key statuses, keys, opens, messages, member
  key management (grant/revoke/disable), and access/gate-status logs.
- Fully typed, tolerant response models (`.raw` always retained); ships `.d.ts`
  for ESM and CJS.
- Environment selection (`prod` / `dev` / `local`) plus `baseUrl` override;
  test-vs-live mode inferred from the API key (`client.mode`).
- Configuration via options or `NIMBIO_API_KEY` / `NIMBIO_ENV` /
  `NIMBIO_BASE_URL`.
- Typed error hierarchy mapping the API error envelope, with automatic retries
  (429 + 5xx, honoring `Retry-After`) and timeout handling.
- Async-iterator log pagination helpers (`iterAccessLog`, `iterGateStatusLog`).
- Dual ESM + CommonJS builds, full Vitest suite (fully mocked, no network).

<!-- 0.1.0 was the manual first publish (npm publish, pre-Trusted-Publishing);
     no v0.1.0 git tag was ever created (verified locally 2026-07-16), so 0.1.0
     links to the npm version page instead of a GitHub tag. Tags exist from
     v0.1.1 onward. -->
[Unreleased]: https://github.com/nimbio-labs/nimbio-npm-community-api/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/nimbio-labs/nimbio-npm-community-api/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/@nimbio/community-api/v/0.1.0
