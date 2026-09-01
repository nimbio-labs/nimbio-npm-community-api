/**
 * The API's known vocabularies, shipped as constants so callers never hand-type
 * them.
 *
 * `me().key.capabilities` and a webhook's `events` are plain strings on the
 * wire. A typo in a hand-written `"webhoks"` is a silent false negative — the
 * capability check simply returns false and the integration quietly does
 * nothing. Reference these constants instead and the compiler catches it.
 *
 * **These are open vocabularies, not closed enums.** The server may add a
 * capability or an event type at any time, and an older client must keep
 * working, so the types below accept any string while still autocompleting the
 * known values, and nothing here ever rejects an unrecognized one.
 */

/**
 * Every endpoint family an API key can be granted.
 *
 * Declared append-only and never renamed by the API, so a value here keeps
 * meaning the same thing across server versions. This is the community-scoped
 * set: an account-scoped key carries only {@link ACCOUNT_KEY_CAPABILITIES}.
 */
export const CAPABILITIES = Object.freeze([
  "open",
  "gate_status",
  "key_statuses",
  "hold_opens",
  "webhooks",
  "members",
  "messages",
  "access_logs",
  "key_schedules",
  "key_usage",
  "change_logs",
  "homes",
  "short_codes",
  "guest_view_entry",
  "access_codes",
  "guest_links",
  "map",
  "open_notifications",
  "settings",
  "sense_lines",
  "nfc_tags",
  "access_code_mode",
] as const);

/**
 * Everything an **account-scoped** key can do: `open`, and nothing else.
 *
 * Account keys act on your own keys and latches (`client.account.*`); the
 * community surface is refused with `not_community_key` (403). Branch on this
 * rather than hand-typing the string:
 *
 * ```ts
 * const me = await client.me();
 * const scope = me.key.type; // "account" | "community"
 * ```
 */
export const ACCOUNT_KEY_CAPABILITIES = Object.freeze(["open"] as const);

/**
 * A key capability. Any string is accepted — the known names autocomplete, but
 * a capability this client predates is still a valid value.
 */
export type Capability =
  | (typeof CAPABILITIES)[number]
  // Widens to `string` while keeping the literals in autocomplete.
  | (string & Record<never, never>);

/**
 * Every event type a webhook or the live stream can deliver.
 *
 * This is one vocabulary, not two: the same catalog is what a **webhook
 * subscription** accepts (`community.createWebhook(url, events)`) and what the
 * live SSE stream filters on (`community.streamEvents({ events })`).
 *
 * **`community.webhookEventTypes()` is the authoritative source at runtime** —
 * it asks the server what it currently supports. This constant is a
 * convenience snapshot of what this release knew about, for autocomplete and
 * to keep a typo from becoming a silent no-op; it can lag a newer server, and
 * an event type missing from it is still perfectly valid.
 */
export const STREAM_EVENT_TYPES = Object.freeze([
  "sense_line.changed",
  "open.succeeded",
  "open.failed",
  "device.online",
  "device.offline",
  "hold_open.changed",
  "member.requested",
  "member.approved",
  "member.removed",
  "directory.call",
] as const);

/**
 * A webhook / stream event type. Any string is accepted — the known names
 * autocomplete, but an event type this client predates is still valid.
 */
export type StreamEventType =
  | (typeof STREAM_EVENT_TYPES)[number]
  | (string & Record<never, never>);

/**
 * Does this key carry `capability`?
 *
 * Pass either the key info from `me()` or a bare capability list.
 *
 * ```ts
 * const me = await client.me();
 * if (!hasCapability(me.key, "hold_opens")) {
 *   throw new Error("This key cannot manage hold opens");
 * }
 * ```
 *
 * An unrecognized capability name is simply absent, never an error — the list
 * is open-ended by design.
 */
export function hasCapability(
  key: { capabilities: readonly string[] } | readonly string[],
  capability: Capability,
): boolean {
  const list = Array.isArray(key)
    ? (key as readonly string[])
    : (key as { capabilities: readonly string[] }).capabilities;
  return list.includes(capability);
}

/**
 * The two kinds of guest link, as `community.createGuestLink()` accepts them.
 *
 * Unlike the vocabularies above this one is **closed**: the API validates
 * `link_type` against exactly these two and rejects anything else with a 422,
 * and the two take different required fields — an `event` link needs `title`,
 * `windowStart` and `windowEnd`, a `limited_use` link needs `maxUses`. Typing
 * it closed is what lets the compiler catch the mix-up.
 */
export const GUEST_LINK_TYPES = Object.freeze(["event", "limited_use"] as const);

/** `"event"` or `"limited_use"`. */
export type GuestLinkType = (typeof GUEST_LINK_TYPES)[number];

