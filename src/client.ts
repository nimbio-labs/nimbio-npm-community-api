/**
 * The Nimbio community API client.
 *
 * A single Promise-based client that works everywhere `fetch` exists: Node 18+,
 * modern browsers, Deno, Bun, and edge runtimes. Every method returns a
 * Promise — use `await`.
 */

import {
  BaseClient,
  endpoints,
  type ClientOptions,
  type EndpointSpec,
  type FetchLike,
  type PreparedRequest,
} from "./base.js";
import * as errors from "./errors.js";
import type {
  AccessLogEntry,
  AccessLogPage,
  CommunityKey,
  GateStatus,
  GateStatusLogEntry,
  GateStatusLogPage,
  Health,
  KeyStatuses,
  Me,
  MemberAccessLogPage,
  Members,
  OpenResult,
  WriteResult,
} from "./models.js";

/** 30-day member-access-log window. */
export type MemberAccessLogWindow = "last_30" | "30_60" | "60_90";

function resolveFetch(custom?: FetchLike): FetchLike {
  if (custom) return custom;
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis) as FetchLike;
  }
  throw new errors.NimbioConfigError(
    "No global fetch() is available in this runtime. Upgrade to Node 18+, or " +
      "pass a fetch implementation via the `fetch` option.",
  );
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Blocking-free client for the Nimbio community API.
 *
 * @example
 * ```ts
 * import { NimbioClient } from "@nimbio/community-api";
 *
 * const client = new NimbioClient("nimbio_test_...");
 * console.log((await client.me()).accountId);
 * await client.community.open("latch-id-123", { note: "front gate" });
 * ```
 *
 * Configuration precedence: explicit arguments > environment variables
 * (`NIMBIO_API_KEY`, `NIMBIO_ENV`, `NIMBIO_BASE_URL`) > defaults
 * (`environment: "prod"`).
 */
export class NimbioClient extends BaseClient {
  /** Community-scoped operations (`client.community.*`). */
  readonly community: Community;
  private readonly fetchImpl: FetchLike;

  constructor(apiKey?: string, options: ClientOptions = {}) {
    super(apiKey, options);
    this.fetchImpl = resolveFetch(options.fetch);
    this.community = new Community(this);
  }

  // -- core request loop --------------------------------------------------- //

  /** @internal */
  async request<T>(spec: EndpointSpec<T>, opts: { auth?: boolean } = {}): Promise<T> {
    const prepared = this.prepare(spec.method, spec.path, {
      params: spec.params,
      body: spec.body,
      auth: opts.auth ?? true,
    });

    let attempt = 0;
    for (;;) {
      const resp = await this.send(prepared);

      if (this.shouldRetry(resp.status, attempt)) {
        const headers = headersToObject(resp.headers);
        await sleep(this.retryDelay(attempt, headers));
        attempt += 1;
        continue;
      }

      const bodyText = await resp.text();
      const headers = headersToObject(resp.headers);
      const payload = this.decode(bodyText);
      const data = this.parseResponse(resp.status, payload, headers);
      return spec.parse(data);
    }
  }

