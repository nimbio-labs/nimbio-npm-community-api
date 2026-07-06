# Changelog

All notable changes to `@nimbio/community-api` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/nimbio-labs/nimbio-npm-community-api/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nimbio-labs/nimbio-npm-community-api/releases/tag/v0.1.0
