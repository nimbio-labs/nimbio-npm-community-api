/**
 * Shared, transport-agnostic core for the client.
 *
 * This module owns everything that does *not* depend on the actual HTTP round
 * trip: configuration resolution, header construction, URL building, response
 * decoding, error mapping, and the retry policy. {@link NimbioClient} adds the
 * small `fetch` loop on top.
 */

import * as errors from "./errors.js";
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
}

export interface PreparedRequest {
  method: string;
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
      url: `${this.baseUrl}${path}`,
      headers,
      params,
      body: opts.body ?? null,
    };
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

export const endpoints = {
  health(): EndpointSpec<models.Health> {
    return { method: "GET", path: "/healthz", parse: models.parseHealth };
  },

  me(): EndpointSpec<models.Me> {
    return { method: "GET", path: "/v1/me", parse: models.parseMe };
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
};
