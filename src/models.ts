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
  /** `"account"` | `"community"`. */
  type: string | null;
  communityId: string | null;
  /** Endpoint families this key can call (e.g. `"hold_opens"`, `"webhooks"`). */
  capabilities: string[];
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
    type: str(d.type),
    communityId: str(d.community_id),
    capabilities: arr(d.capabilities).filter(
      (x): x is string => typeof x === "string",
    ),
    lastUsedDatetime: str(d.last_used_datetime),
    // Servers before the 2026-07 fix emitted only the legacy names
    // (calls_this_minute, ...) — accept both.
    minuteLimit: num(d.minute_limit) ?? num(d.rate_limit_per_minute),
    minuteCount: num(d.minute_count) ?? num(d.calls_this_minute),
    monthLimit: num(d.month_limit) ?? num(d.quota_per_month),
    monthCount: num(d.month_count) ?? num(d.calls_this_month),
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

/** One entry of a latch's configured status vocabulary. */
export interface PossibleStatus {
  status: string | null;
  transient: boolean;
  raw: RawPayload;
}

export function parsePossibleStatus(raw: unknown): PossibleStatus {
  const d = asObject(raw);
  return { status: str(d.status), transient: bool(d.transient), raw: d };
}

/**
 * One latch and its latest sensed physical state.
 *
 * `possibleStatuses` is the latch's configured status vocabulary (empty when
 * no sensing is configured) — use it to classify the latch (e.g. a
 * Locked/Unlocked door vs an Open/Closed gate) instead of hardcoding labels.
 */
