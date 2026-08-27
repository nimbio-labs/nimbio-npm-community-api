/**
 * Shared, transport-agnostic core for the client.
 *
 * This module owns everything that does *not* depend on the actual HTTP round
 * trip: configuration resolution, header construction, URL building, response
 * decoding, error mapping, and the retry policy. {@link NimbioClient} adds the
 * small `fetch` loop on top.
 */

import {
  DEFAULT_CACHE_SIZE,
  EtagCache,
  cacheKey,
  isCacheable,
  type CacheStats,
} from "./cache.js";
import * as errors from "./errors.js";
import type { ChangeLogType, GeofenceMode } from "./constants.js";
import { resolveBaseUrl } from "./environments.js";
import * as models from "./models.js";
import { VERSION } from "./version.js";

// A modest default so a hung backend doesn't hang the caller forever. The
// community open is synchronous on the server and can legitimately take
// ~15-18s, so the default read timeout is comfortably above that.
export const DEFAULT_TIMEOUT = 30.0; // seconds
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_BACKOFF_BASE = 0.5; // seconds; doubles each retry

export const ENV_API_KEY = "NIMBIO_API_KEY";
export const ENV_ENVIRONMENT = "NIMBIO_ENV";
export const ENV_BASE_URL = "NIMBIO_BASE_URL";

/** A `fetch`-compatible function. Injectable for testing or custom transports. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** `"test"` for a `nimbio_test_*` key, `"live"` for `nimbio_live_*`. */
export type Mode = "test" | "live";

/** Options accepted by the client constructor. */
export interface ClientOptions {
  /** `"prod"` (default), `"dev"`, or `"local"`. Ignored if `baseUrl` is set. */
  environment?: string;
  /** Explicit base URL; overrides `environment` entirely. */
  baseUrl?: string;
  /** Read timeout in **seconds**. `null` disables the timeout. Default 30. */
  timeout?: number | null;
  /** Max automatic retries for 429/5xx. Default 2. */
  maxRetries?: number;
  /** Extra headers merged into every request. */
  defaultHeaders?: Record<string, string>;
  /** Custom `fetch` implementation (defaults to the global `fetch`). */
  fetch?: FetchLike;
  /**
   * Conditional requests (ETag / `If-None-Match`). **On by default.**
   *
   * Leave it on and GETs revalidate instead of re-downloading: an unchanged
   * response comes back as a bodyless 304, which the API does **not** charge
   * against your monthly quota. Results are identical either way — the cache
   * never supplies a body unless the server says nothing changed. Set `false`
   * to disable.
   */
  cache?: boolean;
  /**
   * Max ETag entries kept (LRU). Default {@link DEFAULT_CACHE_SIZE}. `0`
   * disables caching just as `cache: false` does.
   */
  cacheSize?: number;
}

export interface PreparedRequest {
  method: string;
  /** Path only, without the base URL — the cache and the stream guard key on it. */
  path: string;
  url: string;
  headers: Record<string, string>;
  params: Record<string, string> | null;
  body: RawBody | null;
}

type RawBody = Record<string, unknown>;

/** An endpoint spec: everything needed to issue and parse one request. */
export interface EndpointSpec<T> {
  method: string;
  path: string;
  params?: Record<string, string | number | undefined | null> | null;
  body?: RawBody | null;
  parse: (data: unknown) => T;
}

function readEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process?.env) {
    return process.env[name];
  }
  return undefined;
}

function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Configuration + request/response plumbing shared by the client. */
export abstract class BaseClient {
  readonly baseUrl: string;
  readonly timeout: number | null;
  readonly maxRetries: number;
  protected readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  /** `null` when conditional requests are disabled. */
  private readonly etagCache: EtagCache | null;

