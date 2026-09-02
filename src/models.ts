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
 * A window cannot run past midnight — the server rejects a reversed window with
 * `overnight_not_supported`. Express overnight access as two windows: the first
 * ending `"24:00"` (the end-of-day sentinel, valid as an end only) and the
 * second starting `"00:00"` the next day. Use `"24:00"` rather than `"23:59"`,
 * since the comparison is `now < end` and `"23:59"` would leave a one-minute
 * gap every night exactly where the two halves meet.
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
 * A community key's access schedule.
 *
 * Schedules are set on the community's own keys only. That schedule *is* the
 * community-wide rule: it applies to every member key beneath it. An individual
 * member's key cannot be read or scheduled through this API and is refused with
 * `not_a_community_key` (403).
 *
 * `restricted` means the key is genuinely time-limited. `permanentlyBlocked`
 * means it has windows saved but the restriction is switched off, which denies
 * **every** open at every hour — a fault to repair, not a working schedule.
 * Saving a schedule through this SDK clears that state.
 *
 * `descendantKeyCount` is the blast radius: how many **live** member keys
 * inherit this restriction. Revoked and hidden keys are not counted — they are
 * refused at the gate whatever the schedule says.
 *
 * `inactiveWindowCount` is how many windows the list endpoint filtered out
 * because their date range no longer covers today; `windows` then holds only
 * what is in force. It is 0 on a single-key read, which returns every window —
 * expired ones included — because a write replaces the whole schedule.
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
  inactiveWindowCount: number;
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
    inactiveWindowCount: num(d.inactive_window_count) ?? 0,
    result: str(d.result),
    requestId: str(d.request_id),
    raw: d,
  };
}

/**
 * Result of `community.keySchedules()` — the community's own keys and their
 * schedules. Community keys only; member keys are neither listed nor
 * schedulable, since a restriction on the community key already cascades to
 * every member beneath it.
 */
