# @nimbio/community-api

Official TypeScript/JavaScript client for the **Nimbio community API** ([api.nimbio.com](https://api.nimbio.com)).

Manage a Nimbio community programmatically: read gate status, open gates, add and
manage members and their keys, send community messages, and pull access logs —
from Node, the browser, Deno, Bun, or edge runtimes, with full type definitions.

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

---

## The whole API

```ts
const client = new NimbioClient("nimbio_test_...");

// Account
await client.me();                       // -> Me       (accountId, key usage…)
await client.health();                   // -> Health   (ok, wamp) — never throws on 503
client.mode;                             // -> "test" | "live" | null (no network)

// Reads (community-scoped key required)
await client.community.gateStatus();     // -> GateStatus   (.latches)
await client.community.members();        // -> Members      (.accepted/.unaccepted/.removed)
await client.community.keyStatuses();    // -> KeyStatuses  (.keys, .holdOpens)
await client.community.keys();           // -> CommunityKey[]

// Writes (test key = simulated, live key = real)
await client.community.open("LATCH_ID", { note: "…", idempotencyKey: "…" }); // -> OpenResult
await client.community.message("text");                                       // -> WriteResult
await client.community.addMember("+15551234567", ["KEY_ID"]);                 // -> WriteResult
await client.community.grantKeys(ACCOUNT_COMMUNITY_ID, ["KEY_ID"]);           // -> WriteResult
await client.community.revokeKeys(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], { removeMember: false }); // -> WriteResult
await client.community.setKeysDisabled(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], true);               // -> WriteResult

// Access schedules — limit WHEN a key may open its gates
await client.community.keySchedules();              // -> KeySchedules (.keys, .blocked)
                                                    //    community key(s) + member keys that HAVE a schedule
await client.community.keySchedule("KEY_ID");       // -> KeySchedule
await client.community.setKeySchedule("KEY_ID", [   // replaces the WHOLE schedule
  { daysOfTheWeek: "MTWHF", startTime: "06:00", endTime: "18:00" },
]);
await client.community.setKeySchedule("KEY_ID", []); // [] = always allowed

// Logs (community must have Access Log History enabled)
await client.community.memberAccessLogs(ACCOUNT_COMMUNITY_ID, { window: "last_30" }); // last_30 | 30_60 | 60_90
await client.community.accessLog({ page: 0 });      // -> AccessLogPage   (.logs, .hasMore)
await client.community.gateStatusLog({ page: 0 });  // -> GateStatusLogPage

// Auto-paginate every page
for await (const row of client.community.iterAccessLog()) { /* … */ }
for await (const row of client.community.iterGateStatusLog()) { /* … */ }
```

### Access schedules

`daysOfTheWeek` is a letter string from `MTWHFSU` — **`H` is Thursday**, `S` is
Saturday, `U` is Sunday. Times are `"HH:MM"` in each gate's own local time.

Four rules worth knowing before you write one:

- **`setKeySchedule` replaces the entire schedule.** Send every window you want
  to keep; `[]` removes the restriction so the key may open at any time.
- **Windows cannot run past midnight.** `22:00`–`06:00` is rejected with
  `overnight_not_supported`. Send two windows instead — the first ending
  `"24:00"` and the second starting `"00:00"` on the following day. Use
  `"24:00"` (the end-of-day sentinel), not `"23:59"`, or the two halves leave a
  one-minute gap every night.
- **A schedule on the community key applies to every member key beneath it.**
  Check `descendantKeyCount` and `isCommunityKey` before writing one.
- **A schedule covers every gate the key opens** — there is no per-gate
  override.

`restricted` means the key is genuinely time-limited. `permanentlyBlocked`
means it has windows saved but the restriction is switched off, which denies
every open at every hour — a fault, not a working schedule. `keySchedules()`
collects those under `.blocked`; saving a schedule repairs one.

### ID vocabulary

- **`latchId`** — from `gateStatus().latches[i].latchId`.
- **`keyId`** (community key id) — from `keys()[i].id` or `keyStatuses()`. Used
  wherever keys are granted/revoked/disabled.
- **`accountCommunityId`** — a member's id, from
  `members().accepted[i].accountCommunityId`. Used to address a member.

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
  (404), `RateLimitError` (429, adds `.retryAfter`), `GateNotOpenedError` (504),
  `UpstreamError` (502/503), `ServerError` (other 5xx).

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
