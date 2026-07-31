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

## The whole API

```ts
const client = new NimbioClient("nimbio_test_...");

await client.me();                       // -> Me           (accountId, key.*)
await client.health();                   // -> Health       (ok, wamp) — never throws on 503
client.mode;                             // -> "test" | "live" | null (no network)

// Reads (community-scoped key required)
await client.community.gateStatus();     // -> GateStatus   (.latches: Latch[])
await client.community.members();        // -> Members      (.accepted/.unaccepted/.removed)
await client.community.keyStatuses();    // -> KeyStatuses  (.keys, .holdOpens)
await client.community.keys();           // -> CommunityKey[]

// Writes (test key = simulated, live key = real)
await client.community.open("LATCH_ID", { note: "...", idempotencyKey: "..." }); // -> OpenResult
await client.community.message("text");                                          // -> WriteResult
await client.community.addMember("+15551234567", ["KEY_ID"]);                    // -> WriteResult
await client.community.grantKeys(ACCOUNT_COMMUNITY_ID, ["KEY_ID"]);              // -> WriteResult
await client.community.revokeKeys(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], { removeMember: false }); // -> WriteResult
await client.community.setKeysDisabled(ACCOUNT_COMMUNITY_ID, ["KEY_ID"], true);               // -> WriteResult

// Logs (community must have Access Log History enabled)
await client.community.memberAccessLogs(ACCOUNT_COMMUNITY_ID, { window: "last_30" }); // last_30|30_60|60_90
await client.community.accessLog({ page: 0 });          // -> AccessLogPage (.logs, .hasMore)
await client.community.gateStatusLog({ page: 0 });      // -> GateStatusLogPage
for await (const row of client.community.iterAccessLog()) { /* auto-paginates */ }

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

## ID vocabulary (important)

- **`latchId`** — from `gateStatus().latches[i].latchId`.
- **`keyId`** (community key id) — from `keys()[i].id` or `keyStatuses()`. Used
  everywhere keys are granted/revoked/disabled.
- **`accountCommunityId`** — a member's id, from
  `members().accepted[i].accountCommunityId`. Used to address a member.

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
  RateLimitError, GateNotOpenedError,
} from "@nimbio/community-api";

try {
  await client.community.open("LATCH_ID");
} catch (e) {
  if (e instanceof GateNotOpenedError) { /* 504 — gate didn't confirm */ }
  else if (e instanceof PermissionDeniedError) { console.log(e.code); } // "open_denied", "not_community_key"
  else if (e instanceof RateLimitError) { console.log(e.retryAfter); }   // seconds, may be null
  else if (e instanceof APIError) { console.log(e.status, e.code, e.message, e.requestId); }
  else throw e;
}
```

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
- Never ship a `nimbio_live_*` key in browser/front-end code — it's a secret.
