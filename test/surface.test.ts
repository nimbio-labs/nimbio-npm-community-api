/**
 * Machine-readable HTTP surface.
 *
 * `surface.json` at the repo root is a checked-in, generated description of
 * every endpoint this SDK can issue — the shape a cross-repo parity checker
 * diffs against the public API's OpenAPI spec (and against the Python SDK's
 * identical file). It is derived by introspecting the `endpoints` registry in
 * `src/base.ts`, which is the single source of truth for the wire contract.
 *
 * This lives in the test suite on purpose: importing `src/base.ts` from a
 * standalone script would mean adding a TypeScript runner (tsx/ts-node) as a
 * dependency, and the package deliberately carries none. Vitest already runs
 * TypeScript in Node, so the generator rides along with the staleness guard.
 *
 * Regenerate after changing the registry:
 *
 *   npm run surface        # == UPDATE_SURFACE=1 vitest run test/surface.test.ts
 *
 * `node:fs` is imported here and nowhere under `src/`, so nothing filesystem-
 * shaped can leak into the browser/edge bundle in `dist/`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { endpoints } from "../src/base.js";
import type { EndpointSpec } from "../src/base.js";
import { STREAM_PATH } from "../src/sse.js";
import { VERSION } from "../src/version.js";

const SURFACE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "surface.json",
);

/** One endpoint as it appears in `surface.json`. */
interface SurfaceEndpoint {
  method: string;
  path: string;
  builder: string;
}

interface Surface {
  sdk: string;
  package: string;
  version: string;
  endpoints: SurfaceEndpoint[];
}

type Builder = (...args: any[]) => EndpointSpec<unknown>;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function popcount(n: number): number {
  let count = 0;
  for (let bits = n; bits !== 0; bits >>= 1) count += bits & 1;
  return count;
}

/**
 * Argument sets to try, cheapest first.
 *
 * A builder's leading required parameters (`fn.length` — anything with a
 * default or a rest is excluded) are filled with positional sentinels:
 * `"{p0}"`, `"{p1}"`, … JavaScript does not expose parameter *names* at
 * runtime, so positional placeholders are the honest thing to emit; the
 * cross-repo checker normalises `{...}` before comparing.
 *
 * Some builders take a collection (a list of key ids, schedule windows) and
 * throw when handed a string. Rather than naming those, retry with `[]`
 * substituted for a growing set of parameters until one call succeeds. Sets
 * are ordered by size ascending — so the fewest substitutions win — and, at
 * equal size, later parameters are substituted first, since path parameters
 * lead and body collections trail. Body values never reach the path, so a
 * substituted argument cannot change what we record.
 */
function* argumentSets(arity: number): Generator<unknown[]> {
  const masks = [...Array(1 << arity).keys()].sort(
    (a, b) => popcount(a) - popcount(b) || b - a,
  );
  for (const mask of masks) {
    yield Array.from({ length: arity }, (_, i) =>
      (mask >> i) & 1 ? [] : `{p${i}}`,
    );
  }
}

/** Call one builder with sentinels, escalating substitutions until it works. */
function describeEndpoint(name: string, fn: Builder): SurfaceEndpoint {
  const failures: string[] = [];
  for (const args of argumentSets(fn.length)) {
    let spec: EndpointSpec<unknown>;
    try {
      spec = fn(...args);
    } catch (e) {
      failures.push(`${JSON.stringify(args)} -> ${(e as Error).message}`);
      continue;
    }
    return {
      method: spec.method.toUpperCase(),
      // The registry percent-encodes interpolated values, which would mangle
      // the sentinels into %7Bp0%7D.
      path: decodeURIComponent(spec.path),
      builder: name,
    };
  }
  // Never drop an endpoint silently — a surface missing a route reads as
  // parity with an API that no longer has it.
  throw new Error(
    `Could not introspect endpoint builder "${name}" (arity ${fn.length}). ` +
      `Attempts:\n  ${failures.join("\n  ")}`,
  );
}

/** Build the whole surface from the registry, plus the SSE stream. */
export function buildSurface(): Surface {
  const built = Object.entries(endpoints).map(([name, fn]) =>
    describeEndpoint(name, fn as unknown as Builder),
  );

  // The SSE event stream is a real, documented operation this SDK issues
  // (`community.streamEvents`), but it never goes through the `endpoints`
  // registry: streaming needs a long-lived response body rather than the
  // decode-and-parse round trip an EndpointSpec describes, so it lives in
  // `src/sse.ts` instead. Registry-only introspection would therefore drop it
  // and leave the parity checker with a phantom one-endpoint gap that no
  // amount of work could close. This is not a stray entry — do not delete it.
  // The path is imported, never retyped, so moving STREAM_PATH moves this too.
  built.push({ method: "GET", path: STREAM_PATH, builder: "stream" });

  // Plain code-point ordering, not localeCompare: it must not depend on the
  // host's ICU data, and it has to agree with the Python sibling's `sorted()`.
  built.sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method));
  return {
    sdk: "npm",
    package: "@nimbio/community-api",
    version: VERSION,
    endpoints: built,
  };
}

function renderSurface(): string {
  return `${JSON.stringify(buildSurface(), null, 2)}\n`;
}

describe("surface.json", () => {
  it("matches the endpoints registry in src/base.ts", () => {
    const generated = renderSurface();
    if (process.env.UPDATE_SURFACE === "1") {
      writeFileSync(SURFACE_PATH, generated, "utf8");
      return;
    }
    expect(readFileSync(SURFACE_PATH, "utf8")).toBe(generated);
  });

  it("describes every builder in the registry exactly once, plus the stream", () => {
    const surface = buildSurface();
    const names = surface.endpoints.map((e) => e.builder);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...Object.keys(endpoints), "stream"].sort());
  });

  it("takes the stream path from src/sse.ts rather than a literal", () => {
    const stream = buildSurface().endpoints.find((e) => e.builder === "stream");
    expect(stream).toEqual({ method: "GET", path: STREAM_PATH, builder: "stream" });
  });
});