  constructor(apiKey?: string, options: ClientOptions = {}) {
    const key = apiKey ?? readEnv(ENV_API_KEY);
    if (!key) {
      throw new errors.NimbioConfigError(
        `No API key provided. Pass an apiKey argument or set the ` +
          `${ENV_API_KEY} environment variable. Keys look like ` +
          `'nimbio_test_...' or 'nimbio_live_...'.`,
      );
    }
    this.apiKey = key;

    const environment = options.environment ?? readEnv(ENV_ENVIRONMENT);
    const baseUrl = options.baseUrl ?? readEnv(ENV_BASE_URL);
    try {
      this.baseUrl = resolveBaseUrl(environment, baseUrl);
    } catch (e) {
      throw new errors.NimbioConfigError((e as Error).message);
    }

    this.timeout =
      options.timeout === undefined ? DEFAULT_TIMEOUT : options.timeout;
    this.maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? DEFAULT_MAX_RETRIES));
    this.extraHeaders = { ...(options.defaultHeaders ?? {}) };

    const cacheSize = Math.trunc(options.cacheSize ?? DEFAULT_CACHE_SIZE);
    const cacheOn = (options.cache ?? true) && cacheSize > 0;
    this.etagCache = cacheOn ? new EtagCache(cacheSize) : null;
  }

  /**
   * `"test"`, `"live"`, or `null` if the key prefix is unrecognized. Derived
   * purely from the key string — no network call. Lets you guard destructive
   * calls, e.g. `if (client.mode !== "test") throw ...`.
   */
  get mode(): Mode | null {
    if (this.apiKey.startsWith("nimbio_test_")) return "test";
    if (this.apiKey.startsWith("nimbio_live_")) return "live";
    return null;
  }

  /** Never includes the API key, so it is safe to log. */
  toString(): string {
    return `${this.constructor.name}(baseUrl=${this.baseUrl}, mode=${this.mode})`;
  }

  // -- request preparation ------------------------------------------------- //

  private headers(auth: boolean): Record<string, string> {
    const base: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `nimbio-community-api-js/${VERSION}`,
    };
    if (auth) base.Authorization = `Bearer ${this.apiKey}`;
    return { ...base, ...this.extraHeaders };
  }

  protected prepare(
    method: string,
    path: string,
    opts: { params?: EndpointSpec<unknown>["params"]; body?: RawBody | null; auth?: boolean } = {},
  ): PreparedRequest {
    const auth = opts.auth ?? true;
    const headers = this.headers(auth);
    if (opts.body != null) headers["Content-Type"] = "application/json";

    let params: Record<string, string> | null = null;
    if (opts.params) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== null) clean[k] = String(v);
      }
      if (Object.keys(clean).length > 0) params = clean;
    }

    return {
      method,
      path,
      url: `${this.baseUrl}${path}`,
      headers,
      params,
      body: opts.body ?? null,
    };
  }

  // -- conditional requests (ETag / If-None-Match) -------------------------- //

  /**
   * Cache statistics for this client: 304s served (`hits`), cacheable GETs that
   * came back with a body (`misses`), and ETags currently stored (`entries`).
   * All zero when conditional requests are disabled.
   *
   * Each hit is a request the API did not bill against your monthly quota — so
   * this is how you confirm the saving is real. Note the per-minute **rate**
   * limit still counts a 304: it is a real request that did real server work.
   */
  get cacheStats(): CacheStats {
    return this.etagCache?.stats() ?? { hits: 0, misses: 0, entries: 0 };
  }

  /** Forget every stored ETag. Rarely needed — the cache never serves stale data. */
  clearCache(): void {
    this.etagCache?.clear();
  }

  /**
   * @internal Attach `If-None-Match` if we hold an ETag for this request, and
   * return the cache key the response should be filed under (`null` when the
   * request is not eligible).
   */
  protected beginConditional(prepared: PreparedRequest): string | null {
    if (!this.etagCache) return null;
    if (!isCacheable(prepared.method, prepared.path)) return null;

    const key = cacheKey(prepared.method, prepared.path, prepared.params);
    const etag = this.etagCache.etagFor(key);
    // An explicit caller-supplied header wins: someone hand-driving conditional
    // requests through `defaultHeaders` is not to be silently overridden.
    // Header names are case-insensitive on the wire, so compare that way.
    const supplied = Object.keys(prepared.headers).some(
      (name) => name.toLowerCase() === "if-none-match",
    );
    if (etag && !supplied) prepared.headers["If-None-Match"] = etag;
    return key;
  }

  /**
   * @internal Resolve a 304 from the cache and return the decoded payload.
   *
   * Decodes the stored **text** every time, so each caller gets a private
   * object graph and a mutated result can never corrupt a later read.
   */
  protected resolveNotModified(key: string | null): unknown {
    const bodyText = key === null ? null : (this.etagCache?.hit(key) ?? null);
    if (bodyText === null) {
      // Only reachable when an `If-None-Match` we did not send came back
      // matched — i.e. a caller supplied one through `defaultHeaders` — or when
      // the entry was evicted mid-flight. There is no body to fall back on.
      throw new errors.APIError(
        "The API answered 304 Not Modified but this client has no cached " +
          "response for the request. This happens when an If-None-Match header " +
          "is supplied via defaultHeaders; remove it and let the client manage " +
          "conditional requests.",
        { status: 304 },
      );
    }
    return this.decode(bodyText) ?? {};
  }

  /**
   * @internal File a full response under `key`, or record the miss. Only 200s
   * carrying an `ETag` are stored — the server decides what is cacheable, this
   * client never second-guesses it with a route list of its own.
   */
  protected finishConditional(
    key: string | null,
    status: number,
    headers: Record<string, string>,
    bodyText: string,
  ): void {
    if (key === null || !this.etagCache) return;
    this.etagCache.miss();
    // `headers` arrives already lower-cased from the fetch `Headers` object,
    // which is itself case-insensitive; look it up in that one canonical form.
    const etag = headers["etag"];
    if (status === 200 && etag && bodyText) this.etagCache.put(key, etag, bodyText);
  }

  // -- response handling --------------------------------------------------- //

  protected decode(bodyText: string): unknown {
    if (!bodyText) return null;
    try {
      return JSON.parse(bodyText);
    } catch {
      // Non-JSON body (e.g. an upstream proxy error page). Preserve text.
      return { _raw_text: bodyText };
    }
  }

  /** Return the decoded JSON for 2xx, or throw the mapped {@link APIError}. */
  protected parseResponse(
    status: number,
    payload: unknown,
    headers: Record<string, string>,
  ): unknown {
    if (status >= 200 && status < 300) {
      return payload ?? {};
    }

    let code: string | null = null;
    let message: string | null = null;
    let requestId: string | null = null;
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const err = p.error;
      if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        code = (e.code as string) ?? null;
        message = (e.message as string) ?? null;
        requestId = (e.request_id as string) ?? null;
      } else {
        message = (p._raw_text as string) ?? (p.message as string) ?? null;
      }
    }
    message = message || `HTTP ${status}`;

    const Klass = errors.exceptionFor(status, code);
    const fields: errors.APIErrorFields & { retryAfter?: number | null } = {
      status,
      code,
      requestId,
      response: payload,
      headers,
    };
    if (Klass === errors.RateLimitError) {
      fields.retryAfter = parseRetryAfter(headers["retry-after"]);
    }
    throw new Klass(message, fields);
  }

  // -- retry policy -------------------------------------------------------- //

  protected shouldRetry(status: number, attempt: number): boolean {
    if (attempt >= this.maxRetries) return false;
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  protected retryDelay(attempt: number, headers?: Record<string, string>): number {
    if (headers) {
      const ra = parseRetryAfter(headers["retry-after"]);
      if (ra !== null) return ra;
    }
    return DEFAULT_BACKOFF_BASE * 2 ** attempt;
  }
}

// --------------------------------------------------------------------------- //
// Endpoint registry — single source of truth for the HTTP surface.
//
// Each builder returns an EndpointSpec. The client consumes these so the wire
// contract lives in exactly one place.
// --------------------------------------------------------------------------- //

