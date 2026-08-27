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
  ChangeLogType,
  GeofenceMode,
  GuestLinkType,
} from "./constants.js";
import type {
  AccountKey,
  AccessLogEntry,
  AccessLogPage,
  AccessCodes,
  AccessCodeCreateResult,
  AccessCodeEligibleLatches,
  AccessCodeLogPage,
  AccessCodeTemporalInput,
  AccessCodeWriteResult,
  BulkAddItem,
  BulkKeyItem,
  BulkResult,
  ChangeLogPage,
  CommunityInfo,
  CommunityKey,
  CommunityMap,
  CommunitySettings,
  CommunitySettingsInput,
  DeliveryReplayResult,
  GateStatus,
  GateStatusLogEntry,
  GateStatusLogPage,
  GeofenceWriteResult,
  GuestLink,
  GuestLinkLatchExclusions,
  GuestLinkLogPage,
  GuestLinkResult,
  GuestViewEntry,
  GuestViewEntryLogPage,
  Health,
  HoldOpenDisabledUntil,
  HoldOpenEventAdded,
  HoldOpenEventRemoved,
  Home,
  HomeRemoved,
  HomeWriteResult,
  KeySchedule,
  KeyUpdateResult,
  KeySchedules,
  ScheduleWindowInput,
  HoldOpens,
  KeyStatuses,
  KeyUsageReport,
  ManualHoldOpenResult,
  Me,
  MemberAccessLogPage,
  MemberDetail,
  Members,
  MembersPage,
  MessagePage,
  MoveOutDateResult,
  NfcScanLogPage,
  NfcTag,
  NfcTagPage,
  NfcTagWriteResult,
  NotificationSettings,
  OpenResult,
  RecurringHoldOpenRemoved,
  RecurringHoldOpenResult,
  RetryFailedResult,
  SenseLineDetail,
  SenseLineRecordPage,
  SenseLines,
  ShortCode,
  ShortCodeResult,
  StreamMessage,
  Webhook,
  WebhookDelivery,
  WebhookSecret,
  WebhookWriteResult,
  WriteResult,
} from "./models.js";

/** 30-day member-access-log window. */
export type MemberAccessLogWindow = "last_30" | "30_60" | "60_90";

