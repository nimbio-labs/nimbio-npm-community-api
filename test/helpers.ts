/**
 * Test helpers: a fully in-memory `fetch` double so the suite never touches the
 * network. Mirrors the role `respx` plays in the Python client's tests.
 */

import type { FetchLike } from "../src/base.js";

export const TEST_KEY = "nimbio_test_abcdefghijklmnopqrstuv";
export const LIVE_KEY = "nimbio_live_abcdefghijklmnopqrstuv";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponseSpec {
  status?: number;
  /** Object -> JSON body; string -> sent verbatim; null/undefined -> empty. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockFetch {
  fetchImpl: FetchLike;
  calls: CapturedRequest[];
}

/**
 * Build a `fetch` double. Pass a single response (repeated for every call) or
 * an array consumed in order (the last entry repeats once exhausted).
 */
export function mockFetch(responses: MockResponseSpec | MockResponseSpec[]): MockFetch {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: CapturedRequest[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the raw string */
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });

    const spec = queue.length > 1 ? queue.shift()! : queue[0]!;
    const status = spec.status ?? 200;
    const payload =
      spec.body == null || typeof spec.body === "string"
        ? (spec.body as string | null | undefined) ?? null
        : JSON.stringify(spec.body);
    return new Response(payload, { status, headers: spec.headers });
  };

  return { fetchImpl, calls };
}

/** A `fetch` that never resolves until its AbortSignal fires (timeout tests). */
export function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      }
    });
}

/** A `fetch` that always rejects, simulating a DNS/TCP/TLS failure. */
export function failingFetch(error: Error = new TypeError("fetch failed")): FetchLike {
  return () => Promise.reject(error);
}
