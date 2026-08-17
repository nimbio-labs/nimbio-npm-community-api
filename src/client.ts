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
import * as sse from "./sse.js";
import type {
  AccountKey,
  AccessLogEntry,
  AccessLogPage,
  CommunityKey,
  GateStatus,
  GateStatusLogEntry,
  GateStatusLogPage,
  Health,
  HoldOpenEventAdded,
  HoldOpenEventRemoved,
  KeySchedule,
  KeySchedules,
  ScheduleWindowInput,
  HoldOpens,
  KeyStatuses,
  ManualHoldOpenResult,
  Me,
  MemberAccessLogPage,
  Members,
  OpenResult,
  StreamMessage,
  Webhook,
  WebhookSecret,
  WebhookWriteResult,
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
 * Read one chunk, failing if nothing (not even a heartbeat) arrives within
 * the idle window — a silently dead connection must not hang the consumer.
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new errors.APITimeoutError()),
          sse.STREAM_READ_TIMEOUT_SECONDS * 1000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  /** Account-scoped operations (`client.account.*`) — your own keys. */
  readonly account: Account;
  private readonly fetchImpl: FetchLike;

  constructor(apiKey?: string, options: ClientOptions = {}) {
    super(apiKey, options);
    this.fetchImpl = resolveFetch(options.fetch);
    this.community = new Community(this);
    this.account = new Account(this);
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

  // -- live event stream plumbing ------------------------------------------ //

  /**
   * @internal Open the SSE stream request. No JSON handling and no overall
   * timeout — the stream is long-lived; idle detection happens at read time.
   */
  async streamFetch(
    path: string,
    params: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<Response> {
    const prepared = this.prepare("GET", path, { params });
    const url = prepared.params
      ? `${prepared.url}?${new URLSearchParams(prepared.params).toString()}`
      : prepared.url;
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: prepared.headers,
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      const message = e instanceof Error && e.message ? e.message : "Connection error";
      throw new errors.APIConnectionError(message, { cause: e });
    }
  }

  /** @internal Throw the mapped APIError for a non-200 stream response. */
  async throwStreamError(resp: Response): Promise<never> {
    const bodyText = await resp.text();
    this.parseResponse(resp.status, this.decode(bodyText), headersToObject(resp.headers));
    // parseResponse always throws for non-2xx; this is unreachable.
    throw new errors.APIConnectionError("Unexpected stream response");
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
 * `client.account.*` — account-scoped operations (your own keys).
 *
 * Requires an account-scoped API key; community-scoped keys throw
 * {@link PermissionDeniedError} (`not_account_key`).
 */
export class Account {
  constructor(private readonly client: NimbioClient) {}

  /** Every Nimbio key on your account, with its latches nested. */
  keys(opts: { includeHidden?: boolean } = {}): Promise<AccountKey[]> {
    return this.client.request(endpoints.accountKeys(opts.includeHidden ?? false));
  }

  /**
   * Open one of your latches through one of your keys. Live keys fire the
   * gate (synchronous — the Promise resolves once the box confirms); test
   * keys simulate. Denials throw {@link PermissionDeniedError}; a
   * non-confirming gate throws {@link GateNotOpenedError}.
   */
  open(
    keyId: string,
    latchId: string,
    opts: { note?: string; idempotencyKey?: string } = {},
  ): Promise<OpenResult> {
    return this.client.request(
      endpoints.accountOpen(keyId, latchId, opts.note, opts.idempotencyKey),
    );
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

  // -- hold opens ------------------------------------------------------------ //

  /**
   * Hold-open state per latch: the combined `heldOpen` truth, the `manual`
   * toggle, one-time `events`, and `recurring` schedules. Requires the
   * community's Hold Opens feature to be enabled.
   */
  holdOpens(): Promise<HoldOpens> {
    return this.client.request(endpoints.holdOpens());
  }

  /**
   * Turn the manual hold open on/off for a latch. `manual` reflects only this
   * toggle; turning it off does not cancel an active scheduled window. Test
   * keys simulate.
   */
  setHoldOpen(latchId: string, state: boolean): Promise<ManualHoldOpenResult> {
    return this.client.request(endpoints.setHoldOpen(latchId, state));
  }

  /**
   * Add a one-time hold-open window (`"YYYY-MM-DD HH:MM"`, latch-local time).
   * Keep the returned `eventId` to end the window early.
   */
  addHoldOpenEvent(
    latchId: string,
    opts: { start: string; end: string },
  ): Promise<HoldOpenEventAdded> {
    return this.client.request(
      endpoints.addHoldOpenEvent(latchId, opts.start, opts.end),
    );
  }

  /** Remove a one-time hold-open window early. Idempotent. */
  removeHoldOpenEvent(
    latchId: string,
    eventId: string,
  ): Promise<HoldOpenEventRemoved> {
    return this.client.request(endpoints.removeHoldOpenEvent(latchId, eventId));
  }

  // -- key access schedules ---------------------------------------------------- //

  /**
   * Access schedules for the community's keys.
   *
   * Returns the community's own key(s) plus every member key that currently
   * **has** a schedule. Unrestricted member keys are omitted — a community can
   * hold tens of thousands of them — so use {@link keySchedule} to read one by
   * id.
   *
   * `blocked` lists keys denied at all times because a saved schedule is
   * switched off. Does not consume the monthly quota.
   */
  keySchedules(): Promise<KeySchedules> {
    return this.client.request(endpoints.keySchedules());
  }

  /** One key's access schedule. Does not consume the monthly quota. */
  keySchedule(keyId: string): Promise<KeySchedule> {
    return this.client.request(endpoints.keySchedule(keyId));
  }

  /**
   * Replace a key's access schedule.
   *
   * `windows` is the COMPLETE schedule — pass `[]` to remove every
   * restriction. Days are letters from `MTWHFSU` (**H is Thursday**, U is
   * Sunday). Times are `"HH:MM"` in each gate's local time and cannot run past
   * midnight, so send two windows for overnight access.
   *
   * A schedule on the community key applies to every member key beneath it —
   * check `descendantKeyCount` first. Test keys simulate.
   */
  setKeySchedule(
    keyId: string,
    windows: ScheduleWindowInput[] | null | undefined,
  ): Promise<KeySchedule> {
    return this.client.request(endpoints.setKeySchedule(keyId, windows));
  }

  // -- webhooks ---------------------------------------------------------------- //

  /** The catalog of event types a webhook can subscribe to. */
  webhookEventTypes(): Promise<string[]> {
    return this.client.request(endpoints.webhookEventTypes());
  }

  /** All webhooks registered on the community (secrets never listed). */
  webhooks(): Promise<Webhook[]> {
    return this.client.request(endpoints.webhooks());
  }

  /**
   * Register a webhook (public https only). The HMAC signing secret is on
   * `.webhook.secret` of the result — returned ONCE, store it. Verify
   * deliveries with the `webhooks` module helpers.
   */
  createWebhook(
    url: string,
    events: readonly string[],
    opts: { description?: string } = {},
  ): Promise<WebhookWriteResult> {
    return this.client.request(
      endpoints.createWebhook(url, events, opts.description),
    );
  }

  /** Edit a webhook; `active: true` revives an auto-disabled one. */
  updateWebhook(
    webhookId: string,
    fields: {
      url?: string;
      events?: readonly string[];
      active?: boolean;
      description?: string;
    },
  ): Promise<WebhookWriteResult> {
    return this.client.request(endpoints.updateWebhook(webhookId, fields));
  }

  /** Delete a webhook and its subscriptions. */
  deleteWebhook(webhookId: string): Promise<WriteResult> {
    return this.client.request(endpoints.deleteWebhook(webhookId));
  }

  /** Mint a new signing secret (returned once); the old one stops working. */
  rotateWebhookSecret(webhookId: string): Promise<WebhookSecret> {
    return this.client.request(endpoints.rotateWebhookSecret(webhookId));
  }

  /** Queue a synthetic `ping` delivery to verify connectivity. */
  testWebhook(webhookId: string): Promise<WriteResult> {
    return this.client.request(endpoints.testWebhook(webhookId));
  }

  // -- live events ---------------------------------------------------------- //

  /**
   * Iterate the community's live events over SSE — the same payloads webhooks
   * deliver, pushed over an outbound connection (works behind NAT, no public
   * endpoint needed).
   *
   * Yields `{ kind: "event", id, type, data, payload }` per event, and
   * `{ kind: "reset", reason }` when the server cannot replay a reconnect
   * gap — re-seed via the status reads (`gateStatus()` / `holdOpens()`), then
   * keep iterating.
   *
   * With `reconnect: true` (default) dropped connections re-open with
   * exponential backoff, resuming from the last seen event id. HTTP errors
   * (401, 403, 429 `stream_limit`, ...) always throw. Pass an `AbortSignal`
   * to stop the stream (the generator returns cleanly). Connecting charges
   * one per-minute request and is monthly-quota-exempt; delivered events are
   * free.
   */
  async *streamEvents(
    opts: {
      events?: readonly string[];
      lastEventId?: string;
      reconnect?: boolean;
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<StreamMessage, void, undefined> {
    const { events, lastEventId, reconnect = true, signal } = opts;
    let cursor: string | null = lastEventId ?? null;
    let attempt = 0;

    for (;;) {
      if (signal?.aborted) return;
      let resp: Response;
      try {
        resp = await this.client.streamFetch(
          sse.STREAM_PATH,
          sse.streamParams(events, cursor),
          signal,
        );
      } catch (e) {
        if (signal?.aborted) return;
        if (!reconnect) throw e;
        await sleep(sse.backoffDelay(attempt));
        attempt += 1;
        continue;
      }
      if (resp.status !== 200) {
        await this.client.throwStreamError(resp);
      }

      if (resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        const parser = new sse.SSEParser();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await readWithIdleTimeout(reader);
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              let line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              const frame = parser.feed(line);
              if (!frame) continue;
              const model = sse.frameToModel(frame);
              if (!model) continue;
              attempt = 0;
              cursor = model.kind === "reset" ? null : model.id;
              yield model;
            }
          }
        } catch (e) {
          if (signal?.aborted) return;
          if (!reconnect) {
            if (e instanceof errors.NimbioError) throw e;
            const message =
              e instanceof Error && e.message ? e.message : "Connection error";
            throw new errors.APIConnectionError(message, { cause: e });
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            /* stream already closed */
          }
        }
      }

      // Stream ended (server close / deploy / slow-client drop) or a
      // transport error with reconnect enabled: back off and resume.
      if (signal?.aborted || !reconnect) return;
      await sleep(sse.backoffDelay(attempt));
      attempt += 1;
    }
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