/** Which roster list `membersPage()` reads. */
export type MemberBucket = "accepted" | "unaccepted" | "removed";

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

    // Adds `If-None-Match` when we already hold an ETag for this exact GET.
    // Returns the key the response is filed under, or null if not eligible.
    const key = this.beginConditional(prepared);

    let attempt = 0;
    for (;;) {
      const resp = await this.send(prepared);

      if (this.shouldRetry(resp.status, attempt)) {
        const headers = headersToObject(resp.headers);
        await sleep(this.retryDelay(attempt, headers));
        attempt += 1;
        continue;
      }

      // 304: the server confirmed nothing changed and sent no body. Re-parse
      // the stored one so the caller cannot tell this from a fresh 200.
      if (resp.status === 304) {
        return spec.parse(this.resolveNotModified(key));
      }

      const bodyText = await resp.text();
      const headers = headersToObject(resp.headers);
      const payload = this.decode(bodyText);
      const data = this.parseResponse(resp.status, payload, headers);
      this.finishConditional(key, resp.status, headers, bodyText);
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
   *
   * Deliberately bypasses `request()`, so conditional caching never touches the
   * stream: an unbounded response body has no representation to revalidate, and
   * the API leaves it non-cacheable for that reason.
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

  /**
   * Describe the community this key is bound to — **call this first.**
   *
   * The bootstrap read for any integration: the `latchId`s every open and
   * hold-open call takes, the `features` flags to branch on instead of
   * provoking a 403, and the timezone every timestamp on this API is
   * interpreted in. Live sensed state is not duplicated here — use
   * {@link gateStatus} for that.
   *
   * The community's clock lives on its hardware: each latch inherits its box's
   * timezone, so `timezone` is null when the latches disagree and each latch
   * carries its own. Contains no personal data, and is exempt from the monthly
   * quota — safe to call on startup and on every config refresh.
   */
  info(): Promise<CommunityInfo> {
    return this.client.request(endpoints.info());
  }

  /** Latest sensed open/closed state for every latch in the community. */
  gateStatus(): Promise<GateStatus> {
    return this.client.request(endpoints.gateStatus());
  }

  /** Pending / accepted / removed members. */
  members(): Promise<Members> {
    return this.client.request(endpoints.members());
  }

  /**
   * One bucket of the roster, paged and optionally searched.
   *
   * Prefer this to {@link members} for a large community or when you only need
   * one bucket — it ships far less data (and far fewer phone numbers) per call.
   *
   * `bucket` is `"accepted"` (default), `"unaccepted"` (pending join requests)
   * or `"removed"`. `page` is **1-indexed**; `size` is 1–500 (default 100).
   * `search` is a case-insensitive substring match over first name, last name
   * and phone number, and ignores punctuation in numbers — `"555-1234"` matches
   * `"+1 555-123-4567"`. Filtering happens before paging, so `total` counts the
   * matches and paging through a search never skips anyone.
   *
   * Homes appear as a single row with `isHome: true` listing their members'
   * ids, not as people.
   */
  membersPage(
    opts: {
      bucket?: MemberBucket;
      page?: number;
      size?: number;
      search?: string;
    } = {},
  ): Promise<MembersPage> {
    return this.client.request(endpoints.membersPage(opts));
  }

  /**
   * One member by `accountCommunityId` — the id `members()` reports and a
   * `member.requested` webhook carries.
   *
   * `bucket` says which list they are in. A member of any other community
   * returns 404 exactly as an unknown id does: a key can only ever read its own
   * community's roster.
   */
  member(accountCommunityId: number): Promise<MemberDetail> {
    return this.client.request(endpoints.member(accountCommunityId));
  }

  /**
   * Messages already sent to this community, newest first — the read half of
   * {@link message}.
   *
   * `limit` is 1–200 (default 50); page with `offset` and stop when `hasMore`
   * is false. `sentAt` is ISO-8601 in **UTC**.
   *
   * Only real sends are recorded. A test-mode key's send is validated and
   * discarded, so nothing simulated ever appears here — a test key reads the
   * live history but can never add to it. Useful before re-sending after an
   * ambiguous failure.
   */
  messages(opts: { limit?: number; offset?: number } = {}): Promise<MessagePage> {
    return this.client.request(endpoints.messages(opts.limit, opts.offset));
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
   * Rename a community key, or disable it community-wide.
   *
   * Send `name`, `disabled`, or both — a field you omit is left alone; an empty
   * `fields` is rejected (422) rather than treated as a no-op.
   *
   * **Disabling a community key cuts every member holding a child of it.**
   * Sharing a key mints a *child* key on the recipient's account, and the
   * disabled state is inherited down that chain — so this can deny the entire
   * community at once. `descendantKeyCount` on the result is that blast radius;
   * read {@link keys} first if you are unsure which key you are about to cut.
   * It is reversible with `{ disabled: false }`, and never affects this API
   * key's own authorization, so you cannot lock yourself out of re-enabling it.
   *
   * To disable one member's access instead, use {@link setKeysDisabled}.
   * `name` is cosmetic (trimmed, non-empty, max 200 chars) — it changes what
   * members and access logs see, never who can open what. Test keys simulate.
   */
  updateKey(
    keyId: string,
    fields: { name?: string; disabled?: boolean },
  ): Promise<KeyUpdateResult> {
    return this.client.request(endpoints.updateKey(keyId, fields));
  }

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

  /**
   * Approve a pending join request and grant the member their keys.
   *
   * Closes the loop the `member.requested` webhook opens: the person in the
   * `unaccepted` bucket becomes an accepted member, gets a key on their account
   * for each id in `keyIds`, receives the approval push, and the community's
   * `member.approved` webhook fires — exactly as if a manager had approved them
   * in the portal.
   *
   * `moveOutDate` is an optional `"YYYY-MM-DD"` stamped on the membership.
   * Approving an already-approved member throws {@link ConflictError} (409,
   * `already_accepted`). `dryRun` validates without approving anyone, which is
   * what a live key can use to rehearse; test keys always simulate.
   */
  approveMember(
    accountCommunityId: number,
    keyIds: readonly string[],
    opts: { moveOutDate?: string; dryRun?: boolean } = {},
  ): Promise<WriteResult> {
    return this.client.request(
      endpoints.approveMember(
        accountCommunityId,
        keyIds,
        opts.moveOutDate,
        opts.dryRun ?? false,
      ),
    );
  }

  /**
   * Add many members by phone number in one call — the roster import.
   *
   * At most 100 items. Key scope, phone shape and in-batch duplicate numbers
   * are checked before anything is created, and any of them rejects the **whole
   * batch** (422) with nothing applied. Then each item is applied in request
   * order and reports its own result.
   *
   * **The highest-side-effect call on this API.** Each successful item may
   * create an account, mints keys, sends that member a push, and fires a
   * `member.approved` webhook — none of it undoable. An already-accepted member
   * fails with `already_member` while the rest of the batch still runs, so
   * re-submitting after a partial failure does not double-add anyone.
   *
   * Returns HTTP 207: read {@link BulkResult.failures}, since a 207 means the
   * batch ran, not that every item succeeded. Costs one monthly-quota unit
   * **per item** and one call against the per-minute limit. Test keys validate
   * and create nothing.
   */
  bulkAddMembers(items: readonly BulkAddItem[]): Promise<BulkResult> {
    return this.client.request(endpoints.bulkAddMembers(items));
  }

  /**
   * Grant community keys to many members in one call (at most 100 items).
   *
   * Every item is checked against your community *before* anything is applied —
   * one member or key belonging elsewhere rejects the whole batch (422) with
   * nothing changed. Grants are idempotent: a key the member already holds is
   * reported under `granted.exists` and changes nothing, so re-submitting a
   * batch (or just its failed items) is safe.
   *
   * Returns HTTP 207 with one entry per input item, in the same order — check
   * `failures`. One monthly-quota unit **per item**.
   */
  bulkGrantKeys(items: readonly BulkKeyItem[]): Promise<BulkResult> {
    return this.client.request(endpoints.bulkGrantKeys(items));
  }

  /**
   * Revoke community keys from many members in one call (at most 100 items),
   * validated in full before anything is applied.
   *
   * **Keys only** — members stay accepted members. Removing a member entirely
   * is deliberately not batched: use {@link revokeKeys} with
   * `removeMember: true` per member, so a mass removal is always an explicit,
   * per-member act.
   *
   * Re-submitting is safe: a key the member no longer holds is reported under
   * `already_revoked_community_key_ids` and the item still succeeds. Returns
   * HTTP 207 — check `failures`. One monthly-quota unit **per item**.
   */
  bulkRevokeKeys(items: readonly BulkKeyItem[]): Promise<BulkResult> {
    return this.client.request(endpoints.bulkRevokeKeys(items));
  }

  /**
   * Disable or re-enable many members' keys in one call (at most 100 items) —
   * reversible, no key is removed. `disabled` applies to the whole batch.
   *
   * Setting a key to the state it is already in is a no-op, so re-submitting is
   * safe. A key the member does not hold is a per-item `key_not_held` failure:
   * unlike revoke there is no "already in the desired state" reading, and
   * enabling a key someone does not have needs a grant, not a toggle.
   *
   * Returns HTTP 207 — check `failures`. One monthly-quota unit **per item**.
   */
  bulkSetKeysDisabled(
    items: readonly BulkKeyItem[],
    disabled: boolean,
  ): Promise<BulkResult> {
    return this.client.request(endpoints.bulkSetKeysDisabled(items, disabled));
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

  /**
   * Suspend **every** scheduled hold open on a latch — the holiday /
   * special-event override — or resume them.
   *
   * While the suspension is in force the scheduler skips all recurring and
   * one-time windows on this latch and releases any hold already active. It
   * clears itself once the moment passes.
   *
   * `until` is `"YYYY-MM-DD HH:MM"` in the **latch's local time** (the
   * `timezone` {@link holdOpens} reports for it), never UTC. It is required:
   * pass an explicit `null` to resume, so an empty body can never resume by
   * accident. Per latch, not per community — suspending one gate leaves the
   * others running. Requires the Hold Opens feature (403 `hold_opens_disabled`).
   * Test keys simulate.
   */
  setHoldOpenDisabledUntil(
    latchId: string,
    until: string | null,
  ): Promise<HoldOpenDisabledUntil> {
    return this.client.request(endpoints.setHoldOpenDisabledUntil(latchId, until));
  }

  /**
   * Hold a gate open on a repeating weekly schedule — business hours, trash
   * day, a standing delivery window.
   *
   * **Days** are letters from `MTWHFSU`, where **H is Thursday, S is Saturday
   * and U is Sunday** — the same string {@link holdOpens} emits, so a schedule
   * can be read and posted back unchanged. A 1–127 bitmask (1 = Monday …
   * 64 = Sunday) is accepted too.
   *
   * **Times** are `"HH:MM"` in the **latch's local time**, never UTC and with
   * no offset accepted: `"08:00"` means 08:00 at the gate. Omit both for an
   * **all-day** schedule (the supported way to say "all day"). A window may not
   * wrap past midnight — split `22:00`–`06:00` into `22:00`–`"24:00"` plus
   * `"00:00"`–`06:00` on the following day, using `"24:00"` rather than
   * `"23:59"` so the halves leave no gap.
   *
   * `recurringWeek` is 1 (every week, the default) up to 52. Keep the returned
   * `temporalDateId` to change or delete the schedule. Requires the Hold Opens
   * feature (403 `hold_opens_disabled`). Test keys simulate.
   */
  addHoldOpenRecurring(
    latchId: string,
    daysOfTheWeek: string | number,
    opts: {
      startTime?: string | null;
      endTime?: string | null;
      recurringWeek?: number;
    } = {},
  ): Promise<RecurringHoldOpenResult> {
    return this.client.request(
      endpoints.addHoldOpenRecurring(latchId, daysOfTheWeek, opts),
    );
  }

  /**
   * Change a recurring schedule. Partial update: any field left out keeps its
   * current value.
   *
   * Time handling is explicit rather than inferred:
   *
   * - `startTime` + `endTime` **replace** the window,
   * - `clearTimes: true` removes it, making the schedule all-day,
   * - sending neither leaves the times alone.
   *
   * Sending times *and* `clearTimes` together is rejected. Days are `MTWHFSU`
   * letters (**H is Thursday**, S Saturday, U Sunday) and times are `"HH:MM"`
   * in the **latch's local time**, with the same no-wrapping-past-midnight rule
   * as {@link addHoldOpenRecurring}. An id that is not on this latch throws
   * {@link NotFoundError}. Requires the Hold Opens feature. Test keys simulate.
   */
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
  ): Promise<RecurringHoldOpenResult> {
    return this.client.request(
      endpoints.updateHoldOpenRecurring(latchId, temporalDateId, fields),
    );
  }

  /**
   * Delete a recurring hold-open schedule.
   *
   * **Deliberately not idempotent**, unlike {@link removeHoldOpenEvent}: a
   * `temporalDateId` that is not on this latch throws {@link NotFoundError}
   * (404) rather than reporting a cheerful success, because succeeding silently
   * would let you believe you had cancelled a schedule that is still holding a
   * gate open. Requires the Hold Opens feature. Test keys simulate.
   */
  removeHoldOpenRecurring(
    latchId: string,
    temporalDateId: string,
  ): Promise<RecurringHoldOpenRemoved> {
    return this.client.request(
      endpoints.removeHoldOpenRecurring(latchId, temporalDateId),
    );
  }

  // -- key access schedules ---------------------------------------------------- //
  //
  // Community keys only. A schedule on the community key is the community-wide
  // rule and cascades to every member key beneath it; an individual member's
  // key is refused with `not_a_community_key` (403).

  /**
   * Access schedules for the community's own keys.
   *
   * Community keys only — member keys are neither listed nor schedulable, since
   * a restriction on the community key already applies to every member beneath
   * it. {@link keySchedule} and {@link setKeySchedule} refuse a member's key
   * with `not_a_community_key` (403).
   *
   * `windows` holds only what is in force today; anything whose date range has
   * passed is counted in `inactiveWindowCount` instead.
   *
   * `blocked` lists keys denied at all times because a saved schedule is
   * switched off. Does not consume the monthly quota.
   */
  keySchedules(): Promise<KeySchedules> {
    return this.client.request(endpoints.keySchedules());
  }

  /**
   * One community key's access schedule.
   *
   * `keyId` must be one of the community's own keys; a member's key is refused
   * with `not_a_community_key` (403). Returns **every** window, expired ones
   * included, because {@link setKeySchedule} replaces the whole schedule. Does
   * not consume the monthly quota.
   */
  keySchedule(keyId: string): Promise<KeySchedule> {
    return this.client.request(endpoints.keySchedule(keyId));
  }

  /**
   * Replace a community key's access schedule.
   *
   * `windows` is the COMPLETE schedule — pass `[]` to remove every
   * restriction. Days are letters from `MTWHFSU` (**H is Thursday**, U is
   * Sunday). Times are `"HH:MM"` in each gate's local time and cannot run past
   * midnight, so send two windows for overnight access.
   *
   * Community keys only: a member's own key is refused with
   * `not_a_community_key` (403). The schedule applies to every member key
   * beneath the community key, so check `descendantKeyCount` (live members
   * only) first. Test keys simulate.
   */
  setKeySchedule(
    keyId: string,
    windows: ScheduleWindowInput[] | null | undefined,
  ): Promise<KeySchedule> {
    return this.client.request(endpoints.setKeySchedule(keyId, windows));
  }

  // -- community settings ------------------------------------------------------ //

  /**
   * The community's whole configuration: what you may change (`settings`),
   * what Nimbio provisions (`readOnly`), and the member/home labels in force.
   *
   * **The `readOnly` block is why this call is worth making.** Several endpoint
   * families are gated on those flags, and without this read the only way to
   * learn a feature is off is to call it and take a 403:
   * `allowHoldOpens` false 403s every hold-open path,
   * `isOpenLogHistoryEnabled` false 403s {@link accessLog} and
   * {@link gateStatusLog}, and `readOnly.eventKeysEnabled` is the *resolved*
   * answer for event keys — the settable `eventKeysOverride`
   * (`inherit`/`allow`/`deny`) combined with the property type's default.
   *
   * Unlike {@link info}, this read **does** consume the monthly quota: it is
   * setup-time configuration, not something to poll. Branch on
   * `info().features` in a hot loop and call this when configuring.
   */
  settings(): Promise<CommunitySettings> {
    return this.client.request(endpoints.settings());
  }

  /**
   * Change the community's configuration — a partial update of the fifteen
   * settable keys.
   *
   * **All or nothing.** Only the keys you send are applied, but the whole patch
   * is validated *before* anything is written, so a batch containing one bad
   * value applies **nothing** — you never have to reason about a half-applied
   * profile. `changed` on the result names the keys actually applied.
   *
   * **An unknown key is rejected, never ignored** — 422 `invalid_setting`
   * naming it. Keys outside the typed fifteen are forwarded verbatim so that
   * rejection reaches you rather than being silently dropped here.
   *
   * `allowHoldOpens`, `isOpenLogHistoryEnabled`, `allowGuestViewEntry` and the
   * two per-community caps (`event_key_max_window_hours`,
   * `limited_use_link_max_uses`) are Nimbio provisioning decisions — nobody
   * changes them from the CM portal either. Sending one is 422
   * `invalid_setting` telling you to contact support; read them from
   * {@link settings}'s `readOnly` instead.
   *
   * Terminology: within a side (`member*` / `home*`) a custom label and a
   * picker option are **mutually exclusive** — setting one clears the other.
   * Labels cap at 255 characters, icons at 64, control characters are refused,
   * and `""` or null clears a custom label back to the default.
   *
   * **These settings change what the rest of the API does**: turning
   * `allowDirectoryViewing` off makes the directory disappear for members and
   * guests, and `eventKeysOverride: "deny"` stops event keys community-wide
   * whatever the property type allows. Test keys validate the whole patch and
   * return `result: "simulated"` with the community's *unchanged* settings.
   */
  updateSettings(settings: CommunitySettingsInput): Promise<CommunitySettings> {
    return this.client.request(endpoints.updateSettings(settings));
  }

  // -- homes / units roster ---------------------------------------------------- //

  /**
   * Every home (unit) in the community with its resident count, sorted by
   * address.
   *
   * `includeHidden` defaults to **true** — a roster sync wants the whole set.
   * Pass false to match what the CM portal lists. Rows carry `memberCount` but
   * not the residents themselves; use {@link home} for those.
   */
  homes(opts: { includeHidden?: boolean } = {}): Promise<Home[]> {
    return this.client.request(endpoints.homes(opts.includeHidden ?? true));
  }

  /**
   * Add a home (unit) to the community.
   *
   * Returns the created home as a full resource — id, address, flags, resident
   * count — so a roster sync can record it without a second call. A test key
   * validates the address and creates nothing (`result: "simulated"`, `home`
   * null).
   */
  addHome(homeAddress: string): Promise<HomeWriteResult> {
    return this.client.request(endpoints.addHome(homeAddress));
  }

  /**
   * One home, plus its residents and their move-out dates.
   *
   * A home belonging to another community throws {@link NotFoundError} exactly
   * as an unknown id does. Call this before {@link removeHome} if you want to
   * know the blast radius before committing.
   */
  home(homeId: string): Promise<Home> {
    return this.client.request(endpoints.home(homeId));
  }

  /**
   * Edit a home: any of `homeAddress`, `ownerOccupied`, `hidden`. A field you
   * omit is left alone, so you can change one without reading the rest; an
   * empty `fields` is a 400 (`no_fields`) rather than a no-op.
   *
   * `hidden` is a **setter, not a toggle** — `{ hidden: true }` sent twice
   * leaves the home hidden, so a retry is safe. Hiding a home that still has
   * residents attached throws {@link ConflictError} (409 `home_occupied`);
   * move them out first. Test keys validate and change nothing.
   */
  updateHome(
    homeId: string,
    fields: { homeAddress?: string; ownerOccupied?: boolean; hidden?: boolean },
  ): Promise<HomeWriteResult> {
    return this.client.request(endpoints.updateHome(homeId, fields));
  }

  /**
   * Remove a home from the community — **the most destructive call on this
   * surface, and it reaches beyond the home itself.**
   *
   * Deleting a home **detaches every resident attached to it.** They remain
   * members of the community and keep their keys, but they are no longer
   * associated with any unit, and **nothing restores the association
   * automatically** — you would have to re-add the home and re-attach each
   * resident by hand.
   *
   * `detachedMemberCount` on the result reports how many were affected. Call
   * {@link home} first if you want to know the blast radius *before*
   * committing. A test key reports the count it would detach and changes
   * nothing.
   */
  removeHome(homeId: string): Promise<HomeRemoved> {
    return this.client.request(endpoints.removeHome(homeId));
  }

  /**
   * Record — or clear — a member's move-out date, so their access lapses
   * without anyone remembering to revoke it.
   *
   * `moveOutDate` is `"YYYY-MM-DD"`; pass **null to clear** a recorded date.
   * The argument is required, so an empty call can never clear one by
   * accident. The member must belong to this community — anyone else throws
   * {@link NotFoundError}. Test keys validate and change nothing.
   */
  setMoveOutDate(
    accountCommunityId: number | string,
    moveOutDate: string | null,
  ): Promise<MoveOutDateResult> {
    return this.client.request(
      endpoints.setMoveOutDate(accountCommunityId, moveOutDate),
    );
  }

  // -- my member-open notifications -------------------------------------------- //
  //
  // Scoped to the community MANAGER who owns the API key, not to the community.
  // Two keys owned by two managers of one community read and write two
  // different settings objects through these same four paths.

  /**
   * Member-open notification settings for **the community manager who owns
   * this API key** — not a community-wide setting.
   *
   * A community may have several managers, each with their own alert
   * preference and their own quiet hours, so two keys owned by two managers of
   * the same community return two different objects here.
   *
   * `enabled` is whether *that manager* is pushed a notification when a member
   * opens a gate. `featureAvailable` is whether the community allows the
   * feature at all — when it is false the three writes below return 403
   * `open_notifications_disabled` and `enabled` has no effect. Does not consume
   * the monthly quota.
   */
  myNotificationSettings(): Promise<NotificationSettings> {
    return this.client.request(endpoints.myNotificationSettings());
  }

  /**
   * Turn member-open alerts on or off for **the community manager who owns
   * this API key** — not for the community, and not for its other managers.
   * Turning them off through one key does nothing to another manager's alerts.
   *
   * Returns the full updated settings object, quiet-hours list included, so no
   * follow-up {@link myNotificationSettings} is needed. Requires the
   * community's member-open notifications feature (`featureAvailable`);
   * otherwise 403 `open_notifications_disabled`. Test keys validate and never
   * save (`result: "simulated"`).
   */
  setMyNotificationsEnabled(enabled: boolean): Promise<NotificationSettings> {
    return this.client.request(endpoints.setMyNotificationsEnabled(enabled));
  }

  /**
   * Add one quiet-hours window to **the settings of the community manager who
   * owns this API key** — it suppresses that manager's alerts only.
   *
   * **A quiet-hours window MAY wrap past midnight, and `"24:00"` is NOT
   * accepted here.** `{ startTime: "22:00", endTime: "06:00" }` is *one*
   * window, and `daysOfTheWeek` names the day it **starts** on. This is the
   * exact opposite of {@link addHoldOpenRecurring} and {@link setKeySchedule},
   * which cannot wrap and use `"24:00"` as an end-of-day sentinel to split an
   * overnight range in two. Carrying that habit across fails **silently**: two
   * half-windows here suppress nothing at the hours you meant, and you find out
   * from the alerts that arrive at 3am. A start equal to its end is refused
   * (422 `invalid_time`) — a zero-length window suppresses nothing. Omit both
   * times for an all-day window on the named days.
   *
   * **Timezone: a window is evaluated in the local timezone of the gate that
   * was opened** (each device carries its own) — not the manager's timezone
   * and not UTC. A community with gates in two timezones therefore suppresses
   * each gate's alerts on that gate's own clock. Getting this backwards is the
   * other way a window silently fails to suppress real alerts.
   *
   * Days are letters from `MTWHFSU` (**H is Thursday**, S Saturday, U Sunday).
   * Quiet hours are **additive**: each call appends one window — to replace a
   * schedule, delete the windows you no longer want with
   * {@link removeQuietHours}. Returns the full updated settings object.
   * Requires the member-open notifications feature (403 otherwise). Test keys
   * validate and never save.
   */
  addQuietHours(
    daysOfTheWeek: string,
    opts: { startTime?: string | null; endTime?: string | null } = {},
  ): Promise<NotificationSettings> {
    return this.client.request(endpoints.addQuietHours(daysOfTheWeek, opts));
  }

  /**
   * Delete one quiet-hours window from **the settings of the community manager
   * who owns this API key**.
   *
   * The window must belong to that manager: an id belonging to a different
   * manager — **including another manager of the same community** — throws
   * {@link NotFoundError} and deletes nothing, because the API deliberately
   * does not distinguish "not yours" from "does not exist".
   *
   * One call removes one window, the mirror of {@link addQuietHours}. Returns
   * the full updated settings object. Test keys validate ownership and never
   * delete.
   */
  removeQuietHours(
    quietHoursId: number | string,
  ): Promise<NotificationSettings> {
    return this.client.request(endpoints.removeQuietHours(quietHoursId));
  }

  // -- guest links --------------------------------------------------------- //
  //
  // A guest link is a bearer credential in a URL: whoever holds it opens the
  // gate, with no account, no key and no login. Every response in this section
  // that carries `token`/`url` is therefore secret material, the LIST included.

  /**
   * Every guest link on the community, newest first.
   *
   * **A leaked listing is a leaked set of working gate links.** Each entry
   * carries its `token` and the ready-to-send `url`, exactly as the create call
   * returned them — anyone holding one can open the gate: no account, no key,
   * no login. Treat this response the way you would treat a password, and **do
   * not log it**. Logging responses at debug level is an entirely normal thing
   * to do, and here it writes working gate links to disk.
   *
   * That the secrets are listed is deliberate: a lost URL is recoverable, so a
   * guest who deleted the text message does not need a new link.
   *
   * `includeInactive` defaults to true; false narrows to `active` and
   * `upcoming` links. `state` is computed live — `active`, `upcoming`,
   * `expired`, `spent`, `revoked` or `feature_disabled` — so a link's state
   * changes with the clock, without any write.
   */
  guestLinks(opts: { includeInactive?: boolean } = {}): Promise<GuestLink[]> {
    return this.client.request(endpoints.guestLinks(opts.includeInactive ?? true));
  }

  /**
   * Mint a guest link and get back its URL — the "reservation confirmed, send
   * the guest their gate link" call.
   *
   * **The result is secret material**: `guestLink.token` and `guestLink.url`
   * are a bearer credential for the gates in `latchIds`. Deliver the URL to the
   * guest; do not log it. It can be read back later from {@link guestLinks},
   * which is exactly why that read is sensitive too.
   *
   * The two link types take different limits:
   *
   * - **`"event"`** — requires `title`, `windowStart` and `windowEnd`.
   *   Unlimited opens between those two instants. The window may not exceed the
   *   community's cap (**8 hours** unless the community raised it) and may not
   *   have already ended.
   * - **`"limited_use"`** — requires `maxUses`, from 1 to the community's cap
   *   (**20** by default). `expiresAt` is an optional wall-clock backstop which
   *   defaults to, and may not exceed, **30 days** out.
   *
   * **Datetimes are ISO-8601, and a naive string is read as UTC** — an offset
   * (including `Z`) is honoured, but communities carry no timezone of their
   * own, so `"2026-08-20T18:00:00"` means 18:00 UTC, not 18:00 where the gate
   * is. Everything comes back UTC. A datetime that does not parse is rejected
   * outright rather than quietly treated as absent.
   *
   * `keyId` names the community key behind the link and decides which gates the
   * link could ever reach; it may be omitted only when the community has
   * exactly one key. Every id in `latchIds` must be openable by that key and
   * must not appear in {@link guestLinkLatchExclusions} **for this link type**
   * — naming an excluded gate is a 422, so check that read first.
   *
   * **An API key can mint an `event` link even when the community has event
   * keys switched off.** That switch aims at *members*, and has never applied
   * to a manager acting on the management surface, so a settings flip cannot
   * break links a manager handed out for tonight; an API key inherits the
   * carve-out. This is a real widening: if your integration should honour the
   * community setting, read `features.eventKeys` from {@link info} and branch
   * on it yourself — the API will not do it for you.
   *
   * Test keys validate and mint nothing (`result: "simulated"`).
   */
  createGuestLink(
    linkType: GuestLinkType,
    latchIds: readonly string[],
    opts: {
      keyId?: string;
      title?: string;
      subtitle?: string;
      extraInfo?: string;
      /** `limited_use` only: 1 to the community cap (20 by default). */
      maxUses?: number;
      /** `limited_use` only: ISO-8601 backstop, ≤ 30 days out. */
      expiresAt?: string;
      /** `event` only: ISO-8601 window start. */
      windowStart?: string;
      /** `event` only: ISO-8601 window end, ≤ 8h after the start by default. */
      windowEnd?: string;
      notifyOnUse?: boolean;
    } = {},
  ): Promise<GuestLinkResult> {
    return this.client.request(endpoints.createGuestLink(linkType, latchIds, opts));
  }

  /**
   * Kill a guest link — the "guest checked out" call.
   *
   * **Terminal: there is no un-revoke.** A revoked link stops opening the gate
   * immediately and cannot be brought back; mint a new one instead. Revoking an
   * already-revoked link is a successful no-op, so a retry is safe.
   *
   * An id belonging to another community is a 404 — identical to an unknown id,
   * because an API key must not be able to probe another community's ids. Test
   * keys report what they would have revoked and leave the link live.
   */
  revokeGuestLink(guestLinkId: number | string): Promise<GuestLinkResult> {
    return this.client.request(endpoints.revokeGuestLink(guestLinkId));
  }

  /**
   * Every attempt against the community's guest links, newest first —
   * successes, refusals and rate-limited hits alike.
   *
   * **This is guest PII.** Rows carry the redeemer's IP address and user agent,
   * and the display name of a signed-in account when the community requires
   * one. Handle and retain them accordingly.
   *
   * `guestLinkId` narrows to one link; a link belonging to another community is
   * a 404, the same answer an unknown id gets. `limit` defaults to 50 and
   * `offset` to 0.
   */
  guestLinkLogs(
    opts: { guestLinkId?: number | string; limit?: number; offset?: number } = {},
  ): Promise<GuestLinkLogPage> {
    return this.client.request(endpoints.guestLinkLogs(opts));
  }

  /**
   * Gates the community has taken out of each guest-link type.
   *
   * **Absence is permission.** A gate that is not listed may back a link of
   * that type, so an empty answer means every gate the backing key opens is
   * offerable. Check this before {@link createGuestLink}: naming an excluded
   * gate is a 422.
   *
   * The list is **per link type** — `event` and `limitedUse` are separate, and
   * a gate barred from `event` links may still be fine for `limited_use` ones.
   *
   * **Read-only on purpose.** The setter behind this list narrows what a link
   * type may ever cover — a safety control — so exposing it to API callers was
   * deliberately deferred, not forgotten. It is changed in the CM portal.
   *
   * Does not consume the monthly quota.
   */
  guestLinkLatchExclusions(): Promise<GuestLinkLatchExclusions> {
    return this.client.request(endpoints.guestLinkLatchExclusions());
  }

  // -- access codes -------------------------------------------------------- //
  //
  // Keypad / GuestView PINs. The cleartext PIN is returned by exactly one call
  // (create) and by nothing else, and this key may only edit the codes it
  // created itself.

  /**
   * Every access code in the community — residents' own codes included,
   * matching what the CM portal shows.
   *
   * **The PIN is never returned here.** `codeMasked` is a run of asterisks and
   * `codeLength` its length; the cleartext comes back exactly once, from
   * {@link createAccessCode}. If you lose a PIN there is no way to read it
   * back — delete the code and create a new one.
   *
   * `apiManaged` is true for the codes this API key created, and those are the
   * only ones {@link updateAccessCode} and {@link deleteAccessCode} will touch;
   * anything else answers 404. `featureEnabled` mirrors the community's
   * Directory Access Codes setting — when it is false the writes return 403
   * `access_codes_disabled`.
   */
  accessCodes(): Promise<AccessCodes> {
    return this.client.request(endpoints.accessCodes());
  }

  /**
   * Mint a keypad / GuestView PIN on the community.
   *
   * **The PIN comes back exactly once — in this response**, on `.code`.
   * Deliver it to the visitor now; no later call reveals it, and
   * {@link accessCodes} shows only asterisks.
   *
   * Three independent limits, which do different things:
   *
   * - `expiresInHours` / `expiresInDays` — **mutually exclusive**; passing both
   *   is a 422. Either sets one absolute cutoff, computed **in UTC from the
   *   moment of this call**. After it passes the code is dead.
   * - `temporal` — a **recurring weekly window** (e.g. weekdays 09:00–17:00),
   *   evaluated in the **gate's own local timezone** at redemption, not UTC and
   *   not yours. It never expires on its own. Note its wire keys are `start`
   *   and `end`, not `start_time`/`end_time`; the camelCase names in
   *   {@link AccessCodeTemporalInput} are translated for you.
   *
   * A code may carry both, and then must satisfy both: inside the weekly window
   * *and* before the cutoff. Omitting both makes a code that works until it is
   * disabled or deleted.
   *
   * Every id in `latchIds` must appear in {@link accessCodeEligibleLatches} or
   * the call is rejected with `invalid_latch`. Test keys validate and create
   * nothing.
   */
  createAccessCode(
    code: string,
    latchIds: readonly string[],
    opts: {
      /** Absolute UTC cutoff, from now. Mutually exclusive with `expiresInDays`. */
      expiresInHours?: number;
      /** Absolute UTC cutoff, from now. Mutually exclusive with `expiresInHours`. */
      expiresInDays?: number;
      /** Recurring weekly window, in the GATE's local timezone. */
      temporal?: AccessCodeTemporalInput;
    } = {},
  ): Promise<AccessCodeCreateResult> {
    return this.client.request(endpoints.createAccessCode(code, latchIds, opts));
  }

  /**
   * Change a code **this key created** — switch it off after the visit
   * (`disabled: true`), re-point it at different gates, push out its cutoff, or
   * replace its weekly window.
   *
   * A code created by a resident in the app, or one belonging to another
   * community, answers 404: this endpoint does not reach either. Use the CM
   * portal for a resident's own PIN.
   *
   * **The PIN itself cannot be changed** — delete the code and create a new
   * one. Omitted fields are left as they are, and **there is no way to clear an
   * existing cutoff or weekly window**; to stop a code working, disable or
   * delete it. Sending no fields at all is a 400, not a no-op.
   *
   * `expiresIn*` and `temporal` mean exactly what they mean on create: a UTC
   * cutoff recomputed from *now* (so re-sending an unchanged `expiresInDays`
   * silently extends the code), and a recurring window evaluated in the gate's
   * local timezone. Test keys validate and change nothing.
   */
  updateAccessCode(
    directoryAccessCodeId: number | string,
    fields: {
      disabled?: boolean;
      latchIds?: readonly string[];
      expiresInHours?: number;
      expiresInDays?: number;
      temporal?: AccessCodeTemporalInput;
    },
  ): Promise<AccessCodeWriteResult> {
    return this.client.request(
      endpoints.updateAccessCode(directoryAccessCodeId, fields),
    );
  }

  /**
   * Delete a code **this key created**. The PIN stops working immediately and
   * its gate assignments go with it; the redemption log rows stay, so the
   * history of who came through is preserved.
   *
   * A resident's own code, or a code in another community, answers 404. Test
   * keys validate and delete nothing.
   */
  deleteAccessCode(
    directoryAccessCodeId: number | string,
  ): Promise<AccessCodeWriteResult> {
    return this.client.request(endpoints.deleteAccessCode(directoryAccessCodeId));
  }

  /**
   * The gates a community manager has allowed access codes to open.
   *
   * Every id passed to {@link createAccessCode} or {@link updateAccessCode}
   * must appear here, or the call is rejected with `invalid_latch`. **This
   * allowlist is set in the CM portal only** — the API can read it, not change
   * it. `featureEnabled` mirrors the community's Directory Access Codes
   * setting; when it is false the writes return 403 `access_codes_disabled`.
   *
   * Does not consume the monthly quota.
   */
  accessCodeEligibleLatches(): Promise<AccessCodeEligibleLatches> {
    return this.client.request(endpoints.accessCodeEligibleLatches());
  }

  /**
   * Every access-code entry attempt in the community, newest first.
   *
   * `limit` is clamped server-side to 1–200 (default 50) and `offset` floored
   * at 0. `result` names the outcome — `opened`, `code_not_found`,
   * `code_disabled`, `code_expired`, `temporal_blocked`, `latch_not_assigned`,
   * `open_failed`, ...
   *
   * `codeEnteredMasked` is asterisks, never the typed digits: a successful
   * attempt's entered code *is* a working PIN. Correlate a row to a code you
   * minted through `directoryAccessCodeId`, which is set whenever the entry
   * matched an existing code. Rows carry the visitor's `clientIp` and the code
   * owner's name — this is the community's own log, the same one the CM portal
   * shows.
   */
  accessCodeLogs(
    opts: { limit?: number; offset?: number } = {},
  ): Promise<AccessCodeLogPage> {
    return this.client.request(
      endpoints.accessCodeLogs(opts.limit ?? 50, opts.offset ?? 0),
    );
  }

  // -- GuestView Entry ----------------------------------------------------- //
  //
  // Guest entry from the community's GuestView directory: a master switch, the
  // set of gates it covers, and the recurring windows during which it works.
  // Every call here except the log read returns the whole settings object.

  /**
   * The complete GuestView Entry configuration in one read.
   *
   * - `allowed` — the community master switch.
   * - `eligibleLatches` — the gates a visitor may open. Nothing outside this
   *   set is reachable via GuestView Entry, whatever the schedule says.
   * - `schedule` — the recurring windows. **Each is evaluated in its latch's
   *   own local timezone**, not UTC and not yours. A latch with **no** windows
   *   is available to guests at any hour; the first window you add is what
   *   starts restricting it.
   * - `directoryViewingEnabled` — read-only context: whether the GuestView
   *   *directory listing* is on. That is a separate feature; guest entry does
   *   not require it.
   *
   * **Read this before {@link setGuestViewEntryLatches}**, which replaces the
   * whole eligible set. Quota-exempt (the per-minute limit still applies).
   */
  guestViewEntry(): Promise<GuestViewEntry> {
    return this.client.request(endpoints.guestViewEntry());
  }

  /**
   * Permit or forbid GuestView Entry for the community.
   *
   * An explicit setter, deliberately not a toggle: this call is retryable, and
   * a retried toggle would flip guest access back open. Sending the value it
   * already has is a successful no-op.
   *
   * Turning it off **leaves the eligible-latch set and the schedule intact**,
   * so turning it back on restores the same configuration — it is the safe way
   * to suspend guest entry, unlike sending `[]` to
   * {@link setGuestViewEntryLatches}, which destroys both. Returns the full
   * updated settings, so no follow-up read is needed. Test keys validate and
   * change nothing.
   */
  setGuestViewEntryEnabled(allowed: boolean): Promise<GuestViewEntry> {
    return this.client.request(endpoints.setGuestViewEntryEnabled(allowed));
  }

  /**
   * Set which gates a GuestView visitor may open.
   *
   * **This REPLACES the whole set** — that is why the API makes it a PUT. Any
   * currently-eligible latch you leave out loses guest eligibility, **and its
   * schedule windows are deleted along with it** (an ineligible latch never
   * opens, so its windows would be dead rows). A caller who adds one gate by
   * sending a one-element list silently destroys every other gate's schedule,
   * and nothing in the response says so.
   *
   * **Read-modify-write.** Read {@link guestViewEntry} and send back a modified
   * copy; never compose the list from memory:
   *
   * ```ts
   * const current = await community.guestViewEntry();
   * const ids = current.eligibleLatches.map((l) => l.latchId!);
   * await community.setGuestViewEntryLatches([...ids, newLatchId]);
   * ```
   *
   * Sending `[]` removes GuestView Entry from every gate — and every window
   * with it. To suspend guest entry without losing the configuration, use
   * `setGuestViewEntryEnabled(false)` instead.
   *
   * Every id must belong to this key's community; a foreign latch is a 404 and
   * **nothing is written**. Requires GuestView Entry to be switched on (403
   * `guest_view_entry_disabled` otherwise). Returns the full updated settings.
   * Test keys validate and change nothing.
   */
  setGuestViewEntryLatches(
    latchIds: readonly string[],
  ): Promise<GuestViewEntry> {
    return this.client.request(endpoints.setGuestViewEntryLatches(latchIds));
  }

  /**
   * Every GuestView Entry attempt on this community, newest first.
   *
   * **These rows identify visitors**: the name, phone number and IP of the
   * person who stood at the gate, alongside the result (`opened`, or a failure
   * reason such as `outside_schedule`, `latch_not_eligible`, `rate_limited`,
   * `scan_required`). Handle and retain them accordingly.
   *
   * `limit` is clamped server-side to 1–200 (default 50) and `offset` floors at
   * 0; `hasMore` is true when the page came back full. `success` filters:
   * `true` for opens only, `false` for failures only, omitted for everything —
   * so leave it out rather than passing a default. Readable whether or not
   * GuestView Entry is currently switched on, so history survives the feature
   * being turned off. Quota-exempt (the per-minute limit still applies).
   */
  guestViewEntryLogs(
    opts: { limit?: number; offset?: number; success?: boolean } = {},
  ): Promise<GuestViewEntryLogPage> {
    return this.client.request(endpoints.guestViewEntryLogs(opts));
  }

  /**
   * Add one recurring window during which GuestView Entry is permitted, applied
   * to each latch in `latchIds`.
   *
   * **Timezone: the window is evaluated in each LATCH's own local timezone**,
   * at the moment a visitor taps open — never UTC, never the caller's, never
   * the community's. `09:00`–`17:00` on a latch in Los Angeles means 9-to-5
   * Pacific, and the same window on a latch in New York means 9-to-5 Eastern.
   * A latch whose timezone cannot be resolved skips the check and stays
   * available around the clock.
   *
   * **Midnight rule — this one wraps, and `"24:00"` is NOT accepted.** An
   * `endTime` earlier than `startTime` is one window running past midnight, and
   * `daysOfTheWeek` names the day it **starts** on. Times are `"HH:MM"`
   * 24-hour, `00:00`–`23:59`, or null for an unbounded end. The API has three
   * different conventions here and they are not interchangeable:
   *
   * | Surface | Wraps past midnight? | `"24:00"`? |
   * |---|---|---|
   * | GuestView Entry schedule (this call) | yes | no |
   * | Quiet hours ({@link addQuietHours}) | yes | no |
   * | Recurring hold opens / key schedules | no — send two windows | yes, as end-of-day |
   *
   * Splitting an overnight window in two here does not fail loudly; it just
   * permits different hours than you meant.
   *
   * `daysOfTheWeek` is a string of `MTWHFSU` letters — **H is tHursday and U is
   * sUnday** — with no repeats and at least one day. **The schedule is a
   * whitelist**: a latch with no windows is open to guests at any hour, so the
   * first window you add is what starts restricting that gate.
   *
   * Returns the full updated settings, with the new windows' ids in
   * `createdScheduleIds` (one per latch). A latch outside this community is a
   * 404. Test keys validate and change nothing.
   */
  addGuestViewEntrySchedule(
    daysOfTheWeek: string,
    latchIds: readonly string[],
    opts: { startTime?: string | null; endTime?: string | null } = {},
  ): Promise<GuestViewEntry> {
    return this.client.request(
      endpoints.addGuestViewEntrySchedule(daysOfTheWeek, latchIds, opts),
    );
  }

  /**
   * Delete one GuestView Entry window, by the `scheduleId` from
   * {@link guestViewEntry}.
   *
   * **Removing a window widens access**, and removing a latch's *last* window
   * makes that gate available to guests **at any hour** — the schedule is a
   * whitelist of permitted times, not a blacklist. Treat this like any other
   * permission-widening write.
   *
   * **Timezone reminder:** the windows you are choosing between are evaluated
   * in each latch's own local timezone, so read the settings first and delete
   * by id rather than reasoning about times in your own zone.
   *
   * An id belonging to another community is a 404 and nothing is deleted.
   * Returns the full updated settings, with `removedScheduleId` set. Test keys
   * validate and change nothing.
   */
  removeGuestViewEntrySchedule(
    scheduleId: number | string,
  ): Promise<GuestViewEntry> {
    return this.client.request(endpoints.removeGuestViewEntrySchedule(scheduleId));
  }

  // -- GuestView short codes ----------------------------------------------- //

  /**
   * Every GuestView short code assigned to your community.
   *
   * A short code is what a visitor types (or reaches via the QR on a placard)
   * to open your community's guest directory and call a resident. Each entry
   * carries the `latchId` it routes to plus the gate's `latchName`, so signage
   * can be rendered or verified without a second lookup. `latchId` is null for
   * a code that routes to the directory without preselecting a gate.
   *
   * Codes belonging to other communities are never listed here.
   */
  shortCodes(): Promise<ShortCode[]> {
    return this.client.request(endpoints.shortCodes());
  }

  /**
   * Mint a GuestView short code — the code your gate placard or sign displays.
   *
   * Omit `code` and the server generates one (7 letters and digits), the same
   * way the portal does; generation retries on collision, so that path
   * effectively never 409s. Supply `code` to claim a specific one: 6–10 letters
   * and digits, and **short codes are unique across all of Nimbio, not just
   * your community** — a code already in use anywhere comes back 409
   * `short_code_taken`, including one that differs only in letter case, since a
   * placard is read by a person.
   *
   * `latchId` is optional and must be a gate in your community; without it the
   * code routes to your directory without preselecting a gate.
   *
   * **There is no way to delete a short code** — not through this API and not
   * through the portal. A code you mint is permanent, so mint them for signage
   * you intend to print, not per booking. Test keys validate and mint nothing.
   */
  createShortCode(
    opts: { code?: string; latchId?: string } = {},
  ): Promise<ShortCodeResult> {
    return this.client.request(endpoints.createShortCode(opts));
  }

  /**
   * Repoint an existing short code at a different gate — move a printed
   * placard's code from one latch to another without reprinting the sign.
   *
   * **Assignment is exclusive, so this silently detaches the gate the code
   * pointed at before.** The code routes to exactly one gate; nothing warns you
   * that the old gate just lost its code, and the change takes effect for the
   * next visitor who types it. Read {@link shortCodes} first if you need to
   * know what you are overwriting.
   *
   * The code must already belong to your community. An unknown code and a code
   * owned by a different community both answer 404 `short_code_not_found` — the
   * namespace is global, so the API deliberately gives no way to tell those two
   * apart, let alone to seize someone else's code. Claiming an unassigned code
   * minted by a Nimbio admin (a pre-printed placard from a batch) is likewise
   * not available here; that stays a portal operation.
   *
   * Test keys validate against your community and change nothing.
   */
  assignShortCode(code: string, latchId: string): Promise<ShortCodeResult> {
    return this.client.request(endpoints.assignShortCode(code, latchId));
  }

  // -- NFC tags ------------------------------------------------------------ //

  /**
   * Every NFC tag issued to your community, newest first.
   *
   * `search` matches on tag serial, physical UID, or the portal's notes. Paging
   * is 1-based; `resultsPerPage` is clamped to 1..200 server-side. The envelope
   * (`items`, `page`, `resultsPerPage`, `total`) is always the same shape,
   * whatever the query.
   *
   * **No cryptographic tag material is ever returned.** `tagUidHex` is the
   * fob's physical, publicly readable UID — it is what joins a tag to its rows
   * in {@link nfcScanLog}, not a secret.
   */
  nfcTags(
    opts: { search?: string | null; page?: number; resultsPerPage?: number } = {},
  ): Promise<NfcTagPage> {
    return this.client.request(endpoints.nfcTags(opts));
  }

  /**
   * One tag of your community.
   *
   * An unknown tag and a tag belonging to **another** community are the same
   * 404 `tag_not_found` — the API never confirms that someone else's tag
   * exists.
   */
  nfcTag(tagId: string | number): Promise<NfcTag> {
    return this.client.request(endpoints.nfcTag(tagId));
  }

  /**
   * Bind a tag to a gate, detach it, or disable/re-enable it — one call does
   * all three.
   *
   * Send `disabled` and/or `latchId`; sending neither is 422 `empty_patch`.
   *
   * - `{ disabled: true }` kills a lost fob, and **it takes effect for physical
   *   gate taps**: the next tap on any gate is refused.
   * - `{ latchId: "<gate id>" }` binds the tag to a gate — a tag opens the gate
   *   it is bound to, not a member's key. `{ latchId: null }` detaches it while
   *   leaving it in your community for later reassignment.
   *
   * **`disabled` is an explicit setter, never a toggle**, so revoking a stolen
   * fob never depends on state you read a moment ago, and a retry is safe.
   *
   * **Order matters when you send both.** `disabled` is applied first, so
   * `{ disabled: false, latchId: "…" }` revives and then binds in one call,
   * while `{ disabled: true, latchId: "…" }` is refused 422
   * `conflicting_fields` — a dead fob cannot be routed to a gate.
   *
   * **Throws {@link ConflictError} (409 `requires_confirmation`) when the write
   * would leave a Scan Only gate with no working tag. That is a warning, not a
   * veto** — revoking a stolen fob has to stay possible — so catch it and
   * repeat the call with `confirm: true`:
   *
   * ```ts
   * try {
   *   await community.updateNfcTag(tagId, { disabled: true });
   * } catch (e) {
   *   if (!(e instanceof ConflictError)) throw e;
   *   await community.updateNfcTag(tagId, { disabled: true, confirm: true });
   * }
   * ```
   *
   * Unknown tags and other communities' tags are both 404 `tag_not_found`.
   * A test key validates everything and **enables or disables no real physical
   * credential** — it answers `simulated: true` with `wouldChange`.
   */
  updateNfcTag(
    tagId: string | number,
    fields: { disabled?: boolean; latchId?: string | null; confirm?: boolean },
  ): Promise<NfcTagWriteResult> {
    return this.client.request(endpoints.updateNfcTag(tagId, fields));
  }

  /**
   * Every NFC tap recorded for your community, newest first.
   *
   * Filter by `result` (the scan outcome) or `tagUidHex` (one physical fob);
   * `limit` is clamped to 1..200 and `offset` floored at 0.
   *
   * Rows carry the tapping member's first and last name where the tap resolved
   * to one, so a security review can attribute a tap to a person; the device's
   * IP address and Nimbio-internal record ids are not exposed.
   */
  nfcScanLog(
    opts: {
      limit?: number;
      offset?: number;
      result?: string | null;
      tagUidHex?: string | null;
    } = {},
  ): Promise<NfcScanLogPage> {
    return this.client.request(endpoints.nfcScanLog(opts));
  }

  // -- sense lines ---------------------------------------------------------- //

  /**
   * Every sense line on your community's boxes — the answer to "why does this
   * gate always report closed?".
   *
   * A sense line is a physical input on a Nimbio box that reports whether a
   * gate actually moved. It is the feedback loop behind {@link gateStatus},
   * {@link gateStatusLog}, and the `sense_line.changed` event.
   *
   * **Read `reporting` first.** It is true only when both `senseLineOnline`
   * and `latchDataOnline` are on, which is exactly the condition for a
   * transition to update gate status or fire `sense_line.changed`. **A gate
   * stuck on one status with `reporting: false` is a configuration problem,
   * not a stuck gate.**
   *
   * Here `boxId` is a genuine **filter** — omit it for every box in the
   * community. (On {@link senseLine} and {@link updateSenseLine} it is
   * required instead.) Does not consume the monthly quota.
   */
  senseLines(opts: { boxId?: string | null } = {}): Promise<SenseLines> {
    return this.client.request(endpoints.senseLines(opts));
  }

  /**
   * One sense line, with everything needed to explain a gate's status.
   *
   * **`boxId` is required, not optional.** A sense line id is an input number
   * on a board, unique only within its box — two boxes in one community both
   * have a "sense line 1" — so the server answers 422 `box_id_required` rather
   * than guessing which one you meant.
   *
   * Beyond the flags, this adds `statusMap` (the configured meaning of each raw
   * state, set when the hardware was installed and **read-only** here) and
   * `lastRecord`, the most recent transition the box actually reported. **A
   * `lastRecord` weeks old on a gate that moves daily points at the wiring or
   * the box, not at the configuration** — which is the opposite diagnosis from
   * `reporting: false`.
   *
   * Does not consume the monthly quota.
   */
  senseLine(
    senseLineId: number | string,
    boxId: string,
  ): Promise<SenseLineDetail> {
    return this.client.request(endpoints.senseLine(senseLineId, boxId));
  }

  /**
   * Switch a sense line's two flags on or off. **`boxId` is required** — see
   * {@link senseLine}.
   *
   * Send only the flags you want to change; an omitted flag keeps its stored
   * value, and each value is an explicit set rather than a toggle, so
   * re-sending the same call is a no-op. Sending neither is 422 `no_fields`.
   *
   * **This changes what a real gate reports.** Turning either flag off freezes
   * the gate's status at its last known value for every app, for
   * {@link gateStatus}, and for the `sense_line.changed` event, and it affects
   * hold-open logic that reads gate state. Turning a miswired input off is a
   * legitimate repair — do it knowing the gate will stop reporting, not by
   * accident.
   *
   * Configuration only: the state-to-label wiring (`statusMap`) and the
   * creation of sense lines are installer operations, and the observed gate
   * state is what the hardware reports — deliberately not something an API key
   * can fabricate. A test key validates and scope-checks but reconfigures no
   * real hardware.
   */
  updateSenseLine(
    senseLineId: number | string,
    boxId: string,
    fields: { senseLineOnline?: boolean; latchDataOnline?: boolean },
  ): Promise<SenseLineDetail> {
    return this.client.request(
      endpoints.updateSenseLine(senseLineId, boxId, fields),
    );
  }

  /**
   * The **raw** transitions the boxes actually reported, newest first — not the
   * derived gate status.
   *
   * This is the endpoint to reach for when a gate misreports, for one specific
   * reason: **rows are written even when a sense line is switched off**, so a
   * healthy stream here alongside a stale {@link gateStatus} is proof the
   * wiring is fine and the configuration is not.
   *
   * `status` is the configured label for that `(senseLineId, state)` pair, or
   * **null when the state has no configured meaning** — an unmapped state is
   * itself a finding, so those rows are returned rather than dropped.
   *
   * `boxId` and `senseLineId` are optional filters here. For the
   * human-readable, latch-oriented version of the same history, see
   * {@link gateStatusLog}. Does not consume the monthly quota.
   */
  senseLineRecords(
    opts: {
      boxId?: string | null;
      senseLineId?: number | null;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<SenseLineRecordPage> {
    return this.client.request(endpoints.senseLineRecords(opts));
  }

  // -- map + geofences ------------------------------------------------------ //

  /**
   * Where your community's gates are, and the geofence each one advertises.
   *
   * Returns the community centre, one entry per Nimbio device with its own
   * location, and every gate on that device with its geofence config.
   * Coordinates are **WGS84 decimal degrees**; `radiusMeters` is **metres**.
   *
   * A gate with `geofence.center === null` has never had a fence configured —
   * use that latch's `boxLocation` as the suggested centre.
   *
   * **Security note: these coordinates say exactly where a property's entrances
   * are.** The response is scoped to your community key; treating it as
   * physical-security information downstream is on you.
   *
   * **This read consumes monthly quota**, unlike {@link gateStatus} — a map is
   * setup-time configuration that changes when a human moves a pin, not a poll
   * substitute.
   */
  map(): Promise<CommunityMap> {
    return this.client.request(endpoints.map());
  }

  /**
   * Change one gate's proximity geofence.
   *
   * **Partial update** — only the fields you send change, which is why it is a
   * PATCH. `latitude` and `longitude` move together: send both or neither.
   * There is deliberately **no way to clear a configured centre** here, because
   * a silent clear would stop a real gate's proximity behaviour with nothing to
   * show for it.
   *
   * **`radiusMeters` is in metres, and a value below `minRadiusMeters` (100) is
   * rejected with 422 `radius_below_minimum`, not silently raised.** Android's
   * Geofence API and iOS region monitoring both degrade below ~100 m, so a
   * smaller fence would read as configured and never fire. **Do not "fix" this
   * by clamping client-side** — a clamp would hand back a fence the caller did
   * not ask for; let the rejection reach them. The response always echoes the
   * effective `radiusMeters`.
   *
   * `mode` is `"prompt"` (notify the member on arrival, they tap to open) or
   * `"auto_open"` — see `GEOFENCE_MODES`. `enabled` turns the fence on or off;
   * enabling requires a centre, the gate's own or its device's location as a
   * fallback.
   *
   * A body with nothing to change is 400 `nothing_to_update`. The change is
   * stamped with your key's owning account and shows up on the CM portal's Map
   * screen. A test key validates and scope-checks, but a real gate's fence
   * never moves.
   */
  updateGeofence(
    latchId: string,
    fields: {
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
      enabled?: boolean;
      mode?: GeofenceMode;
    },
  ): Promise<GeofenceWriteResult> {
    return this.client.request(endpoints.updateGeofence(latchId, fields));
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

  /**
   * Delivery attempts for one webhook, newest first — what your receiver
   * returned and when, so you can tell a silently-broken endpoint from one
   * Nimbio never fired at.
   *
   * `status` is `pending`, `delivered` or `failed`; `lastStatusCode` /
   * `lastError` describe the most recent attempt, and `lastError` includes the
   * first part of **your own** endpoint's response body on a non-2xx reply.
   * `limit` is 1–200 (default 50). The event payload Nimbio sent is not echoed
   * back here. Reads work for test and live keys alike.
   */
  webhookDeliveries(
    webhookId: string,
    opts: { limit?: number } = {},
  ): Promise<WebhookDelivery[]> {
    return this.client.request(endpoints.webhookDeliveries(webhookId, opts.limit));
  }

  /**
   * Re-send every delivery for this webhook currently in the terminal `failed`
   * state, oldest first — the "my receiver was down for an hour, send me what I
   * missed" path.
   *
   * **The original `event_id` and payload are preserved**, so a receiver that
   * de-duplicates on the `X-Nimbio-Delivery` header (which carries the *event*
   * id, not the delivery id) correctly ignores an event it already processed —
   * and one that ignores it applies the event twice. Only `deliveryId` changes.
   * The signature is computed at send time from the webhook's **current**
   * secret, so a delivery replayed after a rotation fails a receiver still
   * validating against the old one.
   *
   * `limit` is 1–100 (default 50); `since` is an ISO-8601 instant that
   * restricts candidates to deliveries created at or after it. Deliveries still
   * `pending` are skipped (`skippedInFlight`) so a retry never races Nimbio's
   * own backoff, and candidates are de-duplicated by event id
   * (`skippedDuplicateEvent`) — calling this twice in a row re-sends nothing
   * the second time. The result reports what was actually enqueued.
   *
   * Throws {@link ConflictError} (409 `webhook_disabled`) if the webhook is
   * inactive or auto-disabled: re-enable it with
   * `updateWebhook(webhookId, { active: true })` first, or the re-sends would
   * be discarded unsent. **Test-mode keys enqueue nothing** and return
   * `result: "simulated"` — a replay POSTs a real event at your real receiver.
   */
  retryFailedDeliveries(
    webhookId: string,
    opts: { since?: string; limit?: number } = {},
  ): Promise<RetryFailedResult> {
    return this.client.request(endpoints.retryFailedDeliveries(webhookId, opts));
  }

  /**
   * Re-send one past delivery — the one you can see failed in
   * {@link webhookDeliveries}, once your receiver is fixed. Works for a
   * `failed` delivery and for a `delivered` one you no longer have.
   *
   * **The original `event_id` and payload are preserved byte for byte.** Nimbio
   * stores the exact envelope it POSTed and re-sends that, carrying the same
   * `event_id` — and therefore the same `X-Nimbio-Delivery` header — as the
   * original attempt. **A handler that de-duplicates on that header treats this
   * correctly as the event it already saw; a handler that ignores it applies
   * the event twice** — a second charge, a second gate open. The `deliveryId`
   * is new, so the replay appears in the delivery list next to the original,
   * which keeps its failure record.
   *
   * The signature is computed at send time from the webhook's **current**
   * secret with a fresh `X-Nimbio-Timestamp`, so a delivery replayed after a
   * secret rotation fails a receiver still validating against the old secret.
   *
   * Throws {@link ConflictError} (409) for `delivery_in_flight` — Nimbio is
   * still retrying that event and a replay would double-fire — and for
   * `webhook_disabled`, which you clear with
   * `updateWebhook(webhookId, { active: true })`. Unknown ids and ids belonging
   * to another community are indistinguishable 404s. **Test-mode keys enqueue
   * nothing** and return `result: "simulated"`.
   */
  replayDelivery(
    webhookId: string,
    deliveryId: string,
  ): Promise<DeliveryReplayResult> {
    return this.client.request(endpoints.replayDelivery(webhookId, deliveryId));
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

  /**
   * Your community's **configuration** audit trail — who changed what, when.
   *
   * This is the *change* log, and the distinction matters: {@link accessLog}
   * tells you a gate opened, this tells you someone rewrote the schedule that
   * let it open, and {@link gateStatusLog} tells you the gate physically moved.
   *
   * `type` picks one of four trails — `"hold_open"`, `"key_schedule"`,
   * `"guest_view"`, `"guest_link"` (see `CHANGE_LOG_TYPES`). Every row carries
   * the same envelope plus a `details` object holding the subject of the
   * change, and **`logId` is unique only within its own `logType`**.
   *
   * **Retention is 30 days on every trail**, so `days` above the cap is clamped
   * rather than rejected and nothing older is recoverable here — the window
   * actually used comes back as `days` / `dateFrom` / `dateTo`. Export on a
   * schedule if you need a longer archive. Timestamps are UTC, not
   * community-local.
   */
  changeLogs(
    type: ChangeLogType,
    opts: { days?: number; limit?: number; offset?: number } = {},
  ): Promise<ChangeLogPage> {
    return this.client.request(endpoints.changeLogs(type, opts));
  }

  /**
   * Per-key usage history over a date window — the same report a Community
   * Manager sees on the portal's Access Logs page.
   *
   * `from` and `to` are inclusive `YYYY-MM-DD` calendar days in the
   * **community's** timezone (echoed as `timezone`), and each row's `datetime`
   * is local time for that zone with no offset attached.
   *
   * **Read `reportType` before interpreting `user`.** The server picks the
   * attribution rule from the community's property type — there is no parameter
   * for it, because getting it wrong would misreport who opened a gate. On a
   * `"commercial"` community `user` is the actual opener; on a `"residential"`
   * one it is `"<master key owner> Keychain"`, so you cannot tell which member
   * of a household opened the gate. That groups; it does not anonymize.
   *
   * **A window wider than `maxRangeDays` (14) is clamped, not rejected** —
   * `dateFrom`/`dateTo` are what was used, `requestedFrom`/`requestedTo` what
   * you asked for, and `clamped` says whether they differ. Walk a longer period
   * in <= 14-day steps; the window itself may sit as far back as you like.
   *
   * Rows carry personal data: `phone` here is **not** the account holder's
   * number as on {@link accessLog}, but whatever the open recorded — the
   * visitor's number on guest opens, null on ordinary member ones.
   *
   * Requires the community's Access Log History setting to be on.
   */
  keyUsage(
    from: string,
    to: string,
    opts: { page?: number } = {},
  ): Promise<KeyUsageReport> {
    return this.client.request(endpoints.keyUsage(from, to, opts));
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