/**
 * Every state a guest link can report.
 *
 * Server-**computed**, not stored: the same link reads `upcoming` before its
 * window and `active` inside it, with no write in between. `feature_disabled`
 * means the community switched the link type off underneath a link that is
 * otherwise fine — turning it back on revives the link.
 *
 * Open vocabulary: a state this client predates is still a valid value, so the
 * type below accepts any string while autocompleting the known ones.
 */
export const GUEST_LINK_STATES = Object.freeze([
  "active",
  "upcoming",
  "expired",
  "spent",
  "revoked",
  "feature_disabled",
] as const);

/**
 * A guest-link state. Any string is accepted — the known names autocomplete,
 * but a state this client predates is still valid.
 */
export type GuestLinkState =
  | (typeof GUEST_LINK_STATES)[number]
  | (string & Record<never, never>);

/**
 * The two geofence modes a gate can advertise.
 *
 * Closed, like {@link GUEST_LINK_TYPES}: the API validates `mode` against
 * exactly these two and rejects anything else, so typing it closed lets the
 * compiler catch a typo that would otherwise be a 422 at runtime.
 *
 * - `"prompt"` — the app notifies the member on arrival and they tap to open.
 * - `"auto_open"` — the app opens the gate on arrival.
 *
 * `community.map()` echoes the server's own list as `geofenceModes`; this is
 * the compile-time copy of it.
 */
export const GEOFENCE_MODES = Object.freeze(["prompt", "auto_open"] as const);

/** `"prompt"` or `"auto_open"`. */
export type GeofenceMode = (typeof GEOFENCE_MODES)[number];

/**
 * The two access-code systems a community can run, as
 * `community.setAccessCodeMode()` accepts them.
 *
 * Closed, like {@link GEOFENCE_MODES}: the API validates `mode` against
 * exactly these two and rejects anything else with 422 `invalid_mode`.
 *
 * - `"per_member"` — the default. A visitor picks the member they are visiting
 *   in the GuestView directory and types that member's code. Codes are unique
 *   per member, so two members may hold the same digits.
 * - `"single_entry"` — one "Enter access code" field for the whole community.
 *   Every member carries a 3-letter **preamble** (A–Z, derived from their
 *   name, unique within the community) and the visitor types preamble
 *   followed by code, e.g. `ESM481502`.
 *
 * **Switching between them deletes every access code in the community** —
 * see `community.setAccessCodeMode()` for the confirmation handshake.
 */
export const ACCESS_CODE_MODES = Object.freeze([
  "per_member",
  "single_entry",
] as const);

/** `"per_member"` or `"single_entry"`. */
export type AccessCodeMode = (typeof ACCESS_CODE_MODES)[number];

/**
 * The four configuration audit trails `community.changeLogs()` can read.
 *
 * Closed: `type` is required and validated against exactly these four.
 *
 * | value | covers |
 * |---|---|
 * | `hold_open` | Hold opens: manual on/off, one-time events, recurring schedules, disable-until dates |
 * | `key_schedule` | Key access schedules (time-of-day / day-of-week restrictions) |
 * | `guest_view` | GuestView / Directory settings, short codes, directory access codes, GuestView Entry windows |
 * | `guest_link` | Guest links: creation, revocation, and the community-level link settings |
 *
 * This is the *change* trail. Who **opened** a gate is `community.accessLog()`;
 * what a gate physically **did** is `community.gateStatusLog()`.
 */
export const CHANGE_LOG_TYPES = Object.freeze([
  "hold_open",
  "key_schedule",
  "guest_view",
  "guest_link",
] as const);

/** One of the four configuration audit trails. */
export type ChangeLogType = (typeof CHANGE_LOG_TYPES)[number];

/**
 * The two attribution rules `community.keyUsage()` can report.
 *
 * **Server-computed, never sent by you.** Nimbio picks the rule from the
 * community's property type — there is deliberately no parameter for it,
 * because getting it wrong would misreport who opened a gate — so this is a
 * vocabulary for reading `reportType`, not for writing.
 *
 * - `"commercial"` — a row's `user` is the **actual opener's** name.
 * - `"residential"` — `user` is `"<master key owner> Keychain"`: every open on
 *   a household's keys is attributed to the account holder. That groups; it
 *   does not anonymize.
 *
 * Open vocabulary, like {@link GUEST_LINK_STATES}: a rule this client predates
 * is still a valid value, so branch on the known two and treat anything else as
 * "attribution I do not recognize" rather than rejecting it.
 */
export const KEY_USAGE_REPORT_TYPES = Object.freeze([
  "commercial",
  "residential",
] as const);

/**
 * A key-usage attribution rule. Any string is accepted — the known names
 * autocomplete, but a rule this client predates is still valid.
 */
export type KeyUsageReportType =
  | (typeof KEY_USAGE_REPORT_TYPES)[number]
  | (string & Record<never, never>);
