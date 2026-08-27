/**
 * Conditional-request (ETag / `If-None-Match`) support.
 *
 * The Nimbio API is built for polling — a Home Assistant integration, a
 * dashboard or a status display all sit in a loop asking "what is the gate
 * doing now?" — so most of its GETs answer **304 Not Modified** when you send
 * back the `ETag` they last gave you. A 304 costs no body on the wire, no
 * parse here, and **refunds the caller's monthly quota**: the API declines to
 * charge for data it did not send.
 *
 * This module is the store behind that. It is deliberately small and
 * deliberately dumb:
 *
 * - **Opportunistic, never a hardcoded route list.** Any GET whose response
 *   carries an `ETag` gets remembered; the next identical GET revalidates.
 *   Nothing here knows *which* routes are cacheable, so nothing here can go
 *   stale when the API adds or drops one.
 * - **Always revalidate.** `Cache-Control: max-age` is ignored on purpose. A
 *   stored entry supplies a body only when the server itself answers 304, so
 *   the cache can never serve stale data and no write-invalidation logic is
 *   needed — a POST/PATCH/DELETE cannot strand a stale entry, because the next
 *   read asks the server anyway.
 * - **Bounded.** LRU, {@link DEFAULT_CACHE_SIZE} entries by default. An
 *   unbounded cache on a long-lived polling client is a slow memory leak.
 *
 * Concurrency: every method here mutates the map synchronously, with no `await`
 * in between, so on JavaScript's single-threaded event loop each operation is
 * atomic and no lock is needed. Two concurrent GETs for the same key simply
 * both revalidate and the later store wins — correct, just not deduplicated.
 */

import { STREAM_PATH } from "./sse.js";

/** Default LRU bound: entries kept before the least-recently-used is dropped. */
export const DEFAULT_CACHE_SIZE = 256;

/**
 * A snapshot of what the ETag cache has done on this client.
 *
 * The only way to confirm the quota saving is actually happening. `hits` counts
 * responses the server answered 304 (quota refunded, nothing re-downloaded),
 * `misses` counts cacheable GETs that came back with a full body, and `entries`
 * is how many ETags are currently stored.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
}

interface CacheEntry {
  etag: string;
  /**
   * The response body as **text**, not as a parsed object.
   *
   * Storing text is what makes a 304 indistinguishable from a 200: every hit
   * re-decodes and re-parses, so each caller gets its own fresh object graph.
   * Handing back a cached parsed model would let one caller mutating a result
   * (or its `.raw`) corrupt every later read.
   */
  bodyText: string;
}

/**
 * Whether a request may participate in conditional caching.
 *
 * GET only — a POST/PATCH/PUT/DELETE is never cached. The SSE event stream is
 * excluded by name as well: it is an unbounded response body that the API
 * explicitly leaves non-cacheable. It never reaches this path today (it does
 * not go through the normal request loop, and carries no ETag), but relying on
 * that indirectly is the sort of thing that quietly stops being true.
 */
export function isCacheable(method: string, path: string): boolean {
  return method.toUpperCase() === "GET" && path !== STREAM_PATH;
}

/**
 * The cache key: method + path + normalised query params.
 *
 * The API sends `Vary: Authorization` on every conditional route. That is
 * satisfied structurally rather than by hashing the key into the cache key: a
 * cache belongs to one client instance and a client holds exactly one API key,
 * so one cache can only ever hold one tenant's data. (A later reader will
 * wonder about this — that is the answer. If the client ever grows per-request
 * key overrides, the key must grow with it.)
 */
export function cacheKey(
  method: string,
  path: string,
  params: Record<string, string> | null,
): string {
  const head = `${method.toUpperCase()} ${path}`;
  if (!params) return head;
  const sorted = new URLSearchParams();
  for (const name of Object.keys(params).sort()) sorted.append(name, params[name]!);
  const query = sorted.toString();
  return query ? `${head}?${query}` : head;
}

/** A bounded, least-recently-used store of ETags and their response bodies. */
export class EtagCache {
  readonly maxEntries: number;
  // Insertion order is LRU order: a `get` re-inserts at the end, so the first
  // key a Map iterates is always the least recently used one.
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(maxEntries: number = DEFAULT_CACHE_SIZE) {
    this.maxEntries = Math.max(1, Math.trunc(maxEntries));
  }

  /** The stored ETag for `key`, or `null`. Does not count as a hit. */
  etagFor(key: string): string | null {
    return this.entries.get(key)?.etag ?? null;
  }

  /**
   * The stored body text for `key`, refreshing its LRU position, or `null` if
   * the entry has since been evicted. Counts a hit when it returns.
   */
  hit(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.bodyText;
  }

  /** Record that a cacheable GET came back with a full body. */
  miss(): void {
    this.misses += 1;
  }

  /** Remember an ETag and its body, evicting the oldest entries past the bound. */
  put(key: string, etag: string, bodyText: string): void {
    this.entries.delete(key);
    this.entries.set(key, { etag, bodyText });
    // Keys iterate least-recently-used first; deleting during iteration is
    // well-defined on a Map.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }

  /** Drop every stored entry. Counters are left alone. */
  clear(): void {
    this.entries.clear();
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size };
  }
}