export interface Latch {
  latchId: string | null;
  latchName: string | null;
  status: string | null;
  offline: boolean;
  message: string | null;
  possibleStatuses: PossibleStatus[];
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
    possibleStatuses: arr(d.possible_statuses).map(parsePossibleStatus),
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

// --------------------------------------------------------------------------- //
// Hold opens
// --------------------------------------------------------------------------- //

/**
 * Hold-open state for one latch. `heldOpen` is the combined truth (manual OR
 * an active one-time/recurring window); `manual` reflects only the manual
 * toggle. `events` / `recurring` are the raw window objects from the server.
 */
export interface HoldOpenLatch {
  latchId: string | null;
  latchName: string | null;
  heldOpen: boolean;
  manual: boolean;
  disabledUntil: string | null;
  timezone: string | null;
  events: unknown[];
  recurring: unknown[];
  raw: RawPayload;
}

export function parseHoldOpenLatch(raw: unknown): HoldOpenLatch {
  const d = asObject(raw);
  return {
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    heldOpen: bool(d.held_open),
    manual: bool(d.manual),
    disabledUntil: str(d.disabled_until),
    timezone: str(d.timezone),
    events: arr(d.events),
    recurring: arr(d.recurring),
    raw: d,
  };
}

/** Result of `community.holdOpens()` — hold-open state per latch id. */
export interface HoldOpens {
  latches: Record<string, HoldOpenLatch>;
  raw: RawPayload;
}

export function parseHoldOpens(raw: unknown): HoldOpens {
  const d = asObject(raw);
  const entries = asObject(d.hold_opens);
  const latches: Record<string, HoldOpenLatch> = {};
  for (const [key, value] of Object.entries(entries)) {
    latches[key] = parseHoldOpenLatch(value);
  }
  return { latches, raw: d };
}

/** Result of `community.setHoldOpen()`. */
export interface ManualHoldOpenResult {
  result: string | null;
  latchId: string | null;
  manual: boolean | null;
  heldOpen: boolean | null;
  requestId: string | null;
  /** True when a test-mode key validated the call without moving the gate. */
  simulated: boolean;
  raw: RawPayload;
}

export function parseManualHoldOpenResult(raw: unknown): ManualHoldOpenResult {
  const d = asObject(raw);
  return {
    result: str(d.result),
    latchId: str(d.latch_id),
    manual: typeof d.manual === "boolean" ? d.manual : null,
    heldOpen: typeof d.held_open === "boolean" ? d.held_open : null,
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/** Result of `community.addHoldOpenEvent()` — keep `eventId` to end early. */
export interface HoldOpenEventAdded {
  result: string | null;
  eventId: string | null;
  latchId: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseHoldOpenEventAdded(raw: unknown): HoldOpenEventAdded {
  const d = asObject(raw);
  return {
    result: str(d.result),
    eventId: str(d.event_id),
    latchId: str(d.latch_id),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * Result of `community.removeHoldOpenEvent()`. `removed` is false on an
 * idempotent re-remove (the window was already gone).
 */
export interface HoldOpenEventRemoved {
  result: string | null;
  removed: boolean;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseHoldOpenEventRemoved(raw: unknown): HoldOpenEventRemoved {
  const d = asObject(raw);
  return {
    result: str(d.result),
    removed: bool(d.removed),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Webhooks
// --------------------------------------------------------------------------- //

/**
 * One outbound webhook registration. `secret` is populated ONLY on the
 * create / rotate-secret responses — store it then; it is never returned again.
 */
export interface Webhook {
  webhookId: string | null;
  url: string | null;
  events: string[];
  description: string | null;
  active: boolean | null;
  disabled: boolean | null;
  secret: string | null;
  raw: RawPayload;
}

export function parseWebhook(raw: unknown): Webhook {
  const d = asObject(raw);
  return {
    webhookId: str(d.webhook_id),
    url: str(d.url),
    events: arr(d.events).filter((x): x is string => typeof x === "string"),
    description: str(d.description),
    active: typeof d.active === "boolean" ? d.active : null,
    disabled: typeof d.disabled === "boolean" ? d.disabled : null,
    secret: str(d.secret),
    raw: d,
  };
}

export function parseWebhooks(raw: unknown): Webhook[] {
  const d = asObject(raw);
  return arr(d.webhooks).map(parseWebhook);
}

export function parseWebhookEventTypes(raw: unknown): string[] {
  const d = asObject(raw);
  return arr(d.events).filter((x): x is string => typeof x === "string");
}

/** Result of `community.createWebhook()` / `community.updateWebhook()`. */
export interface WebhookWriteResult {
  result: string | null;
  webhook: Webhook | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseWebhookWriteResult(raw: unknown): WebhookWriteResult {
  const d = asObject(raw);
  const wh = d.webhook;
  return {
    result: str(d.result),
    webhook: wh && typeof wh === "object" ? parseWebhook(wh) : null,
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/** Result of `community.rotateWebhookSecret()` — the new secret, returned once. */
export interface WebhookSecret {
  result: string | null;
  webhookId: string | null;
  secret: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseWebhookSecret(raw: unknown): WebhookSecret {
  const d = asObject(raw);
  return {
    result: str(d.result),
    webhookId: str(d.webhook_id),
    secret: str(d.secret),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Account surface (account-scoped keys)
// --------------------------------------------------------------------------- //

/** One latch reachable through one of your account's keys. */
export interface AccountLatch {
  id: string | null;
  name: string | null;
  offline: boolean;
  location: string | null;
  heldOpen: boolean;
  raw: RawPayload;
}

export function parseAccountLatch(raw: unknown): AccountLatch {
  const d = asObject(raw);
  return {
    id: str(d.id),
    name: str(d.name),
    offline: bool(d.offline),
    location: str(d.location),
    heldOpen: bool(d.held_open),
    raw: d,
  };
}

/** One of your account's Nimbio keys, with its latches nested. */
export interface AccountKey {
  id: string | null;
  name: string | null;
  home: string | null;
  disabled: boolean;
  hidden: boolean;
  pending: boolean;
  parentName: string | null;
  latches: AccountLatch[];
  raw: RawPayload;
}

export function parseAccountKey(raw: unknown): AccountKey {
  const d = asObject(raw);
  return {
    id: str(d.id),
    name: str(d.name),
    home: str(d.home),
    disabled: bool(d.disabled),
    hidden: bool(d.hidden),
    pending: bool(d.pending),
    parentName: str(d.parent_name),
    latches: arr(d.latches).map(parseAccountLatch),
    raw: d,
  };
}

export function parseAccountKeys(raw: unknown): AccountKey[] {
  const d = asObject(raw);
  return arr(d.keys).map(parseAccountKey);
}

// --------------------------------------------------------------------------- //
// Live event stream (SSE)
// --------------------------------------------------------------------------- //

/**
 * One live event from `community.streamEvents()`.
 *
 * `data` is the exact JSON body a webhook receiver gets for the same event:
 * `{ event, id, community_id, occurred_at, data: {...} }` — `payload` is a
 * convenience view of the event-specific fields (`data.data`).
 */
export interface StreamEvent {
  kind: "event";
  id: string;
  /** e.g. "sense_line.changed", "hold_open.changed" */
  type: string;
  data: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * Yielded when the server cannot replay the requested cursor. The local
 * picture may be stale: re-seed via the status reads
 * (`gateStatus()` / `holdOpens()`), then keep iterating.
 */
export interface StreamReset {
  kind: "reset";
  reason: string | null;
}

/** Union yielded by `community.streamEvents()`. */
export type StreamMessage = StreamEvent | StreamReset;

// --------------------------------------------------------------------------- //
// Key access schedules
// --------------------------------------------------------------------------- //

/**
 * One recurring window during which a key may open its gates.
 *
 * `daysOfTheWeek` is a letter string from `MTWHFSU` where **H is Thursday**,
 * `S` is Saturday and `U` is Sunday. `startTime`/`endTime` are `'HH:MM'` in
 * each gate's own local time; both null means all day on those days.
 *
 * A window cannot run past midnight — the server rejects `end <= start` with
 * `overnight_not_supported`. Express overnight access as two windows.
 */
export interface ScheduleWindow {
  daysOfTheWeek: string;
  startTime: string | null;
  endTime: string | null;
  temporalDateId: string | null;
  raw: RawPayload;
}

export function parseScheduleWindow(raw: unknown): ScheduleWindow {
  const d = asObject(raw);
  return {
    daysOfTheWeek: str(d.days_of_the_week) ?? "",
    startTime: str(d.start_time),
    endTime: str(d.end_time),
    temporalDateId: str(d.temporal_date_id),
    raw: d,
  };
}

/** A window as `setKeySchedule` accepts it. Identifiers are server-assigned. */
export interface ScheduleWindowInput {
  daysOfTheWeek: string;
  startTime?: string | null;
  endTime?: string | null;
}

/**
 * A key's access schedule.
 *
 * `restricted` means the key is genuinely time-limited. `permanentlyBlocked`
 * means it has windows saved but the restriction is switched off, which denies
 * **every** open at every hour — a fault to repair, not a working schedule.
 * Saving a schedule through this SDK clears that state.
 *
 * `descendantKeyCount` is the blast radius: a schedule on the community key
 * applies to every member key beneath it.
 */
export interface KeySchedule {
  keyId: string | null;
  keyName: string | null;
  restricted: boolean;
  permanentlyBlocked: boolean;
  isTemporalEnabled: boolean;
  windows: ScheduleWindow[];
  latchCount: number;
  latches: unknown[];
  isCommunityKey: boolean;
  descendantKeyCount: number;
  /** `"simulated"` for a test-mode write. */
  result: string | null;
  requestId: string | null;
  raw: RawPayload;
}

export function parseKeySchedule(raw: unknown): KeySchedule {
  const d = asObject(raw);
  return {
    keyId: str(d.key_id),
    keyName: str(d.key_name),
    restricted: bool(d.restricted),
    permanentlyBlocked: bool(d.permanently_blocked),
    isTemporalEnabled: bool(d.is_temporal_enabled),
    windows: arr(d.windows).map(parseScheduleWindow),
    latchCount: num(d.latch_count) ?? 0,
    latches: arr(d.latches),
    isCommunityKey: bool(d.is_community_key),
    descendantKeyCount: num(d.descendant_key_count) ?? 0,
    result: str(d.result),
    requestId: str(d.request_id),
    raw: d,
  };
}

/** Result of `community.keySchedules()`. */
export interface KeySchedules {
  keys: KeySchedule[];
  /** Keys denied at all times because a saved schedule is switched off. */
  blocked: KeySchedule[];
  requestId: string | null;
  raw: RawPayload;
}

export function parseKeySchedules(raw: unknown): KeySchedules {
  const d = asObject(raw);
  const keys = arr(d.keys).map(parseKeySchedule);
  return {
    keys,
    blocked: keys.filter((k) => k.permanentlyBlocked),
    requestId: str(d.request_id),
    raw: d,
  };
}