export interface KeySchedules {
  keys: KeySchedule[];
  /**
   * Community keys denied at all times because a saved schedule is switched
   * off. Re-saving the schedule repairs one.
   */
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

// --------------------------------------------------------------------------- //
// Community description (the bootstrap read)
// --------------------------------------------------------------------------- //

/** What a community has turned on. Branch on these instead of provoking a 403. */
export interface CommunityFeatures {
  holdOpens: boolean;
  accessLogHistory: boolean;
  directoryViewing: boolean;
  directoryAccessCodes: boolean;
  guestViewEntry: boolean;
  subkeys: boolean;
  /** Resolved value: the property-type default plus any per-community override. */
  memberOpenNotifications: boolean;
  /** Resolved value, as above. */
  eventKeys: boolean;
  raw: RawPayload;
}

export function parseCommunityFeatures(raw: unknown): CommunityFeatures {
  const d = asObject(raw);
  return {
    holdOpens: bool(d.hold_opens),
    accessLogHistory: bool(d.access_log_history),
    directoryViewing: bool(d.directory_viewing),
    directoryAccessCodes: bool(d.directory_access_codes),
    guestViewEntry: bool(d.guest_view_entry),
    subkeys: bool(d.subkeys),
    memberOpenNotifications: bool(d.member_open_notifications),
    eventKeys: bool(d.event_keys),
    raw: d,
  };
}

/** Roster and hardware totals for the community. */
export interface CommunityCounts {
  latches: number | null;
  keys: number | null;
  homes: number | null;
  membersAccepted: number | null;
  membersPending: number | null;
  membersRemoved: number | null;
  raw: RawPayload;
}

export function parseCommunityCounts(raw: unknown): CommunityCounts {
  const d = asObject(raw);
  return {
    latches: num(d.latches),
    keys: num(d.keys),
    homes: num(d.homes),
    membersAccepted: num(d.members_accepted),
    membersPending: num(d.members_pending),
    membersRemoved: num(d.members_removed),
    raw: d,
  };
}

/**
 * One configured latch, as `community.info()` describes it.
 *
 * `latchId` is the id every open and hold-open call takes. `timezone` is
 * inherited from the box the latch hangs off — a community has no timezone of
 * its own — and is the clock every time you send or read is interpreted in.
 * Live sensed state is not here; call `community.gateStatus()` for that.
 */
export interface CommunityLatch {
  latchId: string | null;
  latchName: string | null;
  offline: boolean;
  timezone: string | null;
  boxId: string | null;
  boxName: string | null;
  raw: RawPayload;
}

export function parseCommunityLatch(raw: unknown): CommunityLatch {
  const d = asObject(raw);
  return {
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    offline: bool(d.offline),
    timezone: str(d.timezone),
    boxId: str(d.box_id),
    boxName: str(d.box_name),
    raw: d,
  };
}

/**
 * Result of `community.info()` — identity, timezone, features, and latches.
 *
 * `timezone` is the single zone every configured latch agrees on, or `null`
 * when they disagree or none is set; `timezones` lists every distinct zone in
 * play. A multi-site community legitimately reports `null` at the top level —
 * use each latch's own `timezone` there.
 *
 * `terminology` (what this community calls a member and a home) and
 * `propertyType` are left as plain objects — display detail callers index into.
 */
export interface CommunityInfo {
  communityId: number | null;
  communityUuid: string | null;
  name: string | null;
  active: boolean;
  propertyType: RawPayload;
  numberOfUnits: number | null;
  timezone: string | null;
  timezones: string[];
  features: CommunityFeatures;
  latches: CommunityLatch[];
  terminology: RawPayload;
  counts: CommunityCounts;
  raw: RawPayload;
}

export function parseCommunityInfo(raw: unknown): CommunityInfo {
  const d = asObject(raw);
  return {
    communityId: num(d.community_id),
    communityUuid: str(d.community_uuid),
    name: str(d.name),
    active: bool(d.active),
    propertyType: asObject(d.property_type),
    numberOfUnits: num(d.number_of_units),
    timezone: str(d.timezone),
    timezones: arr(d.timezones).filter((x): x is string => typeof x === "string"),
    features: parseCommunityFeatures(d.features),
    latches: arr(d.latches).map(parseCommunityLatch),
    terminology: asObject(d.terminology),
    counts: parseCommunityCounts(d.counts),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Member rows (paged roster + single member)
// --------------------------------------------------------------------------- //

/** One community key a member holds, as roster rows report it. */
export interface MemberKey {
  keyId: string | null;
  keyName: string | null;
  disabled: boolean;
  raw: RawPayload;
}

export function parseMemberKey(raw: unknown): MemberKey {
  const d = asObject(raw);
  return {
    keyId: str(d.key_id),
    keyName: str(d.key_name),
    disabled: bool(d.disabled),
    raw: d,
  };
}

/**
 * One roster row from `community.membersPage()` / `community.member()`.
 *
 * **Rows are not all people.** A home appears as a single row with
 * `isHome: true`, whose `memberIds` are the `accountCommunityId`s of the people
 * living there and whose `homeAddress` names it; such a row has no phone
 * numbers or keys of its own. Skip them (or expand them) rather than treating
 * one as a member.
 *
 * `bucket` (`accepted` / `unaccepted` / `removed`) is set by
 * `community.member()`; on a page it is on the page object instead.
 */
export interface MemberDetail {
  /** Account id (home id on an `isHome` row) — NOT the id member writes take. */
  id: string | null;
  accountCommunityId: number | null;
  isHome: boolean;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  phoneNumbers: string[];
  keys: MemberKey[];
  accepted: boolean;
  subkeyCount: number | null;
  createdDatetime: string | null;
  moveOutDate: string | null;
  bucket: string | null;
  /** Home rows only: the `accountCommunityId`s of the people in this home. */
  memberIds: number[];
  /** Home rows only: the display names matching `memberIds`. */
  memberNames: string[];
  /** Home rows only. */
  homeAddress: string | null;
  raw: RawPayload;
}

export function parseMemberDetail(raw: unknown): MemberDetail {
  const d = asObject(raw);
  const firstName = str(d.first_name);
  const lastName = str(d.last_name);
  return {
    id: str(d.id),
    accountCommunityId: num(d.account_community_id),
    isHome: bool(d.is_home),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ").trim(),
    phoneNumbers: arr(d.phone_numbers).filter(
      (x): x is string => typeof x === "string",
    ),
    keys: arr(d.keys).map(parseMemberKey),
    accepted: bool(d.accepted),
    subkeyCount: num(d.subkey_count),
    createdDatetime: str(d.created_datetime),
    moveOutDate: str(d.move_out_date),
    bucket: str(d.bucket),
    memberIds: arr(d.members).filter((x): x is number => typeof x === "number"),
    memberNames: arr(d.member_names).filter(
      (x): x is string => typeof x === "string",
    ),
    homeAddress: str(d.home_address),
    raw: d,
  };
}

/**
 * One page of `community.membersPage()`.
 *
 * `total` is the size of the **filtered** set (the search matches), not the
 * whole bucket, and filtering happens before paging — so walking the pages of a
 * search never skips anyone.
 */
export interface MembersPage {
  bucket: string | null;
  page: number | null;
  size: number | null;
  total: number | null;
  hasMore: boolean;
  members: MemberDetail[];
  raw: RawPayload;
}

export function parseMembersPage(raw: unknown): MembersPage {
  const d = asObject(raw);
  return {
    bucket: str(d.bucket),
    page: num(d.page),
    size: num(d.size),
    total: num(d.total),
    hasMore: bool(d.has_more),
    members: arr(d.members).map(parseMemberDetail),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Sent messages
// --------------------------------------------------------------------------- //

/**
 * One message already sent to the community.
 *
 * `sentAt` is ISO-8601 in **UTC** (unlike hold-open times, which are latch
 * local). `senderName` / `senderAccountId` are the community manager the
 * message went out as — an API key acts as its owning manager, so a message
 * sent through this API is indistinguishable from one sent in the portal.
 */
export interface CommunityMessage {
  messageId: number | null;
  message: string | null;
  senderName: string | null;
  senderAccountId: string | null;
  sentAt: string | null;
  communityUuid: string | null;
  raw: RawPayload;
}

export function parseCommunityMessage(raw: unknown): CommunityMessage {
  const d = asObject(raw);
  return {
    messageId: num(d.message_id),
    message: str(d.message),
    senderName: str(d.sender_name),
    senderAccountId: str(d.sender_account_id),
    sentAt: str(d.sent_at),
    communityUuid: str(d.community_uuid),
    raw: d,
  };
}

/**
 * A page of `community.messages()`, newest first.
 *
 * Only real sends are recorded: a test-mode key's send is validated and
 * discarded, so nothing simulated is ever in this log — a test key reads the
 * live history but can never add to it.
 */
export interface MessagePage {
  messages: CommunityMessage[];
  limit: number | null;
  offset: number | null;
  hasMore: boolean;
  raw: RawPayload;
}

export function parseMessagePage(raw: unknown): MessagePage {
  const d = asObject(raw);
  return {
    messages: arr(d.messages).map(parseCommunityMessage),
    limit: num(d.limit),
    offset: num(d.offset),
    hasMore: bool(d.has_more),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Key updates
// --------------------------------------------------------------------------- //

/**
 * Result of `community.updateKey()`.
 *
 * `descendantKeyCount` is the blast radius of a `disabled` change: how many
 * member keys descend from this community key and are cut with it. On a
 * test-mode call `key` is null and `wouldSet` echoes what a live key would have
 * written.
 */
export interface KeyUpdateResult {
  result: string | null;
  key: CommunityKey | null;
  descendantKeyCount: number | null;
  keyId: string | null;
  wouldSet: RawPayload;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseKeyUpdateResult(raw: unknown): KeyUpdateResult {
  const d = asObject(raw);
  const key = d.key;
  return {
    result: str(d.result),
    key: key && typeof key === "object" ? parseCommunityKey(key) : null,
    descendantKeyCount: num(d.descendant_key_count),
    keyId: str(d.key_id),
    wouldSet: asObject(d.would_set),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Bulk member/key writes (207 Multi-Status)
// --------------------------------------------------------------------------- //

/** One `{phoneNumber, keyIds}` item for `community.bulkAddMembers()`. */
export interface BulkAddItem {
  phoneNumber: string;
  keyIds: readonly string[];
}

/**
 * One `{accountCommunityId, keyIds}` item for the bulk key writes
 * (`bulkGrantKeys`, `bulkRevokeKeys`, `bulkSetKeysDisabled`).
 */
export interface BulkKeyItem {
  accountCommunityId: number;
  keyIds: readonly string[];
}

/**
 * One item's outcome inside a bulk response, in request order.
 *
 * `ok` is the only thing that says whether this item's work happened — the
 * batch's 207 says the batch ran, not that every item succeeded. `code` and
 * `message` explain a failure (`already_member`, `member_not_accepted`,
 * `key_not_held`, ...). `accountCommunityId` / `phoneNumber` echo the input
 * identifier so results can be zipped against the items you sent; endpoint
 * extras (`granted`, `revoked_key_ids`, `key_ids`, `account_id`, ...) are on
 * `raw`.
 */
export interface BulkItemResult {
  index: number | null;
  ok: boolean;
  accountCommunityId: number | null;
  phoneNumber: string | null;
  code: string | null;
  message: string | null;
  raw: RawPayload;
}

export function parseBulkItemResult(raw: unknown): BulkItemResult {
  const d = asObject(raw);
  return {
    index: num(d.index),
    ok: bool(d.ok),
    accountCommunityId: num(d.account_community_id),
    phoneNumber: str(d.phone_number),
    code: str(d.code),
    message: str(d.message),
    raw: d,
  };
}

/**
 * Result of a bulk write — HTTP **207**, one entry per input item.
 *
 * A 207 means the batch was processed, not that it worked: check `failed` (or
 * walk `failures`) before treating a bulk call as done. Whole-batch rejections
 * — a foreign member or key, an over-size batch, a duplicate — never reach here:
 * they throw with nothing applied.
 *
 * ```ts
 * const res = await client.community.bulkGrantKeys(items);
 * for (const bad of res.failures) console.log(bad.index, bad.code, bad.message);
 * ```
 */
export interface BulkResult {
  result: string | null;
  requestId: string | null;
  /** True when a test-mode key validated the batch without applying it. */
  simulated: boolean;
  total: number | null;
  succeeded: number | null;
  failed: number | null;
  results: BulkItemResult[];
  /** The subset of `results` whose `ok` is false — re-submit these. */
  failures: BulkItemResult[];
  raw: RawPayload;
}

export function parseBulkResult(raw: unknown): BulkResult {
  const d = asObject(raw);
  const summary = asObject(d.summary);
  const results = arr(d.results).map(parseBulkItemResult);
  return {
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: bool(d.simulated) || d.result === "simulated",
    total: num(summary.total),
    succeeded: num(summary.succeeded),
    failed: num(summary.failed),
    results,
    failures: results.filter((r) => !r.ok),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Recurring hold-open schedules + the disable override
// --------------------------------------------------------------------------- //

/**
 * One recurring hold-open schedule.
 *
 * `daysOfTheWeek` is a letter string from `MTWHFSU` — **H is Thursday**, `S` is
 * Saturday, `U` is Sunday — the same string the writes accept, so a schedule
 * can be read and posted back unchanged. `temporalTimes` holds the window(s) in
 * the **latch's local time**; an empty list is an all-day schedule, which is
 * the supported way to say "all day", not a mistake. `active` is whether the
 * window is holding the gate open right now.
 */
export interface RecurringSchedule {
  temporalDateId: string | null;
  daysOfTheWeek: string | null;
  recurringWeek: number | null;
  startDate: string | null;
  endDate: string | null;
  temporalTimes: RawPayload[];
  active: boolean;
  raw: RawPayload;
}

export function parseRecurringSchedule(raw: unknown): RecurringSchedule {
  const d = asObject(raw);
  return {
    temporalDateId: str(d.temporal_date_id),
    daysOfTheWeek: str(d.days_of_the_week),
    recurringWeek: num(d.recurring_week),
    startDate: str(d.start_date),
    endDate: str(d.end_date),
    temporalTimes: arr(d.temporal_times).map(asObject),
    active: bool(d.active),
    raw: d,
  };
}

/**
 * Result of `community.addHoldOpenRecurring()` /
 * `community.updateHoldOpenRecurring()`.
 *
 * Keep `temporalDateId` — it addresses the schedule for later changes and is
 * the same id `community.holdOpens()` reports under `recurring[]`. On a
 * test-mode call `schedule` is null and `wouldSet` echoes the validated input.
 */
export interface RecurringHoldOpenResult {
  result: string | null;
  latchId: string | null;
  temporalDateId: string | null;
  schedule: RecurringSchedule | null;
  wouldSet: RawPayload;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseRecurringHoldOpenResult(
  raw: unknown,
): RecurringHoldOpenResult {
  const d = asObject(raw);
  const schedule = d.schedule;
  return {
    result: str(d.result),
    latchId: str(d.latch_id),
    temporalDateId: str(d.temporal_date_id),
    schedule:
      schedule && typeof schedule === "object"
        ? parseRecurringSchedule(schedule)
        : null,
    wouldSet: asObject(d.would_set ?? d.would_add),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * Result of `community.removeHoldOpenRecurring()`.
 *
 * Unlike the one-time event remove, this is **not** idempotent: an id that is
 * not on this latch throws {@link NotFoundError} rather than reporting
 * `removed: false`, so a caller can never believe it cancelled a schedule that
 * is still holding a gate open.
 */
export interface RecurringHoldOpenRemoved {
  result: string | null;
  removed: boolean;
  latchId: string | null;
  temporalDateId: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseRecurringHoldOpenRemoved(
  raw: unknown,
): RecurringHoldOpenRemoved {
  const d = asObject(raw);
  return {
    result: str(d.result),
    removed: bool(d.removed),
    latchId: str(d.latch_id),
    temporalDateId: str(d.temporal_date_id),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * Result of `community.setHoldOpenDisabledUntil()`.
 *
 * `disabledUntil` is the moment the suspension lifts, in the **latch's local
 * time** — the same value `community.holdOpens()` reports. `heldOpen` is the
 * latch's state after the change: setting a suspension releases a hold that a
 * schedule was applying. Null `disabledUntil` means schedules are running.
 */
export interface HoldOpenDisabledUntil {
  result: string | null;
  latchId: string | null;
  disabledUntil: string | null;
  heldOpen: boolean | null;
  /** Test mode only: the value a live key would have written. */
  wouldSet: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseHoldOpenDisabledUntil(raw: unknown): HoldOpenDisabledUntil {
  const d = asObject(raw);
  return {
    result: str(d.result),
    latchId: str(d.latch_id),
    disabledUntil: str(d.disabled_until),
    heldOpen: typeof d.held_open === "boolean" ? d.held_open : null,
    wouldSet: str(d.would_set),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Webhook deliveries
// --------------------------------------------------------------------------- //

/**
 * One attempt to POST an event to a webhook's URL.
 *
 * `status` is `pending`, `delivered`, or `failed`; `attempts` counts tries so
 * far and `lastStatusCode` / `lastError` describe the most recent one.
 * `nextAttemptDatetime` is set while Nimbio is still retrying.
 *
 * `lastError` includes the first part of **your own** endpoint's response body
 * on a non-2xx reply — what makes a broken receiver diagnosable. If your error
 * pages carry anything sensitive, treat this field accordingly.
 *
 * The event payload Nimbio sent is not echoed back here.
 */
export interface WebhookDelivery {
  deliveryId: string | null;
  eventId: string | null;
  eventType: string | null;
  status: string | null;
  attempts: number | null;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptDatetime: string | null;
  createdDatetime: string | null;
  deliveredDatetime: string | null;
  raw: RawPayload;
}

export function parseWebhookDelivery(raw: unknown): WebhookDelivery {
  const d = asObject(raw);
  return {
    deliveryId: str(d.delivery_id),
    eventId: str(d.event_id),
    eventType: str(d.event_type),
    status: str(d.status),
    attempts: num(d.attempts),
    lastStatusCode: num(d.last_status_code),
    lastError: str(d.last_error),
    nextAttemptDatetime: str(d.next_attempt_datetime),
    createdDatetime: str(d.created_datetime),
    deliveredDatetime: str(d.delivered_datetime),
    raw: d,
  };
}

export function parseWebhookDeliveries(raw: unknown): WebhookDelivery[] {
  const d = asObject(raw);
  return arr(d.deliveries).map(parseWebhookDelivery);
}

/**
 * One re-sent delivery.
 *
 * `deliveryId` is new — a replay is a new delivery row — while `eventId` is the
 * **original** event's id, which is what the `X-Nimbio-Delivery` header carries.
 * `replayedFromDeliveryId` points back at the attempt this re-sends.
 */
export interface DeliveryReplay {
  deliveryId: string | null;
  replayedFromDeliveryId: string | null;
  eventId: string | null;
  eventType: string | null;
  status: string | null;
  createdDatetime: string | null;
  raw: RawPayload;
}

export function parseDeliveryReplay(raw: unknown): DeliveryReplay {
  const d = asObject(raw);
  return {
    deliveryId: str(d.delivery_id),
    replayedFromDeliveryId: str(d.replayed_from_delivery_id),
    eventId: str(d.event_id),
    eventType: str(d.event_type),
    status: str(d.status),
    createdDatetime: str(d.created_datetime),
    raw: d,
  };
}

/**
 * Result of `community.replayDelivery()` — the new delivery that was enqueued.
 *
 * A test-mode key returns `result: "simulated"` and enqueues nothing, so the
 * replay fields are null.
 */
export interface DeliveryReplayResult extends DeliveryReplay {
  result: string | null;
  webhookId: string | null;
  requestId: string | null;
  simulated: boolean;
}

export function parseDeliveryReplayResult(raw: unknown): DeliveryReplayResult {
  const d = asObject(raw);
  return {
    ...parseDeliveryReplay(d),
    result: str(d.result),
    webhookId: str(d.webhook_id),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
  };
}

/**
 * Result of `community.retryFailedDeliveries()` — what was actually enqueued.
 *
 * `replayedCount` is how many re-sends were queued; `skippedInFlight` counts
 * deliveries left alone because Nimbio was still retrying them (a retry never
 * races its own backoff), and `skippedDuplicateEvent` counts candidates
 * collapsed because an earlier one carried the same event id. Calling this
 * twice in a row therefore re-sends nothing the second time.
 *
 * A test-mode key returns `result: "simulated"` and enqueues nothing.
 */
export interface RetryFailedResult {
  result: string | null;
  webhookId: string | null;
  replayedCount: number | null;
  replayed: DeliveryReplay[];
  skippedInFlight: number | null;
  skippedDuplicateEvent: number | null;
  limit: number | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseRetryFailedResult(raw: unknown): RetryFailedResult {
  const d = asObject(raw);
  return {
    result: str(d.result),
    webhookId: str(d.webhook_id),
    replayedCount: num(d.replayed_count),
    replayed: arr(d.replayed).map(parseDeliveryReplay),
    skippedInFlight: num(d.skipped_in_flight),
    skippedDuplicateEvent: num(d.skipped_duplicate_event),
    limit: num(d.limit),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Community settings
// --------------------------------------------------------------------------- //

/** The resolved labels one side of the terminology currently shows members. */
export interface TerminologyLabels {
  singular: string | null;
  plural: string | null;
  icon: string | null;
  raw: RawPayload;
}

export function parseTerminologyLabels(raw: unknown): TerminologyLabels {
  const d = asObject(raw);
  return {
    singular: str(d.singular),
    plural: str(d.plural),
    icon: str(d.icon),
    raw: d,
  };
}

/**
 * One label the property type offers in its picker.
 *
 * Set `memberTerminologyOptionId` / `homeTerminologyOptionId` to
 * `terminologyOptionId` to adopt it. A picker option and a custom label are
 * mutually exclusive on the same side — choosing one clears the other.
 */
export interface TerminologyOption {
  terminologyOptionId: number | null;
  labelSingular: string | null;
  labelPlural: string | null;
  icon: string | null;
  raw: RawPayload;
}

export function parseTerminologyOption(raw: unknown): TerminologyOption {
  const d = asObject(raw);
  return {
    terminologyOptionId: num(d.terminology_option_id),
    labelSingular: str(d.label_singular),
    labelPlural: str(d.label_plural),
    icon: str(d.icon),
    raw: d,
  };
}

/** The labels in force, per side. */
export interface Terminology {
  member: TerminologyLabels;
  home: TerminologyLabels;
  raw: RawPayload;
}

export function parseTerminology(raw: unknown): Terminology {
  const d = asObject(raw);
  return {
    member: parseTerminologyLabels(d.member),
    home: parseTerminologyLabels(d.home),
    raw: d,
  };
}

/** The labels the community's property type offers, per side. */
export interface TerminologyOptions {
  member: TerminologyOption[];
  home: TerminologyOption[];
  raw: RawPayload;
}

export function parseTerminologyOptions(raw: unknown): TerminologyOptions {
  const d = asObject(raw);
  return {
    member: arr(d.member).map(parseTerminologyOption),
    home: arr(d.home).map(parseTerminologyOption),
    raw: d,
  };
}

/**
 * The fifteen settings an API key may change, as the server currently holds
 * them. Everything here is writable through `community.updateSettings()`;
 * anything gated by Nimbio lives on {@link CommunitySettingsReadOnly} instead.
 */
export interface CommunitySettingsValues {
  allowDirectoryViewing: boolean;
  allowDirectoryAccessCodes: boolean;
  isNewMemberRequestHomeEnabled: boolean;
  limitedUseLinksMembersOnly: boolean;
  limitedUseLinksRequireAccount: boolean;
  eventKeysRequireAccount: boolean;
  /** `"inherit"` | `"allow"` | `"deny"` — the *override*, not the answer. */
  eventKeysOverride: string | null;
  memberTerminologyOptionId: number | null;
  memberTermCustom: string | null;
  memberTermCustomPlural: string | null;
  memberIcon: string | null;
  homeTerminologyOptionId: number | null;
  homeTermCustom: string | null;
  homeTermCustomPlural: string | null;
  homeIcon: string | null;
  raw: RawPayload;
}

export function parseCommunitySettingsValues(
  raw: unknown,
): CommunitySettingsValues {
  const d = asObject(raw);
  return {
    allowDirectoryViewing: bool(d.allow_directory_viewing),
    allowDirectoryAccessCodes: bool(d.allow_directory_access_codes),
    isNewMemberRequestHomeEnabled: bool(d.is_new_member_request_home_enabled),
    limitedUseLinksMembersOnly: bool(d.limited_use_links_members_only),
    limitedUseLinksRequireAccount: bool(d.limited_use_links_require_account),
    eventKeysRequireAccount: bool(d.event_keys_require_account),
    eventKeysOverride: str(d.event_keys_override),
    memberTerminologyOptionId: num(d.member_terminology_option_id),
    memberTermCustom: str(d.member_term_custom),
    memberTermCustomPlural: str(d.member_term_custom_plural),
    memberIcon: str(d.member_icon),
    homeTerminologyOptionId: num(d.home_terminology_option_id),
    homeTermCustom: str(d.home_term_custom),
    homeTermCustomPlural: str(d.home_term_custom_plural),
    homeIcon: str(d.home_icon),
    raw: d,
  };
}

/**
 * The flags Nimbio provisions for the community — readable here, never
 * writable from an API key.
 *
 * This block is **feature discovery**, and the reason `settings()` is worth
 * calling: each flag gates a whole endpoint family, so without it the only way
 * to learn a feature is off is to call it and take a 403.
 *
 * - `allowHoldOpens` false — every `/v1/community/hold-opens` read and write 403s.
 * - `isOpenLogHistoryEnabled` false — `accessLog()` and `gateStatusLog()` 403.
 * - `eventKeysEnabled` is the **resolved** answer for event keys: the settable
 *   `eventKeysOverride` (`inherit`/`allow`/`deny`) combined with the property
 *   type's default. Read this, not the override, to know whether event keys work.
 * - `accessCodeMode` (`per_member` / `single_entry`) is the one read-only value
 *   an API key *can* change — but only through `community.setAccessCodeMode()`,
 *   because switching it deletes every access code in the community and needs
 *   an explicit confirm. Sending it to `updateSettings()` is 422 `invalid_setting`.
 */
export interface CommunitySettingsReadOnly {
  allowHoldOpens: boolean;
  isOpenLogHistoryEnabled: boolean;
  allowGuestViewEntry: boolean;
  eventKeysEnabled: boolean;
  communityType: number | null;
  /** `"per_member"` or `"single_entry"`; change it with `setAccessCodeMode()`. */
  accessCodeMode: string | null;
  raw: RawPayload;
}

export function parseCommunitySettingsReadOnly(
  raw: unknown,
): CommunitySettingsReadOnly {
  const d = asObject(raw);
  return {
    allowHoldOpens: bool(d.allow_hold_opens),
    isOpenLogHistoryEnabled: bool(d.is_open_log_history_enabled),
    allowGuestViewEntry: bool(d.allow_guest_view_entry),
    eventKeysEnabled: bool(d.event_keys_enabled),
    communityType: num(d.community_type),
    accessCodeMode: str(d.access_code_mode),
    raw: d,
  };
}

/**
 * Result of `community.settings()` and `community.updateSettings()` — the
 * community's whole configuration.
 *
 * `settings` is what you may change, `readOnly` is what Nimbio provisions,
 * `terminology` is the labels currently in force and `terminologyOptions` is
 * what the property type offers instead of a custom label.
 *
 * `changed` names the keys a patch actually applied; it is empty on a read. A
 * write returns the same full object a read does, so nothing needs a follow-up
 * `settings()` — except on a test key, where `result` is `"simulated"` and the
 * settings come back **unchanged**.
 */
export interface CommunitySettings {
  communityId: number | null;
  settings: CommunitySettingsValues;
  readOnly: CommunitySettingsReadOnly;
  terminology: Terminology;
  terminologyOptions: TerminologyOptions;
  /** The keys this patch applied. Empty on a read. */
  changed: string[];
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseCommunitySettings(raw: unknown): CommunitySettings {
  const d = asObject(raw);
  return {
    communityId: num(d.community_id),
    settings: parseCommunitySettingsValues(d.settings),
    readOnly: parseCommunitySettingsReadOnly(d.read_only),
    terminology: parseTerminology(d.terminology),
    terminologyOptions: parseTerminologyOptions(d.terminology_options),
    changed: arr(d.changed).filter((x): x is string => typeof x === "string"),
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * A settings patch, as `community.updateSettings()` accepts it.
 *
 * The fifteen settable keys are typed in camelCase and translated to the
 * wire's snake_case. **Any other key is sent through verbatim**, deliberately:
 * the API rejects an unknown setting with 422 `invalid_setting` naming it, and
 * silently dropping a typo here would turn that loud rejection into a write
 * that appears to succeed and changes nothing. It also means a key copied
 * straight out of the REST docs (`allow_directory_viewing`) works unchanged.
 */
export interface CommunitySettingsInput {
  allowDirectoryViewing?: boolean;
  allowDirectoryAccessCodes?: boolean;
  isNewMemberRequestHomeEnabled?: boolean;
  limitedUseLinksMembersOnly?: boolean;
  limitedUseLinksRequireAccount?: boolean;
  eventKeysRequireAccount?: boolean;
  /** `"inherit"` (use the property type's default), `"allow"` or `"deny"`. */
  eventKeysOverride?: "inherit" | "allow" | "deny";
  /** Clears `memberTermCustom` — a picker option and a custom label exclude each other. */
  memberTerminologyOptionId?: number | null;
  /** Max 255 chars, no control characters. `""` or null restores the default. */
  memberTermCustom?: string | null;
  memberTermCustomPlural?: string | null;
  /** Max 64 chars. */
  memberIcon?: string | null;
  /** Clears `homeTermCustom`. */
  homeTerminologyOptionId?: number | null;
  /** Max 255 chars, no control characters. `""` or null restores the default. */
  homeTermCustom?: string | null;
  homeTermCustomPlural?: string | null;
  /** Max 64 chars. */
  homeIcon?: string | null;
  /** Anything else is forwarded unchanged, for the server to accept or reject. */
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Homes / units roster
// --------------------------------------------------------------------------- //

/** One resident attached to a home, as `community.home()` reports them. */
export interface HomeMember {
  accountCommunityId: number | null;
  accountId: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  phoneNumbers: string[];
  accepted: boolean;
  /** `"YYYY-MM-DD"`, or null when no move-out is recorded. */
  moveOutDate: string | null;
  raw: RawPayload;
}

export function parseHomeMember(raw: unknown): HomeMember {
  const d = asObject(raw);
  const firstName = str(d.first_name);
  const lastName = str(d.last_name);
  return {
    accountCommunityId: num(d.account_community_id),
    accountId: str(d.account_id),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ").trim(),
    phoneNumbers: arr(d.phone_numbers).filter(
      (x): x is string => typeof x === "string",
    ),
    accepted: bool(d.accepted),
    moveOutDate: str(d.move_out_date),
    raw: d,
  };
}

/**
 * One home (unit) in the community.
 *
 * `members` is populated by the single-home read `community.home(homeId)`;
 * `community.homes()` carries only `memberCount`, so an empty `members` in a
 * list row means "not asked for", not "nobody lives here".
 */
export interface Home {
  homeId: string | null;
  name: string | null;
  address: string | null;
  ownerOccupied: boolean;
  hidden: boolean;
  homePhone: string | null;
  homeEmail: string | null;
  ownerName: string | null;
  createdDatetime: string | null;
  memberCount: number;
  members: HomeMember[];
  raw: RawPayload;
}

export function parseHome(raw: unknown): Home {
  const d = asObject(raw);
  return {
    homeId: str(d.home_id),
    name: str(d.name),
    address: str(d.address),
    ownerOccupied: bool(d.owner_occupied),
    hidden: bool(d.hidden),
    homePhone: str(d.home_phone),
    homeEmail: str(d.home_email),
    ownerName: str(d.owner_name),
    createdDatetime: str(d.created_datetime),
    memberCount: num(d.member_count) ?? 0,
    members: arr(d.members).map(parseHomeMember),
    raw: d,
  };
}

export function parseHomes(raw: unknown): Home[] {
  return arr(asObject(raw).homes).map(parseHome);
}

export function parseHomeDetail(raw: unknown): Home {
  return parseHome(asObject(raw).home);
}

/**
 * Result of `community.addHome()` and `community.updateHome()`.
 *
 * `home` is the full resource, so a roster sync never needs a follow-up read.
 * A **test-mode** key validates and creates nothing: `result` is `"simulated"`,
 * `home` is null, and `wouldSet` echoes what the call would have applied.
 */
export interface HomeWriteResult {
  home: Home | null;
  homeId: string | null;
  /** Test mode only — the change the server would have made. */
  wouldSet: RawPayload | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseHomeWriteResult(raw: unknown): HomeWriteResult {
  const d = asObject(raw);
  const home = d.home === undefined || d.home === null ? null : parseHome(d.home);
  const wouldSet = d.would_set ?? d.would_create;
  return {
    home,
    homeId: str(d.home_id) ?? home?.homeId ?? null,
    wouldSet: wouldSet == null ? null : asObject(wouldSet),
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * Result of `community.removeHome()`.
 *
 * `detachedMemberCount` is the blast radius: how many residents were detached
 * from the home. They stay members and keep their keys, but lose their unit
 * association, and **nothing restores it**. A test-mode key reports the count
 * it *would* detach (`result: "simulated"`, `deleted` false) and changes
 * nothing.
 */
export interface HomeRemoved {
  homeId: string | null;
  deleted: boolean;
  detachedMemberCount: number;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseHomeRemoved(raw: unknown): HomeRemoved {
  const d = asObject(raw);
  return {
    homeId: str(d.home_id),
    deleted: bool(d.deleted),
    // Test mode reports the same number under a different name; a caller
    // checking the blast radius must get it either way.
    detachedMemberCount:
      num(d.detached_member_count) ?? num(d.would_detach_member_count) ?? 0,
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * Result of `community.setMoveOutDate()` — the date now recorded, or null if
 * it was cleared. A test-mode key echoes the date it would have set.
 */
export interface MoveOutDateResult {
  accountCommunityId: number | null;
  /** `"YYYY-MM-DD"`, or null when the date was cleared. */
  moveOutDate: string | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseMoveOutDateResult(raw: unknown): MoveOutDateResult {
  const d = asObject(raw);
  return {
    accountCommunityId: num(d.account_community_id),
    // Test mode returns the same value as `would_set`.
    moveOutDate: str(d.move_out_date) ?? str(d.would_set),
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// My member-open notification settings (per MANAGER, not per community)
// --------------------------------------------------------------------------- //

/**
 * One window during which this manager's member-open alerts are suppressed.
 *
 * `daysOfTheWeek` is letters from `MTWHFSU` where **H is Thursday**, S is
 * Saturday and U is Sunday, and it names the day the window **starts** on.
 * Times are `"HH:MM"`, 24-hour; both null means all day on those days.
 *
 * **A quiet-hours window may wrap past midnight** — `22:00`–`06:00` is one
 * window, not two, and `"24:00"` is *not* accepted here. That is the opposite
 * of a recurring hold open and of a key access schedule, which cannot wrap and
 * use `"24:00"` as the end-of-day sentinel. Carrying the hold-open rule across
 * fails silently: two half-windows suppress nothing at the hours you meant.
 *
 * Evaluated in the **opened gate's** local timezone — not the manager's, not
 * UTC.
 */
export interface QuietHoursWindow {
  quietHoursId: number | string | null;
  daysOfTheWeek: string;
  startTime: string | null;
  endTime: string | null;
  raw: RawPayload;
}

export function parseQuietHoursWindow(raw: unknown): QuietHoursWindow {
  const d = asObject(raw);
  return {
    quietHoursId: num(d.quiet_hours_id) ?? str(d.quiet_hours_id),
    daysOfTheWeek: str(d.days_of_the_week) ?? "",
    startTime: str(d.start_time),
    endTime: str(d.end_time),
    raw: d,
  };
}

/**
 * Member-open notification settings for **the community manager who owns the
 * API key** — not for the community, and not for its other managers.
 *
 * All four notification endpoints return this same full object, so no write
 * needs a follow-up read.
 *
 * `enabled` is whether that manager is pushed a notification when a member
 * opens a gate. `featureAvailable` is whether the community allows the feature
 * at all: when it is false every write returns 403
 * `open_notifications_disabled` and `enabled` has no effect.
 */
export interface NotificationSettings {
  enabled: boolean;
  featureAvailable: boolean;
  quietHours: QuietHoursWindow[];
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseNotificationSettings(raw: unknown): NotificationSettings {
  const d = asObject(raw);
  return {
    enabled: bool(d.enabled),
    featureAvailable: bool(d.feature_available),
    quietHours: arr(d.quiet_hours).map(parseQuietHoursWindow),
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Guest access — the gate shape shared by all four families
// --------------------------------------------------------------------------- //

/**
 * A gate as the guest-access endpoints name it: an id and a display name.
 *
 * The guest-link, GuestView Entry and access-code reads all carry gates in this
 * shape. Most spell them `latch_id` / `latch_name`; the access-code list spells
 * the same pair `id` / `name`, so both are accepted here and land on the same
 * two fields.
 */
export interface GuestLatch {
  latchId: string | null;
  latchName: string | null;
  raw: RawPayload;
}

export function parseGuestLatch(raw: unknown): GuestLatch {
  const d = asObject(raw);
  return {
    latchId: str(d.latch_id) ?? str(d.id),
    latchName: str(d.latch_name) ?? str(d.name),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Guest links
// --------------------------------------------------------------------------- //

/**
 * One guest link.
 *
 * **`token` and `url` are secret material.** Anyone holding the URL can open
 * the gates in `latches` — no account, no key, no login. Treat this object the
 * way you would treat a password: do not log it, do not put it in an error
 * report, do not persist it anywhere you would not persist a credential. Both
 * fields are returned by the **list** read as well as by create, so a dumped
 * listing is a dumped set of working gate links.
 *
 * `state` is computed live, not stored: `active`, `upcoming` (an event link
 * whose window has not opened), `expired`, `spent` (a limited-use link out of
 * opens), `revoked`, or `feature_disabled`.
 *
 * The limit fields depend on `linkType`. An `event` link uses `windowStart` /
 * `windowEnd` and has no use cap; a `limited_use` link uses `maxUses` /
 * `usesConsumed` with `expiresAt` as a wall-clock backstop. `totalOpens` counts
 * gate opens either way, which is not the same as `usesConsumed` when one use
 * opens several gates.
 */
export interface GuestLink {
  guestLinkId: number | null;
  communityId: number | null;
  /** `"event"` | `"limited_use"`. */
  linkType: string | null;
  /** Live-computed: `active` | `upcoming` | `expired` | `spent` | `revoked` | `feature_disabled`. */
  state: string | null;
  title: string | null;
  subtitle: string | null;
  extraInfo: string | null;
  /** **Secret.** The bearer token behind `url`. */
  token: string | null;
  /** **Secret.** The ready-to-send link — holding it is enough to open the gate. */
  url: string | null;
  keyId: string | null;
  keyName: string | null;
  latches: GuestLatch[];
  /** `limited_use` only. */
  maxUses: number | null;
  usesConsumed: number | null;
  totalOpens: number | null;
  notifyOnUse: boolean;
  revoked: boolean;
  revokedDatetime: string | null;
  /** Wall-clock backstop (`limited_use`), UTC. */
  expiresAt: string | null;
  /** `event` only, UTC. */
  windowStart: string | null;
  windowEnd: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
  createdByAccountId: string | null;
  createdByCm: boolean;
  createdByName: string | null;
  raw: RawPayload;
}

export function parseGuestLink(raw: unknown): GuestLink {
  const d = asObject(raw);
  return {
    guestLinkId: num(d.guest_link_id),
    communityId: num(d.community_id),
    linkType: str(d.link_type),
    state: str(d.state),
    title: str(d.title),
    subtitle: str(d.subtitle),
    extraInfo: str(d.extra_info),
    token: str(d.token),
    url: str(d.url),
    keyId: str(d.key_id),
    keyName: str(d.key_name),
    latches: arr(d.latches).map(parseGuestLatch),
    maxUses: num(d.max_uses),
    usesConsumed: num(d.uses_consumed),
    totalOpens: num(d.total_opens),
    notifyOnUse: bool(d.notify_on_use),
    revoked: bool(d.revoked),
    revokedDatetime: str(d.revoked_datetime),
    expiresAt: str(d.expires_at),
    windowStart: str(d.window_start),
    windowEnd: str(d.window_end),
    lastUsedAt: str(d.last_used_at),
    createdAt: str(d.created_at),
    createdByAccountId: str(d.created_by_account_id),
    createdByCm: bool(d.created_by_cm),
    createdByName: str(d.created_by_name),
    raw: d,
  };
}

/**
 * Result of `community.guestLinks()` — every link on the community, newest
 * first.
 *
 * **Each entry carries its `token` and `url`**, so this whole array is secret
 * material. See {@link GuestLink}.
 */
export function parseGuestLinks(raw: unknown): GuestLink[] {
  return arr(asObject(raw).guest_links).map(parseGuestLink);
}

/**
 * Result of `community.createGuestLink()` and `community.revokeGuestLink()`.
 *
 * `guestLink` is the full resource — **including the secret `token` and
 * `url`** — so a create never needs a follow-up read. A test-mode key
 * validates and writes nothing: `result` is `"simulated"`, and what the call
 * would have done is echoed rather than applied.
 */
export interface GuestLinkResult {
  guestLink: GuestLink | null;
  guestLinkId: number | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseGuestLinkResult(raw: unknown): GuestLinkResult {
  const d = asObject(raw);
  // Test mode reports the same resource under a `would_*` name; a caller
  // inspecting what a simulated call touched must get it either way.
  const src = d.guest_link ?? d.would_revoke ?? d.would_create ?? null;
  const guestLink = src == null ? null : parseGuestLink(src);
  return {
    guestLink,
    guestLinkId: num(d.guest_link_id) ?? guestLink?.guestLinkId ?? null,
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * One attempt against a guest link.
 *
 * **This is guest PII**: `clientIp` and `userAgent` identify the person who
 * stood at the gate. `result` is the outcome — `opened`, a refusal, or a
 * rate-limited hit. `useNumber` is which use of a limited-use link this was.
 */
export interface GuestLinkLogEntry {
  guestLinkLogId: number | null;
  guestLinkId: number | null;
  linkTitle: string | null;
  linkType: string | null;
  latchId: string | null;
  latchName: string | null;
  logDatetime: string | null;
  result: string | null;
  useNumber: number | null;
  clientIp: string | null;
  userAgent: string | null;
  raw: RawPayload;
}

export function parseGuestLinkLogEntry(raw: unknown): GuestLinkLogEntry {
  const d = asObject(raw);
  return {
    guestLinkLogId: num(d.guest_link_log_id),
    guestLinkId: num(d.guest_link_id),
    linkTitle: str(d.link_title),
    linkType: str(d.link_type),
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    logDatetime: str(d.log_datetime),
    result: str(d.result),
    useNumber: num(d.use_number),
    clientIp: str(d.client_ip),
    userAgent: str(d.user_agent),
    raw: d,
  };
}

/** One page of guest-link attempts, newest first. */
export interface GuestLinkLogPage {
  logs: GuestLinkLogEntry[];
  limit: number | null;
  offset: number | null;
  raw: RawPayload;
}

export function parseGuestLinkLogPage(raw: unknown): GuestLinkLogPage {
  const d = asObject(raw);
  return {
    logs: arr(d.logs).map(parseGuestLinkLogEntry),
    limit: num(d.limit),
    offset: num(d.offset),
    raw: d,
  };
}

/**
 * Gates the community has taken out of each guest-link type.
 *
 * **Absence is permission**: a gate that is not listed may back a link of that
 * type, so an empty answer means every gate the backing key opens is
 * offerable. The exclusions are **per link type** — a gate barred from `event`
 * links may still be fine for `limited_use` ones — which is why `event` and
 * `limitedUse` are separate lists rather than one set.
 *
 * `excludedLatchIds` is the raw map keyed by link type; `event` and
 * `limitedUse` are views onto it for the two types that exist today, and a
 * type this client predates still appears in the map.
 */
export interface GuestLinkLatchExclusions {
  /** Link type -> excluded latch ids, exactly as the server sent it. */
  excludedLatchIds: Record<string, string[]>;
  /** Gates that may not back an `event` link. */
  event: string[];
  /** Gates that may not back a `limited_use` link. */
  limitedUse: string[];
  raw: RawPayload;
}

export function parseGuestLinkLatchExclusions(
  raw: unknown,
): GuestLinkLatchExclusions {
  const d = asObject(raw);
  const map: Record<string, string[]> = {};
  for (const [linkType, ids] of Object.entries(asObject(d.excluded_latch_ids))) {
    map[linkType] = arr(ids).filter((x): x is string => typeof x === "string");
  }
  return {
    excludedLatchIds: map,
    event: map.event ?? [],
    limitedUse: map.limited_use ?? [],
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Access codes (keypad / GuestView PINs)
// --------------------------------------------------------------------------- //

/**
 * One access code as the list reports it.
 *
 * **The PIN is never here.** `codeMasked` is a run of asterisks and
 * `codeLength` its length; the cleartext is returned exactly once, by
 * `community.createAccessCode()`. A lost PIN is not recoverable — delete the
 * code and mint a new one.
 *
 * `apiManaged` is true for the codes this API key created, and those are the
 * only ones {@link parseAccessCodeWriteResult}'s endpoints (update, delete)
 * will touch; anything else answers 404.
 */
export interface AccessCode {
  directoryAccessCodeId: number | null;
  accountId: string | null;
  ownerName: string | null;
  apiManaged: boolean;
  /** Asterisks, never the digits. */
  codeMasked: string | null;
  codeLength: number | null;
  /**
   * The owner's 3-letter preamble in `single_entry` mode — what the visitor
   * types before the code. Null in `per_member` mode.
   */
  preamble: string | null;
  /** `preamble` + masked code (e.g. `ESM******`); null in `per_member` mode. */
  entryCodeMasked: string | null;
  disabled: boolean;
  /** Absolute UTC cutoff, or null for none. */
  expiresAt: string | null;
  /** Whether a recurring weekly window is attached. */
  hasSchedule: boolean;
  latchIds: string[];
  latches: GuestLatch[];
  createdAt: string | null;
  raw: RawPayload;
}

export function parseAccessCode(raw: unknown): AccessCode {
  const d = asObject(raw);
  return {
    directoryAccessCodeId: num(d.directory_access_code_id),
    accountId: str(d.account_id),
    ownerName: str(d.owner_name),
    apiManaged: bool(d.api_managed),
    codeMasked: str(d.code_masked),
    codeLength: num(d.code_length),
    preamble: str(d.preamble),
    entryCodeMasked: str(d.entry_code_masked),
    disabled: bool(d.disabled),
    expiresAt: str(d.expires_at),
    hasSchedule: bool(d.has_schedule),
    latchIds: arr(d.latch_ids).filter((x): x is string => typeof x === "string"),
    latches: arr(d.latches).map(parseGuestLatch),
    createdAt: str(d.created_at),
    raw: d,
  };
}

/**
 * Result of `community.accessCodes()` — every code in the community, residents'
 * own included, matching what the CM portal shows.
 *
 * `featureEnabled` mirrors the community's Directory Access Codes setting;
 * when it is false the writes return 403 `access_codes_disabled`.
 */
export interface AccessCodes {
  accessCodes: AccessCode[];
  featureEnabled: boolean;
  /**
   * `"per_member"` or `"single_entry"` — the same value
   * `community.accessCodeMode()` reports, so a caller rendering the rows
   * knows whether to show `codeMasked` or `entryCodeMasked` without a second
   * round trip.
   */
  accessCodeMode: string | null;
  result: string | null;
  raw: RawPayload;
}

export function parseAccessCodes(raw: unknown): AccessCodes {
  const d = asObject(raw);
  return {
    accessCodes: arr(d.access_codes).map(parseAccessCode),
    featureEnabled: bool(d.feature_enabled),
    accessCodeMode: str(d.access_code_mode),
    result: str(d.result),
    raw: d,
  };
}

/**
 * The freshly minted code — **the only place the cleartext PIN ever appears**.
 *
 * `code` is what you type on the keypad; `codeNormalized` is the server's
 * canonical form of it. Deliver it to the visitor now: no later call reveals
 * it, and `community.accessCodes()` shows asterisks.
 */
export interface NewAccessCode {
  directoryAccessCodeId: number | null;
  /** **Secret** — the cleartext PIN, returned exactly once. */
  code: string | null;
  codeNormalized: string | null;
  /**
   * The key owner's 3-letter preamble in `single_entry` mode; null in
   * `per_member` mode.
   */
  preamble: string | null;
  /**
   * **Secret** — `preamble` + `code` (e.g. `ESM481502`), the full string the
   * visitor types in `single_entry` mode. Returned exactly once, like `code`.
   * Null in `per_member` mode, where the visitor types `code` alone.
   */
  entryCode: string | null;
  accountId: string | null;
  keyId: string | null;
  latchIds: string[];
  raw: RawPayload;
}

export function parseNewAccessCode(raw: unknown): NewAccessCode {
  const d = asObject(raw);
  return {
    directoryAccessCodeId: num(d.directory_access_code_id),
    code: str(d.code),
    codeNormalized: str(d.code_normalized),
    preamble: str(d.preamble),
    entryCode: str(d.entry_code),
    accountId: str(d.account_id),
    keyId: str(d.key_id),
    latchIds: arr(d.latch_ids).filter((x): x is string => typeof x === "string"),
    raw: d,
  };
}

/**
 * Result of `community.createAccessCode()`.
 *
 * **`code` is the cleartext PIN and comes back exactly once.** Store or deliver
 * it in this call or it is gone. A test-mode key validates and creates nothing
 * (`result: "simulated"`).
 *
 * What the visitor types depends on the community's access-code mode
 * (`community.accessCodeMode()`): `code` in `per_member` mode, `entryCode`
 * (preamble + code) in `single_entry` mode. Hand out `entryCode` when it is
 * non-null; it is returned only here, like `code`.
 */
export interface AccessCodeCreateResult {
  accessCode: NewAccessCode | null;
  /** Convenience mirror of `accessCode.code` — the cleartext PIN. */
  code: string | null;
  /**
   * Convenience mirror of `accessCode.entryCode` — preamble + PIN, the full
   * string a visitor types in `single_entry` mode. Null in `per_member` mode.
   */
  entryCode: string | null;
  directoryAccessCodeId: number | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseAccessCodeCreateResult(raw: unknown): AccessCodeCreateResult {
  const d = asObject(raw);
  const src = d.access_code ?? d.would_create ?? null;
  const accessCode = src == null ? null : parseNewAccessCode(src);
  return {
    accessCode,
    code: accessCode?.code ?? null,
    entryCode: accessCode?.entryCode ?? null,
    directoryAccessCodeId:
      num(d.directory_access_code_id) ?? accessCode?.directoryAccessCodeId ?? null,
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * Result of `community.updateAccessCode()` and `community.deleteAccessCode()`.
 *
 * The API echoes only what it touched, so `accessCode` is a partial object
 * rather than the whole resource — read `community.accessCodes()` if you need
 * the full row back. `disabled` is lifted out of that echo because switching a
 * code off after a visit is the common update. A test-mode key validates and
 * changes nothing.
 */
export interface AccessCodeWriteResult {
  directoryAccessCodeId: number | null;
  /** The server's partial echo of the row, or null when it sent none. */
  accessCode: RawPayload | null;
  /** From the echo; null when the write did not touch it. */
  disabled: boolean | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseAccessCodeWriteResult(raw: unknown): AccessCodeWriteResult {
  const d = asObject(raw);
  const echo = d.access_code ?? d.would_set ?? null;
  const inner = echo == null ? null : asObject(echo);
  return {
    directoryAccessCodeId:
      num(d.directory_access_code_id) ??
      (inner ? num(inner.directory_access_code_id) : null),
    accessCode: inner,
    disabled:
      inner && typeof inner.disabled === "boolean" ? inner.disabled : null,
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * Result of `community.accessCodeEligibleLatches()` — the gates a community
 * manager has allowed access codes to open.
 *
 * Every `latchIds` entry passed to create or update must appear here or the
 * call is rejected with `invalid_latch`. **This allowlist is set in the CM
 * portal only** — the API can read it, not change it.
 */
export interface AccessCodeEligibleLatches {
  latches: GuestLatch[];
  /** The community's Directory Access Codes setting; false 403s every write. */
  featureEnabled: boolean;
  result: string | null;
  raw: RawPayload;
}

export function parseAccessCodeEligibleLatches(
  raw: unknown,
): AccessCodeEligibleLatches {
  const d = asObject(raw);
  return {
    latches: arr(d.latches).map(parseGuestLatch),
    featureEnabled: bool(d.feature_enabled),
    result: str(d.result),
    raw: d,
  };
}

/**
 * One access-code entry attempt.
 *
 * `codeEnteredMasked` is asterisks, never the typed digits — a successful
 * attempt's entered code *is* a working PIN. `directoryAccessCodeId` is set
 * whenever the entry matched an existing code, which is how you correlate a row
 * to a code you minted. `result` names the outcome: `opened`,
 * `code_not_found`, `code_disabled`, `code_expired`, `temporal_blocked`,
 * `latch_not_assigned`, `open_failed`, ...
 */
export interface AccessCodeLogEntry {
  directoryAccessCodeLogId: number | null;
  directoryAccessCodeId: number | null;
  accountId: string | null;
  ownerName: string | null;
  latchId: string | null;
  logDatetime: string | null;
  result: string | null;
  /** Asterisks, never the typed digits. */
  codeEnteredMasked: string | null;
  clientIp: string | null;
  raw: RawPayload;
}

export function parseAccessCodeLogEntry(raw: unknown): AccessCodeLogEntry {
  const d = asObject(raw);
  return {
    directoryAccessCodeLogId: num(d.directory_access_code_log_id),
    directoryAccessCodeId: num(d.directory_access_code_id),
    accountId: str(d.account_id),
    ownerName: str(d.owner_name),
    latchId: str(d.latch_id),
    logDatetime: str(d.log_datetime),
    result: str(d.result),
    codeEnteredMasked: str(d.code_entered_masked),
    clientIp: str(d.client_ip),
    raw: d,
  };
}

/** One page of access-code entry attempts, newest first. */
export interface AccessCodeLogPage {
  logs: AccessCodeLogEntry[];
  limit: number | null;
  offset: number | null;
  raw: RawPayload;
}

export function parseAccessCodeLogPage(raw: unknown): AccessCodeLogPage {
  const d = asObject(raw);
  return {
    logs: arr(d.logs).map(parseAccessCodeLogEntry),
    limit: num(d.limit),
    offset: num(d.offset),
    raw: d,
  };
}

/**
 * What switching the community's access-code mode would do — or, after a
 * confirmed switch on a test key, would have done.
 *
 * Every count is community-wide: `codesToDelete` is **every** access code in
 * the community, residents' own included, because the strings change meaning
 * between modes; `membersAffected` is how many members lose at least one code
 * and will be notified; `membersToAssignPreamble` is how many members would be
 * given a 3-letter preamble (zero when switching back to `per_member`).
 *
 * Reached three ways, all the same shape: `community.accessCodeMode()` reports
 * it as `flipPreview` (`mode` is null there — the status carries the current
 * mode itself); an unconfirmed `community.setAccessCodeMode()` throws
 * `ConflictError` carrying it as `.preview`; and a confirmed test-key switch
 * returns it as `wouldChange`.
 */
export interface AccessCodeModePreview {
  /** The mode currently in force. Null on `flipPreview`, where the status reports it. */
  mode: string | null;
  /** The mode the switch would move to. */
  newMode: string | null;
  codesToDelete: number | null;
  membersAffected: number | null;
  membersToAssignPreamble: number | null;
  raw: RawPayload;
}

export function parseAccessCodeModePreview(raw: unknown): AccessCodeModePreview {
  const d = asObject(raw);
  return {
    mode: str(d.mode),
    newMode: str(d.new_mode),
    codesToDelete: num(d.codes_to_delete),
    membersAffected: num(d.members_affected),
    membersToAssignPreamble: num(d.members_to_assign_preamble),
    raw: d,
  };
}

/**
 * Result of `community.accessCodeMode()` — which of the two access-code
 * systems the community runs, and what switching to the other would cost.
 *
 * `mode` is `"per_member"` or `"single_entry"` (see `ACCESS_CODE_MODES`);
 * `flipPreview` is a read-only dry run of `community.setAccessCodeMode()` to
 * the *other* mode. Read it before you flip, so you can show the cost to a
 * human first.
 */
export interface AccessCodeModeStatus {
  mode: string | null;
  flipPreview: AccessCodeModePreview;
  result: string | null;
  raw: RawPayload;
}

export function parseAccessCodeModeStatus(raw: unknown): AccessCodeModeStatus {
  const d = asObject(raw);
  return {
    mode: str(d.mode),
    flipPreview: parseAccessCodeModePreview(d.flip_preview),
    result: str(d.result),
    raw: d,
  };
}

/**
 * Result of a `community.setAccessCodeMode()` call that did **not** throw.
 *
 * Three outcomes share this shape; branch on `changed` and `simulated`:
 *
 * - **Already in that mode** — `changed: false`, nothing deleted, `mode` is
 *   the mode in force. Happens with or without `confirm`.
 * - **Switched (live key, `confirm: true`)** — `changed: true`; `deletedCodes`
 *   and `notifiedMembers` report what the switch did.
 * - **Validated (test key, `confirm: true`)** — `simulated: true`,
 *   `changed: false`, and `wouldChange` holds the preview of what a live key
 *   would have done. Nothing was deleted or notified, and `mode` is **null**:
 *   nothing moved, so there is no mode in force to report. The mode the call
 *   asked for is `wouldChange.newMode`; the one the community still runs is
 *   `wouldChange.mode`.
 *
 * The fourth outcome, a switch that needs confirming, is not a result at all:
 * it throws `ConflictError` (409 `requires_confirmation`) with `.preview`.
 */
export interface AccessCodeModeChange {
  /** The mode in force after the call. Null on a simulated call — nothing moved. */
  mode: string | null;
  /** True only when a live key actually switched the community. */
  changed: boolean;
  /** Codes removed by a live switch; null when nothing changed or was simulated. */
  deletedCodes: number | null;
  /** Members notified by a live switch; null when nothing changed or was simulated. */
  notifiedMembers: number | null;
  /** What a test-key switch *would* have done. Null on a live call. */
  wouldChange: AccessCodeModePreview | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseAccessCodeModeChange(raw: unknown): AccessCodeModeChange {
  const d = asObject(raw);
  const wouldChange =
    d.would_change == null ? null : parseAccessCodeModePreview(d.would_change);
  return {
    // Deliberately no fallback to wouldChange.newMode on a simulated call:
    // nothing moved, and the Python client answers None for the same payload.
    mode: str(d.mode),
    changed: bool(d.changed),
    deletedCodes: num(d.deleted_codes),
    notifiedMembers: num(d.notified_members),
    wouldChange,
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * A recurring weekly window on an access code, as create and update accept it.
 *
 * **The wire keys here are `start` and `end`, not `start_time` / `end_time`** —
 * this is the one schedule shape in the API that spells them that way, and the
 * camelCase names below are translated for you.
 *
 * Evaluated in the **gate's own local timezone** at redemption — not UTC, not
 * the caller's zone. It never expires on its own; pair it with
 * `expiresInHours` / `expiresInDays` for a cutoff, and a code carrying both
 * must satisfy both.
 *
 * `daysOfTheWeek` is letters from `MTWHFSU` (**H is Thursday**, U is Sunday).
 */
export interface AccessCodeTemporalInput {
  daysOfTheWeek?: string;
  /** `"HH:MM"`, 24-hour. */
  start?: string | null;
  end?: string | null;
  recurringWeek?: number;
}

// --------------------------------------------------------------------------- //
// GuestView Entry
// --------------------------------------------------------------------------- //

/**
 * One recurring window during which GuestView Entry is permitted.
 *
 * **Evaluated in the latch's own local timezone**, at the moment a visitor taps
 * open — never UTC, never yours. `daysOfTheWeek` is letters from `MTWHFSU`
 * (**H is Thursday**, U is Sunday) naming the day the window **starts**, and
 * times are `"HH:MM"` 24-hour, or null for an unbounded end.
 *
 * A latch with **no** windows is available to guests at any hour: the schedule
 * is a whitelist of permitted times, so the first window you add is what starts
 * restricting that gate.
 */
export interface GuestViewEntryScheduleWindow {
  scheduleId: number | null;
  latchId: string | null;
  latchName: string | null;
  daysOfTheWeek: string;
  startTime: string | null;
  endTime: string | null;
  raw: RawPayload;
}

export function parseGuestViewEntryScheduleWindow(
  raw: unknown,
): GuestViewEntryScheduleWindow {
  const d = asObject(raw);
  return {
    scheduleId: num(d.schedule_id),
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    daysOfTheWeek: str(d.days_of_the_week) ?? "",
    startTime: str(d.start_time),
    endTime: str(d.end_time),
    raw: d,
  };
}

/**
 * The community's whole GuestView Entry configuration.
 *
 * Every GuestView Entry call except the log read returns this same full object,
 * so no write needs a follow-up read.
 *
 * - `allowed` — the community master switch.
 * - `eligibleLatches` — the gates a visitor may open. Nothing outside this set
 *   is reachable, whatever the schedule says.
 * - `schedule` — the recurring windows, **each evaluated in its own latch's
 *   local timezone**. A latch with no windows is open to guests at any hour.
 * - `directoryViewingEnabled` — read-only context: whether the GuestView
 *   *directory listing* is on. Separate feature; guest entry does not need it.
 *
 * `createdScheduleIds` is populated by `community.addGuestViewEntrySchedule()`
 * (one id per latch the window was applied to) and `removedScheduleId` by
 * `community.removeGuestViewEntrySchedule()`; both are empty/null elsewhere.
 */
export interface GuestViewEntry {
  allowed: boolean;
  directoryViewingEnabled: boolean;
  eligibleLatches: GuestLatch[];
  schedule: GuestViewEntryScheduleWindow[];
  /** `"latch_local"` — the zone the windows above are read in. */
  scheduleTimezone: string | null;
  /** Set by the schedule add: one id per latch the window landed on. */
  createdScheduleIds: number[];
  /** Set by the schedule remove. */
  removedScheduleId: number | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseGuestViewEntry(raw: unknown): GuestViewEntry {
  const d = asObject(raw);
  const g = asObject(d.guest_view_entry);
  return {
    allowed: bool(g.allowed),
    directoryViewingEnabled: bool(g.directory_viewing_enabled),
    eligibleLatches: arr(g.eligible_latches).map(parseGuestLatch),
    schedule: arr(g.schedule).map(parseGuestViewEntryScheduleWindow),
    scheduleTimezone: str(g.schedule_timezone),
    createdScheduleIds: arr(d.created_schedule_ids).filter(
      (x): x is number => typeof x === "number",
    ),
    removedScheduleId: num(d.removed_schedule_id),
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * One GuestView Entry attempt.
 *
 * **These rows identify visitors**: name, phone number and IP of the person who
 * stood at the gate. `result` is `opened` or a failure reason —
 * `outside_schedule`, `latch_not_eligible`, `rate_limited`, `scan_required`, ...
 */
export interface GuestViewEntryLogEntry {
  guestViewEntryLogId: number | null;
  accountId: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  phone: string | null;
  clientIp: string | null;
  latchId: string | null;
  latchName: string | null;
  logDatetime: string | null;
  result: string | null;
  raw: RawPayload;
}

export function parseGuestViewEntryLogEntry(raw: unknown): GuestViewEntryLogEntry {
  const d = asObject(raw);
  const firstName = str(d.first_name);
  const lastName = str(d.last_name);
  return {
    guestViewEntryLogId: num(d.guest_view_entry_log_id),
    accountId: str(d.account_id),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ").trim(),
    phone: str(d.phone),
    clientIp: str(d.client_ip),
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    logDatetime: str(d.log_datetime),
    result: str(d.result),
    raw: d,
  };
}

/**
 * One page of GuestView Entry attempts, newest first. `hasMore` is true when
 * the page came back full.
 */
export interface GuestViewEntryLogPage {
  logs: GuestViewEntryLogEntry[];
  limit: number | null;
  offset: number | null;
  hasMore: boolean;
  raw: RawPayload;
}

export function parseGuestViewEntryLogPage(raw: unknown): GuestViewEntryLogPage {
  const d = asObject(raw);
  return {
    logs: arr(d.logs).map(parseGuestViewEntryLogEntry),
    limit: num(d.limit),
    offset: num(d.offset),
    hasMore: bool(d.has_more),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// GuestView short codes
// --------------------------------------------------------------------------- //

/**
 * One GuestView short code — what a visitor types, or reaches via the QR on a
 * placard, to open the community's guest directory.
 *
 * `latchId` is the gate the code routes to, and is null for a code that opens
 * the directory without preselecting one. **Short codes are unique across all
 * of Nimbio**, not just your community, and there is no way to delete one.
 */
export interface ShortCode {
  shortCode: string | null;
  communityId: number | null;
  latchId: string | null;
  latchName: string | null;
  disabled: boolean;
  requireSecurityCode: boolean;
  createdAt: string | null;
  lastUpdatedDatetime: string | null;
  raw: RawPayload;
}

export function parseShortCode(raw: unknown): ShortCode {
  const d = asObject(raw);
  return {
    shortCode: str(d.short_code),
    communityId: num(d.community_id),
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    disabled: bool(d.disabled),
    requireSecurityCode: bool(d.require_security_code),
    createdAt: str(d.created_at),
    lastUpdatedDatetime: str(d.last_updated_datetime),
    raw: d,
  };
}

export function parseShortCodes(raw: unknown): ShortCode[] {
  return arr(asObject(raw).short_codes).map(parseShortCode);
}

/**
 * Result of `community.createShortCode()` and `community.assignShortCode()` —
 * the full resource, so neither needs a follow-up read. A test-mode key
 * validates against your community and changes nothing.
 */
export interface ShortCodeResult {
  shortCode: ShortCode | null;
  /** The code string itself, lifted out of `shortCode` for convenience. */
  code: string | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseShortCodeResult(raw: unknown): ShortCodeResult {
  const d = asObject(raw);
  const src = d.short_code ?? d.would_create ?? d.would_set ?? null;
  const shortCode = src == null ? null : parseShortCode(src);
  return {
    shortCode,
    code: shortCode?.shortCode ?? null,
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// NFC tags
// --------------------------------------------------------------------------- //

/**
 * One NFC tag (fob or card) issued to the community.
 *
 * **Nothing here is secret.** `tagUidHex` is the fob's physical UID, which any
 * reader can see by holding it near the tag; it is published here because it is
 * the join key between a tag and its rows in
 * {@link Community.nfcScanLog | nfcScanLog()}. Cryptographic tag material is
 * never returned by this API at all.
 *
 * `latchId` is the gate the tag opens — a tag opens the gate it is bound to,
 * not a member's key — and is null while the tag is detached. `disabled` is the
 * kill switch: a disabled tag is refused at the gate on the next physical tap.
 *
 * `notes` is reported but **not writable over the API**; it is set in the CM
 * portal. Programming a blank fob is likewise a separate operator-side job with
 * a card reader — this surface manages tags that already exist.
 */
export interface NfcTag {
  tagId: number | null;
  /** Nimbio's printed serial for the fob, e.g. `"NFC-7K2MQ9XA"`. */
  tagSerial: string | null;
  /** The fob's publicly readable physical UID — the scan-log join key. */
  tagUidHex: string | null;
  /** The gate this tag opens, or null while detached. */
  latchId: string | null;
  /** True once the tag is killed: the next tap on any gate is refused. */
  disabled: boolean;
  /** Free text from the CM portal. Readable here, not writable. */
  notes: string | null;
  lastScanAt: string | null;
  createdAt: string | null;
  lastUpdatedDatetime: string | null;
  raw: RawPayload;
}

export function parseNfcTag(raw: unknown): NfcTag {
  const d = asObject(raw);
  return {
    tagId: num(d.tag_id),
    tagSerial: str(d.tag_serial),
    tagUidHex: str(d.tag_uid_hex),
    latchId: str(d.latch_id),
    disabled: bool(d.disabled),
    notes: str(d.notes),
    lastScanAt: str(d.last_scan_at),
    createdAt: str(d.created_at),
    lastUpdatedDatetime: str(d.last_updated_datetime),
    raw: d,
  };
}

/** One page of NFC tags, newest first. */
export interface NfcTagPage {
  items: NfcTag[];
  /** 1-based, floored at 1. */
  page: number | null;
  /** Clamped to 1..200 by the server. */
  resultsPerPage: number | null;
  /** Total matching tags, not the page length. */
  total: number | null;
  raw: RawPayload;
}

export function parseNfcTagPage(raw: unknown): NfcTagPage {
  const d = asObject(raw);
  return {
    items: arr(d.items).map(parseNfcTag),
    page: num(d.page),
    resultsPerPage: num(d.results_per_page),
    total: num(d.total),
    raw: d,
  };
}

/** Unwrap the `{result, tag}` envelope of the single-tag read. */
export function parseNfcTagDetail(raw: unknown): NfcTag {
  return parseNfcTag(asObject(raw).tag);
}

/**
 * Result of `community.updateNfcTag()`.
 *
 * A live key gets the tag back as it now stands, in `tag`. A **test key
 * changes no physical credential**: it answers `result: "simulated"` with
 * `wouldChange` holding just the fields the call would have written, and `tag`
 * is null — so read `simulated` before assuming a fob was actually revoked.
 */
export interface NfcTagWriteResult {
  /** The updated tag; null on a simulated (test-key) write. */
  tag: NfcTag | null;
  /** What a test-key call *would* have changed. Null on a live write. */
  wouldChange: RawPayload | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseNfcTagWriteResult(raw: unknown): NfcTagWriteResult {
  const d = asObject(raw);
  return {
    tag: d.tag == null ? null : parseNfcTag(d.tag),
    wouldChange: d.would_change == null ? null : asObject(d.would_change),
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

/**
 * One recorded NFC tap.
 *
 * `result` is what the reader made of the tap and `openOutcome` what the gate
 * then did, so a tag that read fine but did not open is distinguishable from
 * one that was refused outright. `firstName` / `lastName` are filled in when
 * the tap resolved to a member, which is what lets a security review attribute
 * a tap to a person; the device's IP address and Nimbio-internal record ids are
 * deliberately not exposed.
 *
 * `tagUidHex` is what joins a row back to a {@link NfcTag}.
 */
export interface NfcScanLogEntry {
  scanLogId: number | null;
  scannedAt: string | null;
  tagId: number | null;
  tagSerial: string | null;
  tagUidHex: string | null;
  latchId: string | null;
  latchName: string | null;
  /** How the scan itself resolved, e.g. `"ok"`. */
  result: string | null;
  /** What the gate did afterwards, e.g. `"opened"`. */
  openOutcome: string | null;
  /** The tapping member, when the tap resolved to one. */
  firstName: string | null;
  lastName: string | null;
  raw: RawPayload;
}

export function parseNfcScanLogEntry(raw: unknown): NfcScanLogEntry {
  const d = asObject(raw);
  return {
    scanLogId: num(d.scan_log_id),
    scannedAt: str(d.scanned_at),
    tagId: num(d.tag_id),
    tagSerial: str(d.tag_serial),
    tagUidHex: str(d.tag_uid_hex),
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    result: str(d.result),
    openOutcome: str(d.open_outcome),
    firstName: str(d.first_name),
    lastName: str(d.last_name),
    raw: d,
  };
}

/** One page of NFC taps, newest first. */
export interface NfcScanLogPage {
  items: NfcScanLogEntry[];
  limit: number | null;
  offset: number | null;
  total: number | null;
  raw: RawPayload;
}

export function parseNfcScanLogPage(raw: unknown): NfcScanLogPage {
  const d = asObject(raw);
  return {
    items: arr(d.items).map(parseNfcScanLogEntry),
    limit: num(d.limit),
    offset: num(d.offset),
    total: num(d.total),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Sense lines (the gate-status feedback loop)
// --------------------------------------------------------------------------- //

/** A gate named by the sense-line surface, in `gateStatus()`'s vocabulary. */
export interface SenseLineLatch {
  latchId: string | null;
  latchName: string | null;
  raw: RawPayload;
}

export function parseSenseLineLatch(raw: unknown): SenseLineLatch {
  const d = asObject(raw);
  return { latchId: str(d.latch_id), latchName: str(d.latch_name), raw: d };
}

/** A Nimbio device in scope, with the gates wired to it. */
export interface SenseLineBox {
  boxId: string | null;
  boxName: string | null;
  latches: SenseLineLatch[];
  raw: RawPayload;
}

export function parseSenseLineBox(raw: unknown): SenseLineBox {
  const d = asObject(raw);
  return {
    boxId: str(d.box_id),
    boxName: str(d.box_name),
    latches: arr(d.latches).map(parseSenseLineLatch),
    raw: d,
  };
}

/**
 * One sense line — a physical input on a box that reports whether a gate
 * actually moved.
 *
 * **`reporting` is the field to read.** It is true only when both
 * `senseLineOnline` and `latchDataOnline` are on, which is exactly the
 * condition the backend requires before a transition may update gate status or
 * fire `sense_line.changed`. **A gate stuck on one status with
 * `reporting: false` is a configuration problem, not a stuck gate.**
 *
 * The two flags underneath it mean different things:
 *
 * - `senseLineOnline` — whether the input is switched on at all. Off means the
 *   box's raw transitions are still recorded (see
 *   {@link Community.senseLineRecords | senseLineRecords()}) but the server
 *   acts on none of them.
 * - `latchDataOnline` — whether this input's readings may drive the gate status
 *   reported to the apps and to this API.
 *
 * `senseLineId` is an input number on a board, **unique only within its box** —
 * two boxes in one community both have a "sense line 1", which is why `boxId`
 * is required to address one.
 */
export interface SenseLine {
  /** Half the identity: sense line numbers are per box, not per community. */
  boxId: string | null;
  boxName: string | null;
  /** The input number on the board. Unique within `boxId` only. */
  senseLineId: number | null;
  senseLineOnline: boolean;
  latchDataOnline: boolean;
  /** `senseLineOnline && latchDataOnline` — false means nothing is reported. */
  reporting: boolean;
  latches: SenseLineLatch[];
  createdAt: string | null;
  updatedAt: string | null;
  raw: RawPayload;
}

export function parseSenseLine(raw: unknown): SenseLine {
  const d = asObject(raw);
  return {
    boxId: str(d.box_id),
    boxName: str(d.box_name),
    senseLineId: num(d.sense_line_id),
    senseLineOnline: bool(d.sense_line_online),
    latchDataOnline: bool(d.latch_data_online),
    reporting: bool(d.reporting),
    latches: arr(d.latches).map(parseSenseLineLatch),
    createdAt: str(d.created_at),
    updatedAt: str(d.updated_at),
    raw: d,
  };
}

/** Every sense line in scope, plus the boxes and gates they belong to. */
export interface SenseLines {
  senseLines: SenseLine[];
  /** The boxes in scope with their latches, for naming without a second read. */
  boxes: SenseLineBox[];
  raw: RawPayload;
}

export function parseSenseLines(raw: unknown): SenseLines {
  const d = asObject(raw);
  return {
    senseLines: arr(d.sense_lines).map(parseSenseLine),
    boxes: arr(d.boxes).map(parseSenseLineBox),
    raw: d,
  };
}

/**
 * The configured meaning of one raw state on one input.
 *
 * `transientMs` non-zero means the label is shown briefly and then reverts.
 * This mapping is set when the hardware is installed and is **read-only** over
 * this API — the state a gate is actually in is what the hardware reports, and
 * deliberately not something an API key can fabricate.
 */
export interface SenseLineStatusMapEntry {
  senseLineState: number | null;
  latchId: string | null;
  latchName: string | null;
  /** The label the apps show, e.g. `"Open"` / `"Closed"` / `"Locked"`. */
  status: string | null;
  /** Non-zero: shown briefly, then reverts. */
  transientMs: number | null;
  raw: RawPayload;
}

export function parseSenseLineStatusMapEntry(
  raw: unknown,
): SenseLineStatusMapEntry {
  const d = asObject(raw);
  return {
    senseLineState: num(d.sense_line_state),
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    status: str(d.status),
    transientMs: num(d.transient_ms),
    raw: d,
  };
}

/** The most recent transition the box reported for an input. */
export interface SenseLineLastRecord {
  state: number | null;
  loggedAt: string | null;
  raw: RawPayload;
}

export function parseSenseLineLastRecord(raw: unknown): SenseLineLastRecord {
  const d = asObject(raw);
  return { state: num(d.state), loggedAt: str(d.logged_at), raw: d };
}

/**
 * One sense line with everything needed to explain a gate's status — the shape
 * both the single read and the reconfigure write return.
 *
 * Beyond the flags on {@link SenseLine} it carries `statusMap` (what each raw
 * state means) and `lastRecord` (the last transition the box actually
 * reported). **A `lastRecord` weeks old on a gate that moves daily points at
 * the wiring or the box, not at the configuration** — the opposite diagnosis
 * from `reporting: false`.
 *
 * On a write, `simulated` is true for a test key, which validates and
 * scope-checks but reconfigures no real hardware.
 */
export interface SenseLineDetail extends SenseLine {
  statusMap: SenseLineStatusMapEntry[];
  lastRecord: SenseLineLastRecord | null;
  result: string | null;
  /** True when a test key validated the write instead of applying it. */
  simulated: boolean;
  /** What a simulated write would have set. Null on a live write or a read. */
  wouldSet: RawPayload | null;
}

export function parseSenseLineDetail(raw: unknown): SenseLineDetail {
  const d = asObject(raw);
  return {
    ...parseSenseLine(d),
    statusMap: arr(d.status_map).map(parseSenseLineStatusMapEntry),
    lastRecord:
      d.last_record == null ? null : parseSenseLineLastRecord(d.last_record),
    result: str(d.result),
    simulated: d.result === "simulated" || d.simulated === true,
    wouldSet: d.would_set == null ? null : asObject(d.would_set),
  };
}

/**
 * One raw transition read off a physical input.
 *
 * `status` is the configured label for that `(senseLineId, state)` pair, or
 * **null when the state has no configured meaning** — an unmapped state is
 * itself a finding, so these rows are returned rather than dropped.
 */
export interface SenseLineRecord {
  boxId: string | null;
  boxName: string | null;
  senseLineId: number | null;
  /** The raw state the input reported. */
  state: number | null;
  /** The configured label, or null when this state is unmapped. */
  status: string | null;
  loggedAt: string | null;
  raw: RawPayload;
}

export function parseSenseLineRecord(raw: unknown): SenseLineRecord {
  const d = asObject(raw);
  return {
    boxId: str(d.box_id),
    boxName: str(d.box_name),
    senseLineId: num(d.sense_line_id),
    state: num(d.state),
    status: str(d.status),
    loggedAt: str(d.logged_at),
    raw: d,
  };
}

/** One page of raw transitions, newest first. */
export interface SenseLineRecordPage {
  records: SenseLineRecord[];
  limit: number | null;
  offset: number | null;
  hasMore: boolean;
  raw: RawPayload;
}

export function parseSenseLineRecordPage(raw: unknown): SenseLineRecordPage {
  const d = asObject(raw);
  return {
    records: arr(d.records).map(parseSenseLineRecord),
    limit: num(d.limit),
    offset: num(d.offset),
    hasMore: bool(d.has_more),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Map + geofences
// --------------------------------------------------------------------------- //

/** A WGS84 point in decimal degrees. */
export interface GeoPoint {
  latitude: number | null;
  longitude: number | null;
  raw: RawPayload;
}

export function parseGeoPoint(raw: unknown): GeoPoint {
  const d = asObject(raw);
  return { latitude: num(d.latitude), longitude: num(d.longitude), raw: d };
}

/**
 * One gate's proximity geofence.
 *
 * `radiusMeters` is in **metres** and may not go below `minRadiusMeters`
 * (100) — a smaller value is rejected, never rounded up, because Android's
 * Geofence API and iOS region monitoring both degrade below ~100 m and the
 * fence would read as configured while never firing.
 *
 * `center` is null on a gate that has never had a fence configured; use the
 * latch's `boxLocation` as the suggested centre. `mode` is `"prompt"` (notify
 * the member on arrival, they tap to open) or `"auto_open"`.
 */
export interface Geofence {
  enabled: boolean;
  /** Null on a gate that has never had a centre configured. */
  center: GeoPoint | null;
  /** Metres. Never below `minRadiusMeters`. */
  radiusMeters: number | null;
  /** The floor the mobile apps can honour — 100 m. */
  minRadiusMeters: number | null;
  /** `"prompt"` or `"auto_open"` — see `GEOFENCE_MODES`. */
  mode: string | null;
  updatedByAccountId: string | null;
  updatedDatetime: string | null;
  raw: RawPayload;
}

export function parseGeofence(raw: unknown): Geofence {
  const d = asObject(raw);
  return {
    enabled: bool(d.enabled),
    center: d.center == null ? null : parseGeoPoint(d.center),
    radiusMeters: num(d.radius_meters),
    minRadiusMeters: num(d.min_radius_meters),
    mode: str(d.mode),
    updatedByAccountId: str(d.updated_by_account_id),
    updatedDatetime: str(d.updated_datetime),
    raw: d,
  };
}

/** A gate on the map, with its device's location and its own geofence. */
export interface MapLatch {
  latchId: string | null;
  latchName: string | null;
  boxId: string | null;
  /** The device's location — the suggested centre when `geofence.center` is null. */
  boxLocation: GeoPoint | null;
  geofence: Geofence | null;
  raw: RawPayload;
}

export function parseMapLatch(raw: unknown): MapLatch {
  const d = asObject(raw);
  return {
    latchId: str(d.latch_id),
    latchName: str(d.latch_name),
    boxId: str(d.box_id),
    boxLocation: d.box_location == null ? null : parseGeoPoint(d.box_location),
    geofence: d.geofence == null ? null : parseGeofence(d.geofence),
    raw: d,
  };
}

/** One Nimbio device on the map, with its gates. */
export interface MapBox {
  boxId: string | null;
  boxName: string | null;
  location: GeoPoint | null;
  latches: MapLatch[];
  raw: RawPayload;
}

export function parseMapBox(raw: unknown): MapBox {
  const d = asObject(raw);
  return {
    boxId: str(d.box_id),
    boxName: str(d.box_name),
    location: d.location == null ? null : parseGeoPoint(d.location),
    latches: arr(d.latches).map(parseMapLatch),
    raw: d,
  };
}

/**
 * Where the community's gates are, and the geofence each one advertises.
 *
 * **These coordinates say exactly where a property's entrances are.** The
 * response is scoped to your community key; treating it as physical-security
 * information downstream — logs, caches, analytics — is on you.
 */
export interface CommunityMap {
  boxes: MapBox[];
  communityLocation: GeoPoint | null;
  /** The smallest radius the mobile apps can honour — 100 m. */
  minRadiusMeters: number | null;
  /** The legal values for a geofence `mode`. See `GEOFENCE_MODES`. */
  geofenceModes: string[];
  requestId: string | null;
  raw: RawPayload;
}

export function parseCommunityMap(raw: unknown): CommunityMap {
  const d = asObject(raw);
  return {
    boxes: arr(d.boxes).map(parseMapBox),
    communityLocation:
      d.community_location == null ? null : parseGeoPoint(d.community_location),
    minRadiusMeters: num(d.min_radius_meters),
    geofenceModes: arr(d.geofence_modes).filter(
      (x): x is string => typeof x === "string",
    ),
    requestId: str(d.request_id),
    raw: d,
  };
}

/**
 * Result of `community.updateGeofence()` — the gate as it now stands, echoing
 * the **effective** `radiusMeters` so you can confirm what is in force.
 *
 * A test key validates and scope-checks but never moves a real gate's fence:
 * `simulated` is true, `latch` is null, and `wouldSet` holds what the call
 * would have written.
 */
export interface GeofenceWriteResult {
  /** The updated gate; null on a simulated (test-key) write. */
  latch: MapLatch | null;
  /** Lifted out of `latch`, and still present on a simulated write. */
  latchId: string | null;
  /** The effective fence after the write; null on a simulated one. */
  geofence: Geofence | null;
  /** What a simulated write would have set. Null on a live write. */
  wouldSet: RawPayload | null;
  /** Echoed on a simulated write so the 100 m floor is visible either way. */
  minRadiusMeters: number | null;
  result: string | null;
  requestId: string | null;
  simulated: boolean;
  raw: RawPayload;
}

export function parseGeofenceWriteResult(raw: unknown): GeofenceWriteResult {
  const d = asObject(raw);
  const latch = d.latch == null ? null : parseMapLatch(d.latch);
  return {
    latch,
    latchId: str(d.latch_id) ?? latch?.latchId ?? null,
    geofence: latch?.geofence ?? null,
    wouldSet: d.would_set == null ? null : asObject(d.would_set),
    minRadiusMeters:
      num(d.min_radius_meters) ?? latch?.geofence?.minRadiusMeters ?? null,
    result: str(d.result),
    requestId: str(d.request_id),
    simulated: d.result === "simulated",
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Configuration change log
// --------------------------------------------------------------------------- //

/**
 * One configuration change — who changed what, when.
 *
 * Every row of every trail carries this same envelope; `details` holds the
 * subject of the change and is the part that varies by `logType`
 * (`latch_id` / `latch_name` for `hold_open`, `guest_view` and `guest_link`,
 * `key_id` for `key_schedule`).
 *
 * **`logId` is unique only within its own `logType`** — do not use it as a
 * global key. `datetime` is ISO-8601 UTC (`+00:00`), not community-local time.
 *
 * `accountDisplayName` names the manager or admin who made the change.
 * `key_schedule` summaries are prefixed with the key's name, which for a member
 * key is usually that member's name; guest names and phone numbers never appear
 * in any of these trails.
 */
export interface ChangeLogEntry {
  /** Which trail this row came from — the `type` that was asked for. */
  logType: string | null;
  /** Unique within `logType` only. */
  logId: number | null;
  /** ISO-8601 UTC. */
  datetime: string | null;
  accountId: string | null;
  accountDisplayName: string | null;
  actionType: string | null;
  summary: string | null;
  /** The subject of the change; the keys vary by `logType`. */
  details: RawPayload;
  raw: RawPayload;
}

export function parseChangeLogEntry(raw: unknown): ChangeLogEntry {
  const d = asObject(raw);
  return {
    logType: str(d.log_type),
    logId: num(d.log_id),
    datetime: str(d.datetime),
    accountId: str(d.account_id),
    accountDisplayName: str(d.account_display_name),
    actionType: str(d.action_type),
    summary: str(d.summary),
    details: asObject(d.details),
    raw: d,
  };
}

/**
 * One page of configuration changes, newest first.
 *
 * `days`, `dateFrom` and `dateTo` are the window the server **actually** used:
 * every trail is pruned at 30 days, so a wider `days` is clamped rather than
 * rejected and nothing older is recoverable here. Export on a schedule if you
 * need a longer archive.
 */
export interface ChangeLogPage {
  logs: ChangeLogEntry[];
  /** The trail that was read. */
  logType: string | null;
  /** The look-back actually used, after the 30-day cap. */
  days: number | null;
  /** Effective window start (`from` on the wire). */
  dateFrom: string | null;
  /** Effective window end (`to` on the wire). */
  dateTo: string | null;
  limit: number | null;
  offset: number | null;
  total: number | null;
  hasMore: boolean;
  raw: RawPayload;
}

export function parseChangeLogPage(raw: unknown): ChangeLogPage {
  const d = asObject(raw);
  return {
    logs: arr(d.logs).map(parseChangeLogEntry),
    logType: str(d.log_type),
    days: num(d.days),
    dateFrom: str(d.from),
    dateTo: str(d.to),
    limit: num(d.limit),
    offset: num(d.offset),
    total: num(d.total),
    hasMore: bool(d.has_more),
    raw: d,
  };
}

// --------------------------------------------------------------------------- //
// Key usage report
// --------------------------------------------------------------------------- //

/**
 * One open in the key-usage report.
 *
 * **`user` means different things per community**: read
 * {@link KeyUsageReport.reportType} before interpreting it. On a `commercial`
 * community it is the actual opener; on a `residential` one it is
 * `"<master key owner> Keychain"`.
 *
 * `datetime` is **local time in the community's timezone with no offset
 * attached** — pair it with {@link KeyUsageReport.timezone} before comparing it
 * to anything.
 *
 * `phone` and `location` are personal data, and `phone` does **not** mean what
 * it means on `community.accessLog()`: there it is the account holder's number
 * looked up from the key, here it is whatever the open itself recorded — the
 * **visitor's** number on guest-link, GuestView-entry and access-code opens,
 * and null on ordinary member opens. `location` is the opener's GPS
 * coordinates as `"(x,y)"` when the client sent them.
 */
export interface KeyUsageEntry {
  /** Community-local time, no offset. See `KeyUsageReport.timezone`. */
  datetime: string | null;
  keyName: string | null;
  latchName: string | null;
  openDesc: string | null;
  openResult: string | null;
  reasonDesc: string | null;
  source: string | null;
  /** Attribution depends on `reportType` — see above. */
  user: string | null;
  /** The visitor's number on guest opens; null on ordinary member opens. */
  phone: string | null;
  /** `"(x,y)"` when the client sent coordinates. */
  location: string | null;
  raw: RawPayload;
}

export function parseKeyUsageEntry(raw: unknown): KeyUsageEntry {
  const d = asObject(raw);
  return {
    datetime: str(d.datetime),
    keyName: str(d.key_name),
    latchName: str(d.latch_name),
    openDesc: str(d.open_desc),
    openResult: str(d.open_result),
    reasonDesc: str(d.reason_desc),
    source: str(d.source),
    user: str(d.user),
    phone: str(d.phone),
    location: str(d.location),
    raw: d,
  };
}

/**
 * One page of the key-usage report.
 *
 * **`reportType` decides how `user` reads**, and the server chooses it from the
 * community's property type — there is no parameter for it, because getting it
 * wrong would misreport who opened a gate. `"commercial"` names the actual
 * opener; `"residential"` attributes every open on a household's keys to the
 * account holder as `"<name> Keychain"`. That groups; it does not anonymize.
 *
 * **The window may have been narrowed.** A request wider than `maxRangeDays`
 * (14) is clamped to the most recent allowed span rather than rejected:
 * `dateFrom` / `dateTo` are what was used, `requestedFrom` / `requestedTo` what
 * you asked for, and `clamped` says whether they differ. Walk a longer period
 * in <= 14-day steps. This caps the *width* of one request, not how far back it
 * may sit.
 */
export interface KeyUsageReport {
  logs: KeyUsageEntry[];
  /**
   * `"commercial"` or `"residential"` — how `user` was attributed. See
   * `KEY_USAGE_REPORT_TYPES`; the vocabulary is open, so branch on the known
   * two rather than assuming they are the only ones.
   */
  reportType: string | null;
  /**
   * `reportType === "residential"` — the household-grouped attribution, lifted
   * out because a misspelled string comparison here fails **silently** and the
   * failure misreports who opened a gate.
   *
   * **False does not prove `"commercial"`.** The vocabulary is open, so a rule
   * this client predates reads as false here too. Test `reportType` explicitly
   * if you need to tell "commercial" from "something new".
   */
  residential: boolean;
  page: number | null;
  /** True when the page came back full (1000 rows). */
  hasMore: boolean;
  /** The effective window start (`from` on the wire). */
  dateFrom: string | null;
  /** The effective window end (`to` on the wire). */
  dateTo: string | null;
  requestedFrom: string | null;
  requestedTo: string | null;
  /** True when the requested window was wider than `maxRangeDays`. */
  clamped: boolean;
  /** The widest window one request may span — 14 days. */
  maxRangeDays: number | null;
  /** The community's timezone, which each row's `datetime` is stated in. */
  timezone: string | null;
  raw: RawPayload;
}

export function parseKeyUsageReport(raw: unknown): KeyUsageReport {
  const d = asObject(raw);
  return {
    logs: arr(d.logs).map(parseKeyUsageEntry),
    reportType: str(d.report_type),
    residential: d.report_type === "residential",
    page: num(d.page),
    hasMore: bool(d.has_more),
    dateFrom: str(d.from),
    dateTo: str(d.to),
    requestedFrom: str(d.requested_from),
    requestedTo: str(d.requested_to),
    clamped: bool(d.clamped),
    maxRangeDays: num(d.max_range_days),
    timezone: str(d.timezone),
    raw: d,
  };
}
