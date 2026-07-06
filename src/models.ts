/**
 * Typed response models for the Nimbio community API.
 *
 * Every model is a tolerant plain object: it pulls the documented fields out of
 * the JSON response for autocomplete and type-checking, while always retaining
 * the full decoded payload on `raw` so nothing is ever lost. Unknown or newly
 * added server fields are preserved on `raw` even if they have no typed field
 * yet, so the client keeps working across server updates.
 *
 * These models are read-only value objects. You never construct them yourself;
 * the client builds them from API responses.
 */

export type RawPayload = Record<string, unknown>;

/** Coerce an arbitrary decoded value into an object (empty object if not one). */
function asObject(raw: unknown): RawPayload {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as RawPayload)
    : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function bool(v: unknown): boolean {
  return Boolean(v);
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// --------------------------------------------------------------------------- //
// Account / auth
// --------------------------------------------------------------------------- //

/** Metadata and live usage counters for the authenticating API key. */
export interface ApiKeyInfo {
  apiKeyId: string | null;
  prefix: string | null;
  name: string | null;
  /** `"test"` | `"live"`. */
  mode: string | null;
  lastUsedDatetime: string | null;
  minuteLimit: number | null;
  minuteCount: number | null;
  monthLimit: number | null;
  monthCount: number | null;
  raw: RawPayload;
}

export function parseApiKeyInfo(raw: unknown): ApiKeyInfo {
  const d = asObject(raw);
  return {
    apiKeyId: str(d.api_key_id),
    prefix: str(d.prefix),
    name: str(d.name),
    mode: str(d.mode),
    lastUsedDatetime: str(d.last_used_datetime),
    minuteLimit: num(d.minute_limit),
    minuteCount: num(d.minute_count),
    monthLimit: num(d.month_limit),
    monthCount: num(d.month_count),
    raw: d,
  };
}

/** Result of `client.me()` — who the API key belongs to, plus usage. */
export interface Me {
  accountId: string | null;
  key: ApiKeyInfo;
  raw: RawPayload;
}

export function parseMe(raw: unknown): Me {
  const d = asObject(raw);
  return {
    accountId: str(d.account_id),
    key: parseApiKeyInfo(d.key),
    raw: d,
  };
}

/** Result of `client.health()` — backend reachability. */
export interface Health {
  ok: boolean;
  /** `"connected"` | `"disconnected"`. */
  wamp: string | null;
  raw: RawPayload;
}

export function parseHealth(raw: unknown): Health {
  const d = asObject(raw);
  return { ok: bool(d.ok), wamp: str(d.wamp), raw: d };
}

// --------------------------------------------------------------------------- //
// Gate status
// --------------------------------------------------------------------------- //

/** One latch and its latest sensed physical state. */
export interface Latch {
  latchId: string | null;
  latchName: string | null;
  status: string | null;
  offline: boolean;
  message: string | null;
  raw: RawPayload;
}

export function parseLatch(raw: unknown): Latch {
  const d = asObject(raw);
  return {
    latchId: str(d.latch_id) ?? str(d.id),
    latchName: str(d.latch_name) ?? str(d.name),
    status: str(d.status),
    offline: bool(d.offline),
    message: str(d.latch_status_current_message),
    raw: d,
  };
}

/** Result of `community.gateStatus()` — per-latch sensed state. */
export interface GateStatus {
  latches: Latch[];
  raw: RawPayload;
}

export function parseGateStatus(raw: unknown): GateStatus {
  const d = asObject(raw);
  return { latches: arr(d.latches).map(parseLatch), raw: d };
}

// --------------------------------------------------------------------------- //
// Members
// --------------------------------------------------------------------------- //

/** A single community member. `fullName` is derived from first + last name. */
export interface Member {
  accountCommunityId: number | null;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  fullName: string;
  raw: RawPayload;
}

export function parseMember(raw: unknown): Member {
  const d = asObject(raw);
  const firstName = str(d.first_name);
  const lastName = str(d.last_name);
  return {
    accountCommunityId: num(d.account_community_id),
    firstName,
    lastName,
    phoneNumber: str(d.phone_number),
    fullName: [firstName, lastName].filter(Boolean).join(" ").trim(),
    raw: d,
  };
}

/** Result of `community.members()` — pending/accepted/removed lists. */
export interface Members {
  accepted: Member[];
  unaccepted: Member[];
  removed: Member[];
  raw: RawPayload;
}

export function parseMembers(raw: unknown): Members {
  const d = asObject(raw);
  const m = (k: string): Member[] => arr(d[k]).map(parseMember);
  return {
    accepted: m("accepted"),
    unaccepted: m("unaccepted"),
    removed: m("removed"),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Keys
// --------------------------------------------------------------------------- //

/**
 * A community key with its access restrictions (from `community.keys()`).
 *
 * Nested `sharing`, `expiry`, `temporal`, and `latches` structures are left as
 * plain objects/arrays (available on this object and on `raw`) — they are
 * configuration detail that callers usually index into directly.
 */
export interface CommunityKey {
  id: string | null;
  name: string | null;
  disabled: boolean;
  hidden: boolean;
  pending: boolean;
  isFavorite: boolean;
  sharing: RawPayload;
  expiry: RawPayload;
  temporal: RawPayload;
  latches: RawPayload[];
  raw: RawPayload;
}

export function parseCommunityKey(raw: unknown): CommunityKey {
  const d = asObject(raw);
  return {
    id: str(d.id),
    name: str(d.name),
    disabled: bool(d.disabled),
    hidden: bool(d.hidden),
    pending: bool(d.pending),
    isFavorite: bool(d.is_favorite),
    sharing: asObject(d.sharing),
    expiry: asObject(d.expiry),
    temporal: asObject(d.temporal),
    latches: arr(d.latches).map(asObject),
    raw: d,
  };
}

export function parseCommunityKeys(raw: unknown): CommunityKey[] {
  const d = asObject(raw);
  return arr(d.keys).map(parseCommunityKey);
}

/**
 * Result of `community.keyStatuses()` — live key + latch state.
 *
 * The backend payload mixes configuration and transient status; it is exposed
 * here as the `keys` list and `holdOpens` map with full fidelity on `raw`. Use
 * `community.keys()` for the restriction-focused view.
 */
export interface KeyStatuses {
  keys: RawPayload[];
  holdOpens: RawPayload;
  raw: RawPayload;
}

export function parseKeyStatuses(raw: unknown): KeyStatuses {
  const d = asObject(raw);
  return {
    keys: arr(d.keys).map(asObject),
    holdOpens: asObject(d.hold_opens),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Writes (opens, messages, member management)
// --------------------------------------------------------------------------- //

/**
 * Result of `community.open()`.
 *
 * - Live key, success: `result === "opened"`, `keyLogId` set, `opened` true.
 * - Test key:          `result === "simulated"`, `simulated` true.
 *
 * Denials (403) and gate-did-not-confirm (504) throw rather than returning
 * here. `requestId` ties the call to the server-side audit log.
 */
export interface OpenResult {
  result: string | null;
  requestId: string | null;
  keyLogId: number | null;
  latchId: string | null;
  /** True when a live open was confirmed by the box. */
  opened: boolean;
  /** True when this was a test-mode (no side effect) call. */
  simulated: boolean;
  raw: RawPayload;
}

export function parseOpenResult(raw: unknown): OpenResult {
  const d = asObject(raw);
  const result = str(d.result);
  return {
    result,
    requestId: str(d.request_id),
    keyLogId: num(d.key_log_id),
    latchId: str(d.latch_id),
    opened: result === "opened",
    simulated: result === "simulated",
    raw: d,
  };
}

/**
 * Generic result for community write endpoints (messages, member management).
 *
 * `result` is the server's outcome string (e.g. `"member_added"`,
 * `"keys_granted"`, `"sent"`, or `"simulated"` for test-mode calls).
 * Endpoint-specific extras (`account_community_id`, `granted`, `keys`,
 * `revoked_key_ids`, ...) are available on `raw`.
 */
export interface WriteResult {
  result: string | null;
  requestId: string | null;
  /** True on a test key (server returned `"simulated"`). */
  simulated: boolean;
  raw: RawPayload;
}

export function parseWriteResult(raw: unknown): WriteResult {
  const d = asObject(raw);
  const result = str(d.result);
  return {
    result,
    requestId: str(d.request_id),
    simulated: result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Logs
// --------------------------------------------------------------------------- //

/** One row in an access log (a gate open). */
export interface AccessLogEntry {
  datetime: string | null;
  keyName: string | null;
  latchName: string | null;
  user: string | null;
  phone: string | null;
  location: string | null;
  openDesc: string | null;
  openResult: string | null;
  reasonDesc: string | null;
  source: string | null;
  raw: RawPayload;
}

export function parseAccessLogEntry(raw: unknown): AccessLogEntry {
  const d = asObject(raw);
  return {
    datetime: str(d.datetime),
    keyName: str(d.key_name),
    latchName: str(d.latch_name),
    user: str(d.user),
    phone: str(d.phone),
    location: str(d.location),
    openDesc: str(d.open_desc),
    openResult: str(d.open_result),
    reasonDesc: str(d.reason_desc),
    source: str(d.source),
    raw: d,
  };
}

/** A page of community access-log rows (1000 per page). */
export interface AccessLogPage {
  logs: AccessLogEntry[];
  page: number | null;
  hasMore: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  raw: RawPayload;
}

export function parseAccessLogPage(raw: unknown): AccessLogPage {
  const d = asObject(raw);
  return {
    logs: arr(d.logs).map(parseAccessLogEntry),
    page: num(d.page),
    hasMore: bool(d.has_more),
    dateFrom: str(d.from),
    dateTo: str(d.to),
    raw: d,
  };
}

/** A member's access-log rows for a 30-day window. */
export interface MemberAccessLogPage {
  logs: AccessLogEntry[];
  accountCommunityId: number | null;
  window: string | null;
  truncated: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  raw: RawPayload;
}

export function parseMemberAccessLogPage(raw: unknown): MemberAccessLogPage {
  const d = asObject(raw);
  return {
    logs: arr(d.logs).map(parseAccessLogEntry),
    accountCommunityId: num(d.account_community_id),
    window: str(d.window),
    truncated: bool(d.truncated),
    dateFrom: str(d.from),
    dateTo: str(d.to),
    raw: d,
  };
}

/** One physical open/closed transition. */
export interface GateStatusLogEntry {
  datetime: string | null;
  latchName: string | null;
  statusLabel: string | null;
  senseLine: number | null;
  state: string | null;
  raw: RawPayload;
}

export function parseGateStatusLogEntry(raw: unknown): GateStatusLogEntry {
  const d = asObject(raw);
  return {
    datetime: str(d.datetime),
    latchName: str(d.latch_name),
    statusLabel: str(d.status_label),
    senseLine: num(d.sense_line),
    state: str(d.state),
    raw: d,
  };
}

/** A page of gate status-change rows (1000 per page). */
export interface GateStatusLogPage {
  logs: GateStatusLogEntry[];
  page: number | null;
  hasMore: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  raw: RawPayload;
}

export function parseGateStatusLogPage(raw: unknown): GateStatusLogPage {
  const d = asObject(raw);
  return {
    logs: arr(d.logs).map(parseGateStatusLogEntry),
    page: num(d.page),
    hasMore: bool(d.has_more),
    dateFrom: str(d.from),
    dateTo: str(d.to),
    raw: d,
  };
}
