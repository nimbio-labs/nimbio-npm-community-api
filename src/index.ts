/**
 * Nimbio community API — the official TypeScript/JavaScript client.
 *
 * A small, typed, dependency-free wrapper over the Nimbio public REST API
 * (https://api.nimbio.com) for community managers: read gate status, manage
 * members and keys, issue opens, send messages, and pull access logs. Works in
 * Node 18+, browsers, Deno, Bun, and edge runtimes.
 *
 * @example Quickstart
 * ```ts
 * import { NimbioClient } from "@nimbio/community-api";
 *
 * const client = new NimbioClient("nimbio_test_..."); // mode inferred from key
 * console.log((await client.me()).accountId);
 *
 * for (const latch of (await client.community.gateStatus()).latches) {
 *   console.log(latch.latchName, "->", latch.status);
 * }
 *
 * // Open a gate. A test key simulates; a live key fires the gate.
 * const result = await client.community.open("latch-id-123", { note: "front gate" });
 * console.log(result.result); // "simulated" (test key) or "opened" (live key)
 * ```
 *
 * Pick an environment with `{ environment: "prod" }` (default), `"dev"`, or
 * `"local"` — or override entirely with `{ baseUrl: "..." }`. Whether a call is
 * a real (live) or simulated (test) action is determined by the API key itself.
 */

export { NimbioClient, Community, Account } from "./client.js";
export type { MemberAccessLogWindow } from "./client.js";

export type {
  ClientOptions,
  FetchLike,
  Mode,
  EndpointSpec,
} from "./base.js";
export { endpoints } from "./base.js";

export {
  ENVIRONMENTS,
  DEFAULT_ENVIRONMENT,
  resolveBaseUrl,
} from "./environments.js";
export type { Environment } from "./environments.js";

export { VERSION } from "./version.js";

// Error hierarchy
export {
  NimbioError,
  NimbioConfigError,
  APIConnectionError,
  APITimeoutError,
  APIError,
  BadRequestError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  RateLimitError,
  GateNotOpenedError,
  UpstreamError,
  ServerError,
  exceptionFor,
} from "./errors.js";
export type { APIErrorFields } from "./errors.js";

// Typed response models + their parsers
export type {
  RawPayload,
  ApiKeyInfo,
  Me,
  Health,
  Latch,
  PossibleStatus,
  GateStatus,
  Member,
  Members,
  CommunityKey,
  KeyStatuses,
  OpenResult,
  WriteResult,
  AccessLogEntry,
  AccessLogPage,
  MemberAccessLogPage,
  GateStatusLogEntry,
  GateStatusLogPage,
  AccountLatch,
  AccountKey,
  HoldOpenLatch,
  HoldOpens,
  ManualHoldOpenResult,
  HoldOpenEventAdded,
  HoldOpenEventRemoved,
  Webhook,
  WebhookWriteResult,
  WebhookSecret,
  StreamEvent,
  StreamReset,
  StreamMessage,
} from "./models.js";

// Webhook delivery verification (HMAC)
export {
  DEFAULT_TOLERANCE_SECONDS,
  WebhookSignatureError,
  computeSignature,
  verifySignature,
  constructEvent,
} from "./webhooks.js";
export type { VerifyOptions, WebhookEvent } from "./webhooks.js";
