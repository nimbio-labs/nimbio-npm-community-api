/**
 * Error hierarchy for the Nimbio community API client.
 *
 * Every non-2xx response from the API carries a uniform error envelope:
 *
 * ```json
 * { "error": { "code": "...", "message": "...", "request_id": "..." } }
 * ```
 *
 * These errors surface that envelope as typed JavaScript errors. Catch the base
 * {@link NimbioError} to handle everything, {@link APIError} for any HTTP-level
 * error, or a specific subclass (e.g. {@link RateLimitError}) for fine control.
 */

/** Base class for every error thrown by this library. */
export class NimbioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain for reliable `instanceof` across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown for client misconfiguration (e.g. a missing API key). */
export class NimbioConfigError extends NimbioError {}

/** The request never produced an HTTP response (DNS, TCP, TLS failure). */
export class APIConnectionError extends NimbioError {
  constructor(message = "Could not reach the Nimbio API", options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** The request timed out before a response was received. */
export class APITimeoutError extends APIConnectionError {
  constructor(
    message = "The request to the Nimbio API timed out",
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Fields carried by an {@link APIError}. */
export interface APIErrorFields {
  status: number;
  code?: string | null;
  requestId?: string | null;
  response?: unknown;
  headers?: Record<string, string>;
}

/**
 * An HTTP error response (status >= 400) with the parsed error envelope.
 *
 * - `status`     — HTTP status code.
 * - `code`       — machine-readable `error.code` from the envelope.
 * - `message`    — human-readable `error.message`.
 * - `requestId`  — server-assigned id; quote it in support requests.
 * - `response`   — the raw decoded JSON body (may be `undefined`).
 * - `headers`    — response headers (e.g. for `Retry-After`/rate-limit info).
 */
export class APIError extends NimbioError {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly response: unknown;
  readonly headers: Record<string, string>;

  constructor(message: string, fields: APIErrorFields) {
    super(message);
    this.status = fields.status;
    this.code = fields.code ?? null;
    this.requestId = fields.requestId ?? null;
    this.response = fields.response;
    this.headers = fields.headers ?? {};
  }

  override toString(): string {
    const bits: string[] = [`[${this.status}]`];
    if (this.code) bits.push(`${this.code}:`);
    bits.push(this.message);
    if (this.requestId) bits.push(`(request_id=${this.requestId})`);
    return `${this.name}: ${bits.join(" ")}`;
  }
}

/** 400 — the request was malformed or missing required fields. */
export class BadRequestError extends APIError {}

/** 401 — the API key is missing, malformed, or revoked. */
export class AuthenticationError extends APIError {}

/** 403 — authenticated, but not allowed (wrong scope, denied open, etc.). */
export class PermissionDeniedError extends APIError {}

/** 404 — the addressed resource does not exist. */
export class NotFoundError extends APIError {}

/**
 * 429 — per-minute or monthly quota exceeded.
 *
 * `retryAfter` is the number of seconds the server asked you to wait (from the
 * `Retry-After` header), when present.
 */
export class RateLimitError extends APIError {
  readonly retryAfter: number | null;

  constructor(message: string, fields: APIErrorFields & { retryAfter?: number | null }) {
    super(message, fields);
    this.retryAfter = fields.retryAfter ?? null;
  }
}

/** 504 — the gate did not confirm the open within the backend's window. */
export class GateNotOpenedError extends APIError {}

/** 502/503 — the backend (kindlyWAMP) was unavailable or failed. */
export class UpstreamError extends APIError {}

/** Any other 5xx response. */
export class ServerError extends APIError {}

/**
 * Return the most specific {@link APIError} subclass for a given HTTP status
 * and machine error code.
 */
export function exceptionFor(
  status: number,
  code?: string | null,
): typeof APIError {
  if (code === "did_not_open" || status === 504) return GateNotOpenedError;
  if (status === 400) return BadRequestError;
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404) return NotFoundError;
  if (status === 429) return RateLimitError;
  if (status === 502 || status === 503) return UpstreamError;
  if (status >= 500) return ServerError;
  return APIError;
}
