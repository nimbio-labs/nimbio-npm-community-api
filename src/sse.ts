/**
 * Server-Sent-Events plumbing for the live event stream.
 *
 * Only what the Nimbio stream emits is supported: `id` / `event` / `data`
 * fields, `:` comment lines (heartbeats), and blank-line dispatch. The parser
 * is incremental — feed it lines, it returns a frame when one completes.
 * Mirrors `_sse.py` in the Python client.
 */

import type { StreamEvent, StreamReset } from "./models.js";

export const STREAM_PATH = "/v1/events/stream";

/** The server heartbeats every ~25s; three missed beats = dead connection. */
export const STREAM_READ_TIMEOUT_SECONDS = 90;
export const RECONNECT_BACKOFF_BASE = 0.5; // seconds; doubles per failure
export const RECONNECT_BACKOFF_MAX = 30;

export interface SSEFrame {
  id: string | null;
  event: string | null;
  data: string;
}

export function streamParams(
  events?: readonly string[],
  lastEventId?: string | null,
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  if (events && events.length) params.events = events.join(",");
  if (lastEventId) params.last_event_id = lastEventId;
  return Object.keys(params).length ? params : undefined;
}

export function backoffDelay(attempt: number): number {
  return Math.min(RECONNECT_BACKOFF_MAX, RECONNECT_BACKOFF_BASE * 2 ** attempt);
}

/** Incremental SSE frame assembler. */
export class SSEParser {
  private id: string | null = null;
  private event: string | null = null;
  private dataLines: string[] = [];

  /**
   * Feed one line (without its trailing newline). Returns the completed frame
   * on a dispatching blank line, else null.
   */
  feed(line: string): SSEFrame | null {
    if (line === "") {
      if (this.id === null && this.event === null && this.dataLines.length === 0) {
        return null; // stray blank line (e.g. after a comment)
      }
      const frame: SSEFrame = {
        id: this.id,
        event: this.event,
        data: this.dataLines.join("\n"),
      };
      this.id = null;
      this.event = null;
      this.dataLines = [];
      return frame;
    }
    if (line.startsWith(":")) return null; // comment / heartbeat

    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? "" : line.slice(sep + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "id") this.id = value;
    else if (field === "event") this.event = value;
    else if (field === "data") this.dataLines.push(value);
    return null;
  }
}

/** Convert a parsed frame into a stream message, or null for unusable frames. */
export function frameToModel(frame: SSEFrame): StreamEvent | StreamReset | null {
  if (frame.event === "stream.reset") {
    let reason: string | null = null;
    try {
      const parsed: unknown = JSON.parse(frame.data || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const r = (parsed as Record<string, unknown>).reason;
        reason = typeof r === "string" ? r : null;
      }
    } catch {
      reason = null;
    }
    return { kind: "reset", reason };
  }
  if (!frame.id || !frame.event) return null;

  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(frame.data || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  const inner = data.data;
  const payload =
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : {};
  return { kind: "event", id: frame.id, type: frame.event, data, payload };
}
