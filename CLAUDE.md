# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**nimbio-npm-community-api** is the official TypeScript/JavaScript client for the
Nimbio community API (`api.nimbio.com`). It is published to npm as
**`@nimbio/community-api`** and works in Node 18+, browsers, Deno, Bun, and edge
runtimes.

It wraps the `nimbio-public-api` service over HTTPS. It does **not** talk to
kindlyWAMP or the database directly. It is the TypeScript sibling of the Python
client `nimbio-python-community-api` (PyPI `nimbio-community-api`) and mirrors its
surface and behavior.

## Naming (keep them straight)

| Thing | Name |
|-------|------|
| GitHub repo | `nimbio-npm-community-api` (owner: `nimbio-labs`) |
| npm package | `@nimbio/community-api` |

## Tech Stack

- **Language**: TypeScript (strict), targeting ES2021; emits ESM + CJS + `.d.ts`.
- **Runtime dependencies**: none. Uses the platform `fetch`.
- **Build**: `tsup` (`src/` → `dist/`).
- **Tests**: Vitest, fully mocked via an injected `fetch` (no network) + v8 coverage.
- **Lint / types**: ESLint (flat config, typescript-eslint) + `tsc --noEmit`.
- **Node**: 18+ (for global `fetch`).

## Architecture

- `src/base.ts` — `BaseClient` (config resolution, headers, request prep,
  response decode/parse, error mapping, retry policy) and the `endpoints`
  registry, the **single source of truth** for the HTTP surface. Each endpoint
  builder returns an `EndpointSpec` `{ method, path, params, body, parse }`.
- `src/client.ts` — `NimbioClient` (the `fetch` loop + top-level `me`/`health`)
  and `Community` (the `client.community.*` methods + async-iterator pagination).
- `src/models.ts` — tolerant response interfaces + `parse*` functions; every
  parsed object keeps the full payload on `.raw`.
- `src/errors.ts` — `NimbioError` hierarchy mapping the
  `{ error: { code, message, request_id } }` envelope + `exceptionFor`.
- `src/environments.ts` — `prod`/`dev`/`local` → base URL.
- `src/version.ts` — `VERSION` (keep in sync with `package.json`).
- `src/index.ts` — the public export surface.

**When adding or changing an endpoint:** edit the `endpoints` registry in
`base.ts` once (and add an interface + `parse*` in `models.ts` if the shape is
new), then add the thin wrapper method to `Community`/`NimbioClient` in
`client.ts`. Export any new public type from `index.ts`.

**Everything is async.** JavaScript has no idiomatic blocking HTTP, so there is a
single Promise-based client — no separate sync/async classes (unlike the Python
package's `NimbioClient` / `AsyncNimbioClient` split).

Test vs live is **inferred from the API key prefix** (`nimbio_test_*` /
`nimbio_live_*`), exposed as `client.mode` — it is not a constructor option.

## Common commands

```bash
npm install
npm run build       # tsup -> dist/ (ESM + CJS + .d.ts)
npm test            # vitest run
npm run coverage    # vitest with coverage thresholds (95% lines)
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run check       # version:check + lint + typecheck + coverage
```

Note: `npm run check` is not literally what CI runs. `ci.yml` runs lint,
typecheck, coverage, and **build** as separate steps (Node 18/20/22) and does
not run `version:check`; `publish.yml` is what runs `npm run check` (then
build) before publishing a tag.

Keep coverage at/near the configured thresholds. `AGENTS.md` is the LLM/agent
usage cheat sheet — update it when the public surface changes.

## Releasing

1. Bump `version` in `package.json` **and** `VERSION` in `src/version.ts`, and
   add a dated section to `CHANGELOG.md`. `npm run version:check` (part of
   `npm run check`, which `publish.yml` runs — the `ci.yml` PR checks do not)
   asserts these three agree.
2. Update the customer-facing changelogs in `nimbioCore`:
   `nimbioCore/changelogs/npm-sdk.md` and `nimbioCore/marketing-changelogs/npm-sdk.md`.
3. Tag `vX.Y.Z` and push the tag — `.github/workflows/publish.yml` verifies the
   tag matches `package.json`, runs `npm run check`, builds, and publishes to npm
   via **Trusted Publishing** (OIDC; no stored token) with provenance. An npm
   version cannot be re-uploaded, so only tag when ready.

**First publish is manual** (the Trusted Publisher can only be configured on an
existing package): run `npm publish --access public --provenance=false` once
(after `npm login` and creating/owning the `@nimbio` npm org), then configure the
Trusted Publisher on npmjs.com. CI publishing takes over from the next tag.

**One-time publish setup:** the `@nimbio` scope must exist/be owned on npm, and a
Trusted Publisher (GitHub Actions, repo `nimbio-labs/nimbio-npm-community-api`,
workflow `publish.yml`) must be configured on npmjs.com. See the header comment
in `.github/workflows/publish.yml`.

## Related

- `nimbio-public-api` — the REST service this client wraps (endpoint contracts,
  auth, scope model).
- `nimbio-python-community-api` — the Python sibling; keep the two surfaces in
  lockstep when the API changes.
- `nimbioCore/changelogs/` + `nimbioCore/marketing-changelogs/` — customer-facing changelogs.
- `CHANGELOG.md` (this repo) — technical changelog for GitHub releases.