function enc(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Wire shape for the `{account_community_id, key_ids}` bulk item. */
function bulkKeyItems(items: readonly models.BulkKeyItem[]): RawBody[] {
  return items.map((i) => ({
    account_community_id: i.accountCommunityId,
    key_ids: [...i.keyIds],
  }));
}

/**
 * Wire shape for an access code's recurring weekly window.
 *
 * The keys are `start` and `end` here, **not** `start_time` / `end_time`: this
 * is the one schedule shape in the API spelled that way, and getting it wrong
 * is a 422 rather than a silent no-op. Only the four documented keys are sent.
 */
function temporalToWire(temporal: models.AccessCodeTemporalInput): RawBody {
  const out: RawBody = {};
  if (temporal.daysOfTheWeek !== undefined)
    out.days_of_the_week = temporal.daysOfTheWeek;
  if (temporal.start !== undefined) out.start = temporal.start;
  if (temporal.end !== undefined) out.end = temporal.end;
  if (temporal.recurringWeek !== undefined)
    out.recurring_week = temporal.recurringWeek;
  return out;
}

/** The fifteen settable community settings, camelCase -> wire snake_case. */
const SETTING_KEYS: Record<string, string> = {
  allowDirectoryViewing: "allow_directory_viewing",
  allowDirectoryAccessCodes: "allow_directory_access_codes",
  isNewMemberRequestHomeEnabled: "is_new_member_request_home_enabled",
  limitedUseLinksMembersOnly: "limited_use_links_members_only",
  limitedUseLinksRequireAccount: "limited_use_links_require_account",
  eventKeysRequireAccount: "event_keys_require_account",
  eventKeysOverride: "event_keys_override",
  memberTerminologyOptionId: "member_terminology_option_id",
  memberTermCustom: "member_term_custom",
  memberTermCustomPlural: "member_term_custom_plural",
  memberIcon: "member_icon",
  homeTerminologyOptionId: "home_terminology_option_id",
  homeTermCustom: "home_term_custom",
  homeTermCustomPlural: "home_term_custom_plural",
  homeIcon: "home_icon",
};

/**
 * Translate a settings patch to the wire.
 *
 * A key that is not one of the fifteen is forwarded **verbatim**, never
 * dropped: the API rejects an unknown setting with 422 `invalid_setting`
 * naming it, and silently swallowing a typo here would turn that loud
 * rejection into a write that reports success and changes nothing. It also
 * lets a snake_case key copied out of the REST docs through unchanged.
 */
function settingsToWire(settings: models.CommunitySettingsInput): RawBody {
  const out: RawBody = {};
  for (const [key, value] of Object.entries(settings ?? {})) {
    out[SETTING_KEYS[key] ?? key] = value;
  }
  return out;
}

export const endpoints = {
  health(): EndpointSpec<models.Health> {
    return { method: "GET", path: "/healthz", parse: models.parseHealth };
  },

  me(): EndpointSpec<models.Me> {
    return { method: "GET", path: "/v1/me", parse: models.parseMe };
  },

  accountKeys(includeHidden = false): EndpointSpec<models.AccountKey[]> {
    return {
      method: "GET",
      path: "/v1/account/keys",
      params: includeHidden ? { include_hidden: "true" } : undefined,
      parse: models.parseAccountKeys,
    };
  },

  accountOpen(
    keyId: string,
    latchId: string,
    note?: string | null,
    idempotencyKey?: string | null,
  ): EndpointSpec<models.OpenResult> {
    const body: RawBody = {};
    if (note != null) body.note = note;
    if (idempotencyKey != null) body.idempotency_key = idempotencyKey;
    return {
      method: "POST",
      path: `/v1/account/keys/${enc(keyId)}/latches/${enc(latchId)}/open`,
      body,
      parse: models.parseOpenResult,
    };
  },

  info(): EndpointSpec<models.CommunityInfo> {
    return {
      method: "GET",
      path: "/v1/community",
      parse: models.parseCommunityInfo,
    };
  },

  gateStatus(): EndpointSpec<models.GateStatus> {
    return {
      method: "GET",
      path: "/v1/community/gate-status",
      parse: models.parseGateStatus,
    };
  },

  members(): EndpointSpec<models.Members> {
    return {
      method: "GET",
      path: "/v1/community/members",
      parse: models.parseMembers,
    };
  },

  membersPage(
    opts: {
      bucket?: string;
      page?: number;
      size?: number;
      search?: string | null;
    } = {},
  ): EndpointSpec<models.MembersPage> {
    return {
      method: "GET",
      path: "/v1/community/members/page",
      params: {
        bucket: opts.bucket ?? "accepted",
        page: opts.page ?? 1,
        size: opts.size ?? 100,
        search: opts.search,
      },
      parse: models.parseMembersPage,
    };
  },

  member(accountCommunityId: number): EndpointSpec<models.MemberDetail> {
    return {
      method: "GET",
      path: `/v1/community/members/${enc(accountCommunityId)}`,
      parse: models.parseMemberDetail,
    };
  },

  messages(limit = 50, offset = 0): EndpointSpec<models.MessagePage> {
    return {
      method: "GET",
      path: "/v1/community/messages",
      params: { limit, offset },
      parse: models.parseMessagePage,
    };
  },

  keyStatuses(): EndpointSpec<models.KeyStatuses> {
    return {
      method: "GET",
      path: "/v1/community/key-statuses",
      parse: models.parseKeyStatuses,
    };
  },

  keys(): EndpointSpec<models.CommunityKey[]> {
    return {
      method: "GET",
      path: "/v1/community/keys",
      parse: models.parseCommunityKeys,
    };
  },

  updateKey(
    keyId: string,
    fields: { name?: string; disabled?: boolean },
  ): EndpointSpec<models.KeyUpdateResult> {
    const body: RawBody = {};
    if (fields.name !== undefined) body.name = fields.name;
    if (fields.disabled !== undefined) body.disabled = fields.disabled;
    return {
      method: "PATCH",
      path: `/v1/community/keys/${enc(keyId)}`,
      body,
      parse: models.parseKeyUpdateResult,
    };
  },

  open(
    latchId: string,
    note?: string | null,
    idempotencyKey?: string | null,
  ): EndpointSpec<models.OpenResult> {
    const body: RawBody = {};
    if (note != null) body.note = note;
    if (idempotencyKey != null) body.idempotency_key = idempotencyKey;
    return {
      method: "POST",
      path: `/v1/community/latches/${enc(latchId)}/open`,
      body,
      parse: models.parseOpenResult,
    };
  },

  message(message: string): EndpointSpec<models.WriteResult> {
    return {
      method: "POST",
      path: "/v1/community/messages",
      body: { message },
      parse: models.parseWriteResult,
    };
  },

  addMember(
    phoneNumber: string,
    keyIds: readonly string[],
  ): EndpointSpec<models.WriteResult> {
    return {
      method: "POST",
      path: "/v1/community/members",
      body: { phone_number: phoneNumber, key_ids: [...keyIds] },
      parse: models.parseWriteResult,
    };
  },

  grantKeys(
    accountCommunityId: number,
    keyIds: readonly string[],
  ): EndpointSpec<models.WriteResult> {
    return {
      method: "POST",
      path: `/v1/community/members/${enc(accountCommunityId)}/grant-keys`,
      body: { key_ids: [...keyIds] },
      parse: models.parseWriteResult,
    };
  },

  revokeKeys(
    accountCommunityId: number,
    keyIds: readonly string[],
    removeMember = false,
  ): EndpointSpec<models.WriteResult> {
    return {
      method: "POST",
      path: `/v1/community/members/${enc(accountCommunityId)}/revoke-keys`,
      body: { key_ids: [...keyIds], remove_member: removeMember },
      parse: models.parseWriteResult,
    };
  },

  setKeysDisabled(
    accountCommunityId: number,
    keyIds: readonly string[],
    disabled: boolean,
  ): EndpointSpec<models.WriteResult> {
    return {
      method: "POST",
      path: `/v1/community/members/${enc(accountCommunityId)}/keys-disabled`,
      body: { key_ids: [...keyIds], disabled },
      parse: models.parseWriteResult,
    };
  },

  approveMember(
    accountCommunityId: number,
    keyIds: readonly string[],
    moveOutDate?: string | null,
    dryRun = false,
  ): EndpointSpec<models.WriteResult> {
    const body: RawBody = { key_ids: [...keyIds] };
    if (moveOutDate != null) body.move_out_date = moveOutDate;
    if (dryRun) body.dry_run = true;
    return {
      method: "POST",
      path: `/v1/community/members/${enc(accountCommunityId)}/approve`,
      body,
      parse: models.parseWriteResult,
    };
  },

  bulkAddMembers(
    items: readonly models.BulkAddItem[],
  ): EndpointSpec<models.BulkResult> {
    return {
      method: "POST",
      path: "/v1/community/members/bulk-add",
      body: {
        items: items.map((i) => ({
          phone_number: i.phoneNumber,
          key_ids: [...i.keyIds],
        })),
      },
      parse: models.parseBulkResult,
    };
  },

  bulkGrantKeys(
    items: readonly models.BulkKeyItem[],
  ): EndpointSpec<models.BulkResult> {
    return {
      method: "POST",
      path: "/v1/community/members/keys/bulk-grant",
      body: { items: bulkKeyItems(items) },
      parse: models.parseBulkResult,
    };
  },

  bulkRevokeKeys(
    items: readonly models.BulkKeyItem[],
  ): EndpointSpec<models.BulkResult> {
    return {
      method: "POST",
      path: "/v1/community/members/keys/bulk-revoke",
      body: { items: bulkKeyItems(items) },
      parse: models.parseBulkResult,
    };
  },

  bulkSetKeysDisabled(
    items: readonly models.BulkKeyItem[],
    disabled: boolean,
  ): EndpointSpec<models.BulkResult> {
    return {
      method: "POST",
      path: "/v1/community/members/keys/bulk-disabled",
      body: { items: bulkKeyItems(items), disabled },
      parse: models.parseBulkResult,
    };
  },

  memberAccessLogs(
    accountCommunityId: number,
    window = "last_30",
  ): EndpointSpec<models.MemberAccessLogPage> {
    return {
      method: "GET",
      path: `/v1/community/members/${enc(accountCommunityId)}/access-logs`,
      params: { window },
      parse: models.parseMemberAccessLogPage,
    };
  },

  accessLog(page = 0): EndpointSpec<models.AccessLogPage> {
    return {
      method: "GET",
      path: "/v1/community/access-logs",
      params: { page },
      parse: models.parseAccessLogPage,
    };
  },

  gateStatusLog(page = 0): EndpointSpec<models.GateStatusLogPage> {
    return {
      method: "GET",
      path: "/v1/community/gate-status-log",
      params: { page },
      parse: models.parseGateStatusLogPage,
    };
  },

  // -- hold opens ----------------------------------------------------- //

  holdOpens(): EndpointSpec<models.HoldOpens> {
    return {
      method: "GET",
      path: "/v1/community/hold-opens",
      parse: models.parseHoldOpens,
    };
  },

  setHoldOpen(
    latchId: string,
    state: boolean,
  ): EndpointSpec<models.ManualHoldOpenResult> {
    return {
      method: "PUT",
      path: `/v1/community/latches/${enc(latchId)}/hold-open`,
      body: { state },
      parse: models.parseManualHoldOpenResult,
    };
  },

  addHoldOpenEvent(
    latchId: string,
    start: string,
    end: string,
  ): EndpointSpec<models.HoldOpenEventAdded> {
    return {
      method: "POST",
      path: `/v1/community/latches/${enc(latchId)}/hold-open/events`,
      body: { start, end },
      parse: models.parseHoldOpenEventAdded,
    };
  },

  removeHoldOpenEvent(
    latchId: string,
    eventId: string,
  ): EndpointSpec<models.HoldOpenEventRemoved> {
    return {
      method: "DELETE",
      path: `/v1/community/latches/${enc(latchId)}/hold-open/events/${enc(eventId)}`,
      parse: models.parseHoldOpenEventRemoved,
    };
  },

  setHoldOpenDisabledUntil(
    latchId: string,
    until: string | null,
  ): EndpointSpec<models.HoldOpenDisabledUntil> {
    // `until` is required by the API — an explicit null resumes, so it is
    // always sent, never omitted the way optional fields are elsewhere.
    return {
      method: "PUT",
      path: `/v1/community/latches/${enc(latchId)}/hold-open/disabled-until`,
      body: { until },
      parse: models.parseHoldOpenDisabledUntil,
    };
  },

  addHoldOpenRecurring(
    latchId: string,
    daysOfTheWeek: string | number,
    opts: {
      startTime?: string | null;
      endTime?: string | null;
      recurringWeek?: number;
    } = {},
  ): EndpointSpec<models.RecurringHoldOpenResult> {
    const body: RawBody = { days_of_the_week: daysOfTheWeek };
    if (opts.recurringWeek !== undefined) body.recurring_week = opts.recurringWeek;
    if (opts.startTime !== undefined) body.start_time = opts.startTime;
    if (opts.endTime !== undefined) body.end_time = opts.endTime;
    return {
      method: "POST",
      path: `/v1/community/latches/${enc(latchId)}/hold-open/recurring`,
      body,
      parse: models.parseRecurringHoldOpenResult,
    };
  },

  updateHoldOpenRecurring(
    latchId: string,
    temporalDateId: string,
    fields: {
      daysOfTheWeek?: string | number;
      startTime?: string | null;
      endTime?: string | null;
      recurringWeek?: number;
      clearTimes?: boolean;
    },
  ): EndpointSpec<models.RecurringHoldOpenResult> {
    // Partial update: only the fields actually passed are sent, so anything
    // left out keeps its current value server-side.
    const body: RawBody = {};
    if (fields.daysOfTheWeek !== undefined)
      body.days_of_the_week = fields.daysOfTheWeek;
    if (fields.recurringWeek !== undefined)
      body.recurring_week = fields.recurringWeek;
    if (fields.startTime !== undefined) body.start_time = fields.startTime;
    if (fields.endTime !== undefined) body.end_time = fields.endTime;
    if (fields.clearTimes !== undefined) body.clear_times = fields.clearTimes;
    return {
      method: "PATCH",
      path:
        `/v1/community/latches/${enc(latchId)}/hold-open/recurring/` +
        `${enc(temporalDateId)}`,
      body,
      parse: models.parseRecurringHoldOpenResult,
    };
  },

  removeHoldOpenRecurring(
    latchId: string,
    temporalDateId: string,
  ): EndpointSpec<models.RecurringHoldOpenRemoved> {
    return {
      method: "DELETE",
      path:
        `/v1/community/latches/${enc(latchId)}/hold-open/recurring/` +
        `${enc(temporalDateId)}`,
      parse: models.parseRecurringHoldOpenRemoved,
    };
  },

  // -- key access schedules -------------------------------------------- //

  keySchedules(): EndpointSpec<models.KeySchedules> {
    return {
      method: "GET",
      path: "/v1/community/key-schedules",
      parse: models.parseKeySchedules,
    };
  },

  keySchedule(keyId: string): EndpointSpec<models.KeySchedule> {
    return {
      method: "GET",
      path: `/v1/community/keys/${enc(keyId)}/schedule`,
      parse: models.parseKeySchedule,
    };
  },

  setKeySchedule(
    keyId: string,
    windows: models.ScheduleWindowInput[] | null | undefined,
  ): EndpointSpec<models.KeySchedule> {
    // Whole-schedule replace: [] removes every restriction. Times default to
    // null (all day) so a caller can pass days alone.
    const payload = (windows ?? []).map((w) => ({
      days_of_the_week: w.daysOfTheWeek,
      start_time: w.startTime ?? null,
      end_time: w.endTime ?? null,
    }));
    return {
      method: "PUT",
      path: `/v1/community/keys/${enc(keyId)}/schedule`,
      body: { windows: payload },
      parse: models.parseKeySchedule,
    };
  },

  // -- webhooks -------------------------------------------------------- //

  webhookEventTypes(): EndpointSpec<string[]> {
    return {
      method: "GET",
      path: "/v1/community/webhook-events",
      parse: models.parseWebhookEventTypes,
    };
  },

  webhooks(): EndpointSpec<models.Webhook[]> {
    return {
      method: "GET",
      path: "/v1/community/webhooks",
      parse: models.parseWebhooks,
    };
  },

  createWebhook(
    url: string,
    events: readonly string[],
    description?: string | null,
  ): EndpointSpec<models.WebhookWriteResult> {
    const body: RawBody = { url, events: [...events] };
    if (description != null) body.description = description;
    return {
      method: "POST",
      path: "/v1/community/webhooks",
      body,
      parse: models.parseWebhookWriteResult,
    };
  },

  updateWebhook(
    webhookId: string,
    fields: {
      url?: string;
      events?: readonly string[];
      active?: boolean;
      description?: string;
    },
  ): EndpointSpec<models.WebhookWriteResult> {
    const body: RawBody = {};
    if (fields.url !== undefined) body.url = fields.url;
    if (fields.events !== undefined) body.events = [...fields.events];
    if (fields.active !== undefined) body.active = fields.active;
    if (fields.description !== undefined) body.description = fields.description;
    return {
      method: "PATCH",
      path: `/v1/community/webhooks/${enc(webhookId)}`,
      body,
      parse: models.parseWebhookWriteResult,
    };
  },

  deleteWebhook(webhookId: string): EndpointSpec<models.WriteResult> {
    return {
      method: "DELETE",
      path: `/v1/community/webhooks/${enc(webhookId)}`,
      parse: models.parseWriteResult,
    };
  },

  rotateWebhookSecret(webhookId: string): EndpointSpec<models.WebhookSecret> {
    return {
      method: "POST",
      path: `/v1/community/webhooks/${enc(webhookId)}/rotate-secret`,
      parse: models.parseWebhookSecret,
    };
  },

  testWebhook(webhookId: string): EndpointSpec<models.WriteResult> {
    return {
      method: "POST",
      path: `/v1/community/webhooks/${enc(webhookId)}/test`,
      parse: models.parseWriteResult,
    };
  },

  webhookDeliveries(
    webhookId: string,
    limit = 50,
  ): EndpointSpec<models.WebhookDelivery[]> {
    return {
      method: "GET",
      path: `/v1/community/webhooks/${enc(webhookId)}/deliveries`,
      params: { limit },
      parse: models.parseWebhookDeliveries,
    };
  },

  retryFailedDeliveries(
    webhookId: string,
    opts: { since?: string | null; limit?: number } = {},
  ): EndpointSpec<models.RetryFailedResult> {
    return {
      method: "POST",
      path: `/v1/community/webhooks/${enc(webhookId)}/deliveries/retry-failed`,
      params: { since: opts.since, limit: opts.limit ?? 50 },
      parse: models.parseRetryFailedResult,
    };
  },

  replayDelivery(
    webhookId: string,
    deliveryId: string,
  ): EndpointSpec<models.DeliveryReplayResult> {
    return {
      method: "POST",
      path:
        `/v1/community/webhooks/${enc(webhookId)}/deliveries/` +
        `${enc(deliveryId)}/replay`,
      parse: models.parseDeliveryReplayResult,
    };
  },

  // -- community settings ---------------------------------------------- //

  settings(): EndpointSpec<models.CommunitySettings> {
    return {
      method: "GET",
      path: "/v1/community/settings",
      parse: models.parseCommunitySettings,
    };
  },

  updateSettings(
    settings: models.CommunitySettingsInput,
  ): EndpointSpec<models.CommunitySettings> {
    return {
      method: "PATCH",
      path: "/v1/community/settings",
      body: { settings: settingsToWire(settings) },
      parse: models.parseCommunitySettings,
    };
  },

  // -- homes / units roster --------------------------------------------- //

  homes(includeHidden = true): EndpointSpec<models.Home[]> {
    // Always sent, unlike the account-keys read: the server defaults this one
    // to true, so omitting it on `false` would silently include hidden homes.
    return {
      method: "GET",
      path: "/v1/community/homes",
      params: { include_hidden: includeHidden ? "true" : "false" },
      parse: models.parseHomes,
    };
  },

  addHome(homeAddress: string): EndpointSpec<models.HomeWriteResult> {
    return {
      method: "POST",
      path: "/v1/community/homes",
      body: { home_address: homeAddress },
      parse: models.parseHomeWriteResult,
    };
  },

  home(homeId: string): EndpointSpec<models.Home> {
    return {
      method: "GET",
      path: `/v1/community/homes/${enc(homeId)}`,
      parse: models.parseHomeDetail,
    };
  },

  updateHome(
    homeId: string,
    fields: { homeAddress?: string; ownerOccupied?: boolean; hidden?: boolean },
  ): EndpointSpec<models.HomeWriteResult> {
    // Partial update: a field left out keeps its stored value.
    const body: RawBody = {};
    if (fields.homeAddress !== undefined) body.home_address = fields.homeAddress;
    if (fields.ownerOccupied !== undefined)
      body.owner_occupied = fields.ownerOccupied;
    if (fields.hidden !== undefined) body.hidden = fields.hidden;
    return {
      method: "PATCH",
      path: `/v1/community/homes/${enc(homeId)}`,
      body,
      parse: models.parseHomeWriteResult,
    };
  },

  removeHome(homeId: string): EndpointSpec<models.HomeRemoved> {
    return {
      method: "DELETE",
      path: `/v1/community/homes/${enc(homeId)}`,
      parse: models.parseHomeRemoved,
    };
  },

  setMoveOutDate(
    accountCommunityId: number | string,
    moveOutDate: string | null,
  ): EndpointSpec<models.MoveOutDateResult> {
    // Required by the API — an explicit null clears the date, so it is always
    // sent rather than omitted the way optional fields are elsewhere.
    return {
      method: "PUT",
      path: `/v1/community/members/${enc(accountCommunityId)}/move-out-date`,
      body: { move_out_date: moveOutDate },
      parse: models.parseMoveOutDateResult,
    };
  },

  // -- my member-open notification settings ----------------------------- //

  myNotificationSettings(): EndpointSpec<models.NotificationSettings> {
    return {
      method: "GET",
      path: "/v1/community/my-notification-settings",
      parse: models.parseNotificationSettings,
    };
  },

  setMyNotificationsEnabled(
    enabled: boolean,
  ): EndpointSpec<models.NotificationSettings> {
    return {
      method: "PUT",
      path: "/v1/community/my-notification-settings",
      body: { enabled },
      parse: models.parseNotificationSettings,
    };
  },

  addQuietHours(
    daysOfTheWeek: string,
    opts: { startTime?: string | null; endTime?: string | null } = {},
  ): EndpointSpec<models.NotificationSettings> {
    // Both times are sent whenever either is given; a lone start with no end
    // is a half-open window the server has no reading for.
    const body: RawBody = { days_of_the_week: daysOfTheWeek };
    if (opts.startTime !== undefined || opts.endTime !== undefined) {
      body.start_time = opts.startTime ?? null;
      body.end_time = opts.endTime ?? null;
    }
    return {
      method: "POST",
      path: "/v1/community/my-notification-settings/quiet-hours",
      body,
      parse: models.parseNotificationSettings,
    };
  },

  removeQuietHours(
    quietHoursId: number | string,
  ): EndpointSpec<models.NotificationSettings> {
    return {
      method: "DELETE",
      path:
        `/v1/community/my-notification-settings/quiet-hours/` +
        `${enc(quietHoursId)}`,
      parse: models.parseNotificationSettings,
    };
  },

  // -- guest links ------------------------------------------------------ //

  guestLinks(includeInactive = true): EndpointSpec<models.GuestLink[]> {
    // Always sent: the server defaults this to true, so omitting it on `false`
    // would silently keep listing revoked, expired and spent links.
    return {
      method: "GET",
      path: "/v1/community/guest-links",
      params: { include_inactive: includeInactive ? "true" : "false" },
      parse: models.parseGuestLinks,
    };
  },

  createGuestLink(
    linkType: string,
    latchIds: readonly string[],
    opts: {
      keyId?: string;
      title?: string;
      subtitle?: string;
      extraInfo?: string;
      maxUses?: number;
      expiresAt?: string;
      windowStart?: string;
      windowEnd?: string;
      notifyOnUse?: boolean;
    } = {},
  ): EndpointSpec<models.GuestLinkResult> {
    const body: RawBody = { link_type: linkType, latch_ids: [...latchIds] };
    if (opts.keyId !== undefined) body.key_id = opts.keyId;
    if (opts.title !== undefined) body.title = opts.title;
    if (opts.subtitle !== undefined) body.subtitle = opts.subtitle;
    if (opts.extraInfo !== undefined) body.extra_info = opts.extraInfo;
    if (opts.maxUses !== undefined) body.max_uses = opts.maxUses;
    if (opts.expiresAt !== undefined) body.expires_at = opts.expiresAt;
    if (opts.windowStart !== undefined) body.window_start = opts.windowStart;
    if (opts.windowEnd !== undefined) body.window_end = opts.windowEnd;
    if (opts.notifyOnUse !== undefined) body.notify_on_use = opts.notifyOnUse;
    return {
      method: "POST",
      path: "/v1/community/guest-links",
      body,
      parse: models.parseGuestLinkResult,
    };
  },

  revokeGuestLink(
    guestLinkId: number | string,
  ): EndpointSpec<models.GuestLinkResult> {
    return {
      method: "DELETE",
      path: `/v1/community/guest-links/${enc(guestLinkId)}`,
      parse: models.parseGuestLinkResult,
    };
  },

  guestLinkLogs(
    opts: {
      guestLinkId?: number | string | null;
      limit?: number;
      offset?: number;
    } = {},
  ): EndpointSpec<models.GuestLinkLogPage> {
    return {
      method: "GET",
      path: "/v1/community/guest-links/logs",
      params: {
        guest_link_id: opts.guestLinkId,
        limit: opts.limit ?? 50,
        offset: opts.offset ?? 0,
      },
      parse: models.parseGuestLinkLogPage,
    };
  },

  guestLinkLatchExclusions(): EndpointSpec<models.GuestLinkLatchExclusions> {
    return {
      method: "GET",
      path: "/v1/community/guest-links/latch-exclusions",
      parse: models.parseGuestLinkLatchExclusions,
    };
  },

  // -- access codes ------------------------------------------------------ //

  accessCodes(): EndpointSpec<models.AccessCodes> {
    return {
      method: "GET",
      path: "/v1/community/access-codes",
      parse: models.parseAccessCodes,
    };
  },

  createAccessCode(
    code: string,
    latchIds: readonly string[],
    opts: {
      expiresInHours?: number;
      expiresInDays?: number;
      temporal?: models.AccessCodeTemporalInput;
    } = {},
  ): EndpointSpec<models.AccessCodeCreateResult> {
    const body: RawBody = { code, latch_ids: [...latchIds] };
    if (opts.expiresInHours !== undefined)
      body.expires_in_hours = opts.expiresInHours;
    if (opts.expiresInDays !== undefined)
      body.expires_in_days = opts.expiresInDays;
    if (opts.temporal !== undefined) body.temporal = temporalToWire(opts.temporal);
    return {
      method: "POST",
      path: "/v1/community/access-codes",
      body,
      parse: models.parseAccessCodeCreateResult,
    };
  },

  updateAccessCode(
    directoryAccessCodeId: number | string,
    fields: {
      disabled?: boolean;
      latchIds?: readonly string[];
      expiresInHours?: number;
      expiresInDays?: number;
      temporal?: models.AccessCodeTemporalInput;
    },
  ): EndpointSpec<models.AccessCodeWriteResult> {
    // Partial update: a field left out keeps its stored value. An empty body is
    // a 400 rather than a no-op, so nothing is invented here to pad it.
    const body: RawBody = {};
    if (fields.disabled !== undefined) body.disabled = fields.disabled;
    if (fields.latchIds !== undefined) body.latch_ids = [...fields.latchIds];
    if (fields.expiresInHours !== undefined)
      body.expires_in_hours = fields.expiresInHours;
    if (fields.expiresInDays !== undefined)
      body.expires_in_days = fields.expiresInDays;
    if (fields.temporal !== undefined)
      body.temporal = temporalToWire(fields.temporal);
    return {
      method: "PATCH",
      path: `/v1/community/access-codes/${enc(directoryAccessCodeId)}`,
      body,
      parse: models.parseAccessCodeWriteResult,
    };
  },

  deleteAccessCode(
    directoryAccessCodeId: number | string,
  ): EndpointSpec<models.AccessCodeWriteResult> {
    return {
      method: "DELETE",
      path: `/v1/community/access-codes/${enc(directoryAccessCodeId)}`,
      parse: models.parseAccessCodeWriteResult,
    };
  },

  accessCodeEligibleLatches(): EndpointSpec<models.AccessCodeEligibleLatches> {
    return {
      method: "GET",
      path: "/v1/community/access-codes/eligible-latches",
      parse: models.parseAccessCodeEligibleLatches,
    };
  },

  accessCodeLogs(
    limit = 50,
    offset = 0,
  ): EndpointSpec<models.AccessCodeLogPage> {
    return {
      method: "GET",
      path: "/v1/community/access-codes/logs",
      params: { limit, offset },
      parse: models.parseAccessCodeLogPage,
    };
  },

  // -- GuestView Entry --------------------------------------------------- //

  guestViewEntry(): EndpointSpec<models.GuestViewEntry> {
    return {
      method: "GET",
      path: "/v1/community/guest-view-entry",
      parse: models.parseGuestViewEntry,
    };
  },

  setGuestViewEntryEnabled(
    allowed: boolean,
  ): EndpointSpec<models.GuestViewEntry> {
    // An explicit setter, not a toggle: this call is retryable, and a retried
    // toggle would flip guest access back open.
    return {
      method: "PUT",
      path: "/v1/community/guest-view-entry",
      body: { allowed },
      parse: models.parseGuestViewEntry,
    };
  },

  setGuestViewEntryLatches(
    latchIds: readonly string[],
  ): EndpointSpec<models.GuestViewEntry> {
    // Whole-set replace: every omitted latch loses guest eligibility AND its
    // schedule windows. `[]` removes GuestView Entry from every gate.
    return {
      method: "PUT",
      path: "/v1/community/guest-view-entry/eligible-latches",
      body: { latch_ids: [...latchIds] },
      parse: models.parseGuestViewEntry,
    };
  },

  guestViewEntryLogs(
    opts: { limit?: number; offset?: number; success?: boolean | null } = {},
  ): EndpointSpec<models.GuestViewEntryLogPage> {
    return {
      method: "GET",
      path: "/v1/community/guest-view-entry/logs",
      params: {
        limit: opts.limit ?? 50,
        offset: opts.offset ?? 0,
        // Omitted entirely when undefined — the server reads absence as
        // "everything", which is not the same as either boolean.
        success: opts.success === undefined ? undefined : String(opts.success),
      },
      parse: models.parseGuestViewEntryLogPage,
    };
  },

  addGuestViewEntrySchedule(
    daysOfTheWeek: string,
    latchIds: readonly string[],
    opts: { startTime?: string | null; endTime?: string | null } = {},
  ): EndpointSpec<models.GuestViewEntry> {
    const body: RawBody = {
      days_of_the_week: daysOfTheWeek,
      latch_ids: [...latchIds],
    };
    // Sent when given, null included: a null end is an unbounded window, which
    // is a different thing from omitting the field.
    if (opts.startTime !== undefined) body.start_time = opts.startTime;
    if (opts.endTime !== undefined) body.end_time = opts.endTime;
    return {
      method: "POST",
      path: "/v1/community/guest-view-entry/schedule",
      body,
      parse: models.parseGuestViewEntry,
    };
  },

  removeGuestViewEntrySchedule(
    scheduleId: number | string,
  ): EndpointSpec<models.GuestViewEntry> {
    return {
      method: "DELETE",
      path: `/v1/community/guest-view-entry/schedule/${enc(scheduleId)}`,
      parse: models.parseGuestViewEntry,
    };
  },

  // -- GuestView short codes --------------------------------------------- //

  shortCodes(): EndpointSpec<models.ShortCode[]> {
    return {
      method: "GET",
      path: "/v1/community/short-codes",
      parse: models.parseShortCodes,
    };
  },

  createShortCode(
    opts: { code?: string; latchId?: string } = {},
  ): EndpointSpec<models.ShortCodeResult> {
    const body: RawBody = {};
    if (opts.code !== undefined) body.code = opts.code;
    if (opts.latchId !== undefined) body.latch_id = opts.latchId;
    return {
      method: "POST",
      path: "/v1/community/short-codes",
      body,
      parse: models.parseShortCodeResult,
    };
  },

  assignShortCode(
    code: string,
    latchId: string,
  ): EndpointSpec<models.ShortCodeResult> {
    // Exclusive assignment: this detaches the code from whatever gate it
    // pointed at before, with no warning of its own.
    return {
      method: "PUT",
      path: `/v1/community/short-codes/${enc(code)}`,
      body: { latch_id: latchId },
      parse: models.parseShortCodeResult,
    };
  },

  // -- NFC tags ------------------------------------------------------------ //

  nfcTags(
    opts: { search?: string | null; page?: number; resultsPerPage?: number } = {},
  ): EndpointSpec<models.NfcTagPage> {
    return {
      method: "GET",
      path: "/v1/community/nfc-tags",
      params: {
        // Omitted when undefined: absence means "no search", which is not the
        // same as searching for the empty string.
        search: opts.search ?? undefined,
        page: opts.page ?? 1,
        results_per_page: opts.resultsPerPage ?? 50,
      },
      parse: models.parseNfcTagPage,
    };
  },

  nfcTag(tagId: string | number): EndpointSpec<models.NfcTag> {
    return {
      method: "GET",
      path: `/v1/community/nfc-tags/${enc(tagId)}`,
      parse: models.parseNfcTagDetail,
    };
  },

  updateNfcTag(
    tagId: string | number,
    fields: {
      disabled?: boolean;
      latchId?: string | null;
      confirm?: boolean;
    },
  ): EndpointSpec<models.NfcTagWriteResult> {
    // `latchId` is sent whenever it is present, null included: a null detaches
    // the tag, which is a different instruction from omitting the field.
    // `disabled` is an explicit setter, never a toggle, so a retry is safe.
    const body: RawBody = {};
    if (fields.disabled !== undefined) body.disabled = fields.disabled;
    if (fields.latchId !== undefined) body.latch_id = fields.latchId;
    if (fields.confirm !== undefined) body.confirm = fields.confirm;
    return {
      method: "PATCH",
      path: `/v1/community/nfc-tags/${enc(tagId)}`,
      body,
      parse: models.parseNfcTagWriteResult,
    };
  },

  nfcScanLog(
    opts: {
      limit?: number;
      offset?: number;
      result?: string | null;
      tagUidHex?: string | null;
    } = {},
  ): EndpointSpec<models.NfcScanLogPage> {
    return {
      method: "GET",
      path: "/v1/community/nfc-tags/scan-log",
      params: {
        limit: opts.limit ?? 50,
        offset: opts.offset ?? 0,
        result: opts.result ?? undefined,
        tag_uid_hex: opts.tagUidHex ?? undefined,
      },
      parse: models.parseNfcScanLogPage,
    };
  },

  // -- sense lines --------------------------------------------------------- //

  senseLines(
    opts: { boxId?: string | null } = {},
  ): EndpointSpec<models.SenseLines> {
    // Here `box_id` really is an optional filter — omit it for every box in the
    // community. On the single-sense-line routes below it is required instead.
    return {
      method: "GET",
      path: "/v1/community/sense-lines",
      params: { box_id: opts.boxId ?? undefined },
      parse: models.parseSenseLines,
    };
  },

  senseLine(
    senseLineId: number | string,
    boxId: string,
  ): EndpointSpec<models.SenseLineDetail> {
    // `boxId` is required despite the OpenAPI schema marking it optional: a
    // sense line id is an input number unique only within its box, so the
    // server answers 422 `box_id_required` rather than guessing. Required here
    // turns that runtime 422 into a compile error.
    return {
      method: "GET",
      path: `/v1/community/sense-lines/${enc(senseLineId)}`,
      params: { box_id: boxId },
      parse: models.parseSenseLineDetail,
    };
  },

  updateSenseLine(
    senseLineId: number | string,
    boxId: string,
    fields: { senseLineOnline?: boolean; latchDataOnline?: boolean },
  ): EndpointSpec<models.SenseLineDetail> {
    // Partial: an omitted flag keeps its stored value, and each value is an
    // explicit set rather than a toggle, so re-sending is a no-op. Sending
    // neither is 422 `no_fields` — nothing is invented here to pad the body.
    const body: RawBody = {};
    if (fields.senseLineOnline !== undefined)
      body.sense_line_online = fields.senseLineOnline;
    if (fields.latchDataOnline !== undefined)
      body.latch_data_online = fields.latchDataOnline;
    return {
      method: "PATCH",
      path: `/v1/community/sense-lines/${enc(senseLineId)}`,
      params: { box_id: boxId },
      body,
      parse: models.parseSenseLineDetail,
    };
  },

  senseLineRecords(
    opts: {
      boxId?: string | null;
      senseLineId?: number | null;
      limit?: number;
      offset?: number;
    } = {},
  ): EndpointSpec<models.SenseLineRecordPage> {
    return {
      method: "GET",
      path: "/v1/community/sense-lines/records",
      params: {
        box_id: opts.boxId ?? undefined,
        sense_line_id: opts.senseLineId ?? undefined,
        limit: opts.limit ?? 50,
        offset: opts.offset ?? 0,
      },
      parse: models.parseSenseLineRecordPage,
    };
  },

  // -- map + geofences ----------------------------------------------------- //

  map(): EndpointSpec<models.CommunityMap> {
    return {
      method: "GET",
      path: "/v1/community/map",
      parse: models.parseCommunityMap,
    };
  },

  updateGeofence(
    latchId: string,
    fields: {
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
      enabled?: boolean;
      mode?: GeofenceMode;
    },
  ): EndpointSpec<models.GeofenceWriteResult> {
    // Partial update: an omitted field keeps its stored value, and there is
    // deliberately no way to clear a configured centre. Nothing is validated
    // here — a radius under the 100 m minimum has to come back as the server's
    // 422 `radius_below_minimum`, not as a client-side guess or a clamp.
    const body: RawBody = {};
    if (fields.latitude !== undefined) body.latitude = fields.latitude;
    if (fields.longitude !== undefined) body.longitude = fields.longitude;
    if (fields.radiusMeters !== undefined)
      body.radius_meters = fields.radiusMeters;
    if (fields.enabled !== undefined) body.enabled = fields.enabled;
    if (fields.mode !== undefined) body.mode = fields.mode;
    return {
      method: "PATCH",
      path: `/v1/community/latches/${enc(latchId)}/geofence`,
      body,
      parse: models.parseGeofenceWriteResult,
    };
  },

  // -- audit + reporting --------------------------------------------------- //

  changeLogs(
    type: ChangeLogType,
    opts: { days?: number; limit?: number; offset?: number } = {},
  ): EndpointSpec<models.ChangeLogPage> {
    return {
      method: "GET",
      path: "/v1/community/change-logs",
      params: {
        type,
        days: opts.days ?? 30,
        limit: opts.limit ?? 500,
        offset: opts.offset ?? 0,
      },
      parse: models.parseChangeLogPage,
    };
  },

  keyUsage(
    from: string,
    to: string,
    opts: { page?: number } = {},
  ): EndpointSpec<models.KeyUsageReport> {
    return {
      method: "GET",
      path: "/v1/community/key-usage",
      params: { from, to, page: opts.page ?? 0 },
      parse: models.parseKeyUsageReport,
    };
  },
};