  /** Issue one HTTP round trip, translating transport failures into errors. */
  private async send(prepared: PreparedRequest): Promise<Response> {
    const url = prepared.params
      ? `${prepared.url}?${new URLSearchParams(prepared.params).toString()}`
      : prepared.url;

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.timeout != null && this.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeout * 1000);
    }

    try {
      return await this.fetchImpl(url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body != null ? JSON.stringify(prepared.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      if (timedOut) {
        throw new errors.APITimeoutError(undefined, { cause: e });
      }
      const message = e instanceof Error && e.message ? e.message : "Connection error";
      throw new errors.APIConnectionError(message, { cause: e });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -- lifecycle ----------------------------------------------------------- //

  /**
   * No-op for API symmetry / `using` blocks. The client holds no persistent
   * connection of its own; `fetch` manages the underlying pool.
   */
  close(): void {
    /* nothing to release */
  }

  // -- top-level endpoints ------------------------------------------------- //

  /** Backend reachability (unauthenticated). Does not throw on 503. */
  async health(): Promise<Health> {
    const spec = endpoints.health();
    const prepared = this.prepare(spec.method, spec.path, { auth: false });
    const resp = await this.send(prepared);
    const bodyText = await resp.text();
    return spec.parse(this.decode(bodyText) ?? {});
  }

  /** Metadata and live usage counters for the authenticating key. */
  me(): Promise<Me> {
    return this.request(endpoints.me());
  }
}

/**
 * `client.community.*` — community-scoped operations.
 *
 * Requires a community-scoped API key; account-scoped keys throw
 * {@link PermissionDeniedError} (`not_community_key`).
 */
export class Community {
  constructor(private readonly client: NimbioClient) {}

  // -- reads --------------------------------------------------------------- //

  /** Latest sensed open/closed state for every latch in the community. */
  gateStatus(): Promise<GateStatus> {
    return this.client.request(endpoints.gateStatus());
  }

  /** Pending / accepted / removed members. */
  members(): Promise<Members> {
    return this.client.request(endpoints.members());
  }

  /** All keys and latches with live disabled/offline/held-open state. */
  keyStatuses(): Promise<KeyStatuses> {
    return this.client.request(endpoints.keyStatuses());
  }

  /** Every community key with its access restrictions. */
  keys(): Promise<CommunityKey[]> {
    return this.client.request(endpoints.keys());
  }

  // -- writes -------------------------------------------------------------- //

  /**
   * Open a latch. Live keys fire the gate (synchronous — the Promise resolves
   * once the box confirms); test keys simulate. Denials throw
   * {@link PermissionDeniedError}; a non-confirming gate throws
   * {@link GateNotOpenedError}.
   */
  open(
    latchId: string,
    opts: { note?: string; idempotencyKey?: string } = {},
  ): Promise<OpenResult> {
    return this.client.request(endpoints.open(latchId, opts.note, opts.idempotencyKey));
  }

  /** Send a message to every community member (test keys validate only). */
  message(message: string): Promise<WriteResult> {
    return this.client.request(endpoints.message(message));
  }

  /** Add a member by phone number and grant them the given community keys. */
  addMember(phoneNumber: string, keyIds: readonly string[]): Promise<WriteResult> {
    return this.client.request(endpoints.addMember(phoneNumber, keyIds));
  }

  /** Grant additional community keys to an existing member. */
  grantKeys(accountCommunityId: number, keyIds: readonly string[]): Promise<WriteResult> {
    return this.client.request(endpoints.grantKeys(accountCommunityId, keyIds));
  }

  /** Revoke community keys from a member (optionally remove them entirely). */
  revokeKeys(
    accountCommunityId: number,
    keyIds: readonly string[],
    opts: { removeMember?: boolean } = {},
  ): Promise<WriteResult> {
    return this.client.request(
      endpoints.revokeKeys(accountCommunityId, keyIds, opts.removeMember ?? false),
    );
  }

  /** Disable or re-enable a member's keys (reversible — keys not removed). */
  setKeysDisabled(
    accountCommunityId: number,
    keyIds: readonly string[],
    disabled: boolean,
  ): Promise<WriteResult> {
    return this.client.request(
      endpoints.setKeysDisabled(accountCommunityId, keyIds, disabled),
    );
  }

  // -- logs ---------------------------------------------------------------- //

  /** A member's opens for a 30-day window (`last_30` / `30_60` / `60_90`). */
  memberAccessLogs(
    accountCommunityId: number,
    opts: { window?: MemberAccessLogWindow } = {},
  ): Promise<MemberAccessLogPage> {
    return this.client.request(
      endpoints.memberAccessLogs(accountCommunityId, opts.window ?? "last_30"),
    );
  }

  /** One page (1000 rows) of the community access log (last 90 days). */
  accessLog(opts: { page?: number } = {}): Promise<AccessLogPage> {
    return this.client.request(endpoints.accessLog(opts.page ?? 0));
  }

  /** One page (1000 rows) of physical gate open/closed transitions. */
  gateStatusLog(opts: { page?: number } = {}): Promise<GateStatusLogPage> {
    return this.client.request(endpoints.gateStatusLog(opts.page ?? 0));
  }

  // -- pagination helpers -------------------------------------------------- //

  /** Yield every access-log row, walking pages until `hasMore` is false. */
  async *iterAccessLog(opts: { startPage?: number } = {}): AsyncGenerator<AccessLogEntry> {
    let page = opts.startPage ?? 0;
    for (;;) {
      const result = await this.accessLog({ page });
      yield* result.logs;
      if (!result.hasMore) return;
      page += 1;
    }
  }

  /** Yield every gate status-change row across all pages. */
  async *iterGateStatusLog(
    opts: { startPage?: number } = {},
  ): AsyncGenerator<GateStatusLogEntry> {
    let page = opts.startPage ?? 0;
    for (;;) {
      const result = await this.gateStatusLog({ page });
      yield* result.logs;
      if (!result.hasMore) return;
      page += 1;
    }
  }
}
