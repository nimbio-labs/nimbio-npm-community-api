# Changelog

All notable changes to `@nimbio/community-api` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
