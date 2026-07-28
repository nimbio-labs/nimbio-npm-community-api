/**
 * Verify Nimbio community-webhook deliveries.
 *
 * Nimbio signs every webhook POST with a Stripe-style HMAC so the receiver can
 * prove it came from Nimbio and is not a replay. The delivery request carries:
 *
 * - `X-Nimbio-Signature`:  `sha256=<hex HMAC-SHA256 over "{timestamp}.{body}">`
 * - `X-Nimbio-Timestamp`:  unix seconds when the delivery was signed
 * - `X-Nimbio-Event`:      the event type (e.g. `sense_line.changed`)
 * - `X-Nimbio-Delivery`:   unique id for this delivery attempt's event
 * - `X-Nimbio-Webhook-Id`: the webhook registration the delivery belongs to
 *
 * The signing secret is returned exactly once when the webhook is created (or
 * its secret rotated).
 *
 * Uses the Web Crypto API, so it works in Node 18+, browsers, Deno, Bun, and
 * edge runtimes — all functions are async.
 *
 * @example
 * ```ts
 * import { constructEvent } from "@nimbio/community-api";
 *
 * const event = await constructEvent(rawBody, {
 *   signature: req.headers["x-nimbio-signature"],
 *   timestamp: req.headers["x-nimbio-timestamp"],
 *   secret: storedSecret,
 * }); // throws WebhookSignatureError if the delivery isn't authentic
 * ```
 */

/**
 * Reject deliveries whose signing timestamp is further than this from now —
 * bounds the replay window without breaking on modest clock skew.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * The delivery could not be authenticated (bad signature, malformed header,
 * or a timestamp outside the replay tolerance).
 */
export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

const encoder = new TextEncoder();

function toBytes(body: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof body === "string") return encoder.encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string comparison (length leak only). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The expected `X-Nimbio-Signature` value for a payload:
 * `sha256=<hex HMAC-SHA256(secret, "{timestamp}." + body)>`.
 */
export async function computeSignature(
  secret: string,
  timestamp: string | number,
  body: Uint8Array | ArrayBuffer | string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = encoder.encode(`${timestamp}.`);
  const payload = toBytes(body);
  const signed = new Uint8Array(prefix.length + payload.length);
  signed.set(prefix);
  signed.set(payload, prefix.length);
  const digest = await crypto.subtle.sign("HMAC", key, signed);
  return `sha256=${toHex(digest)}`;
}

export interface VerifyOptions {
  /** The `X-Nimbio-Signature` header value. */
  signature: string | null | undefined;
  /** The `X-Nimbio-Timestamp` header value. */
  timestamp: string | number | null | undefined;
  /** The webhook's signing secret (from create / rotate-secret). */
  secret: string;
  /**
   * Replay tolerance in seconds (default {@link DEFAULT_TOLERANCE_SECONDS}).
   * Pass `null` to skip the timestamp check (e.g. re-verifying stored
   * deliveries).
   */
  toleranceSeconds?: number | null;
  /** Override "now" (unix seconds) — for tests. */
  now?: number;
}

/** True iff the signature authenticates the body at the given timestamp. */
export async function verifySignature(
  body: Uint8Array | ArrayBuffer | string,
  opts: VerifyOptions,
): Promise<boolean> {
  const { signature, timestamp, secret } = opts;
  if (!signature || timestamp == null || timestamp === "") return false;
  const expected = await computeSignature(secret, timestamp, body);
  if (!timingSafeEqual(expected, String(signature).trim())) return false;

  const tolerance =
    opts.toleranceSeconds === undefined
      ? DEFAULT_TOLERANCE_SECONDS
      : opts.toleranceSeconds;
  if (tolerance !== null) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const now = opts.now ?? Date.now() / 1000;
    if (Math.abs(now - ts) > tolerance) return false;
  }
  return true;
}

/** A decoded webhook delivery envelope. */
export interface WebhookEvent {
  /** Event type, e.g. `sense_line.changed` or `hold_open.changed`. */
  event: string;
  /** Unique event id. */
  id: string;
  communityId: number | null;
  /** ISO 8601 timestamp of when the event occurred. */
  occurredAt: string | null;
  /** Event-specific payload. */
  data: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/**
 * Verify a delivery and return the decoded event envelope. Throws
 * {@link WebhookSignatureError} when authentication fails and `SyntaxError` /
 * `TypeError` when the body is not a JSON object.
 */
export async function constructEvent(
  body: Uint8Array | ArrayBuffer | string,
  opts: VerifyOptions,
): Promise<WebhookEvent> {
  if (!(await verifySignature(body, opts))) {
    throw new WebhookSignatureError(
      "Webhook signature verification failed (wrong secret, altered payload, " +
        "or timestamp outside the replay tolerance)",
    );
  }
  const text =
    typeof body === "string" ? body : new TextDecoder().decode(toBytes(body));
  const decoded: unknown = JSON.parse(text);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Webhook body is not a JSON object");
  }
  const d = decoded as Record<string, unknown>;
  return {
    event: String(d.event ?? ""),
    id: String(d.id ?? ""),
    communityId: typeof d.community_id === "number" ? d.community_id : null,
    occurredAt: typeof d.occurred_at === "string" ? d.occurred_at : null,
    data:
      d.data !== null && typeof d.data === "object" && !Array.isArray(d.data)
        ? (d.data as Record<string, unknown>)
        : {},
    raw: d,
  };
}
