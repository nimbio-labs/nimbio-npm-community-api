/**
 * Quickstart — TypeScript / ESM.
 *
 * Run against a local build with:
 *   NIMBIO_API_KEY=nimbio_test_... npx tsx examples/quickstart.ts
 *
 * or, once installed from npm:
 *   import { NimbioClient } from "@nimbio/community-api";
 */
import {
  NimbioClient,
  APIError,
  GateNotOpenedError,
  PermissionDeniedError,
  RateLimitError,
} from "../src/index.js";

async function main(): Promise<void> {
  // Mode (test vs live) is inferred from the key — no flag needed.
  const client = new NimbioClient(process.env.NIMBIO_API_KEY, {
    environment: "dev", // "prod" (default) | "dev" | "local"
  });

  // Guard against accidental live opens while iterating.
  if (client.mode !== "test") {
    console.warn(`Heads up: this is a ${client.mode} key — opens are REAL.`);
  }

  const me = await client.me();
  console.log("Account:", me.accountId, "| key:", me.key.name);

  const status = await client.community.gateStatus();
  for (const latch of status.latches) {
    console.log(`${latch.latchName} -> ${latch.status}${latch.offline ? " (offline)" : ""}`);
  }

  try {
    const result = await client.community.open("latch-id-123", { note: "front gate" });
    console.log("Open result:", result.result); // "simulated" | "opened"
  } catch (e) {
    if (e instanceof PermissionDeniedError) console.error("Denied:", e.code);
    else if (e instanceof GateNotOpenedError) console.error("Gate did not confirm in time");
    else if (e instanceof RateLimitError) console.error("Rate limited; retry after", e.retryAfter);
    else if (e instanceof APIError) console.error(e.status, e.code, e.message, e.requestId);
    else throw e;
  }

  // Auto-paginate the full community access log.
  let count = 0;
  for await (const _row of client.community.iterAccessLog()) count += 1;
  console.log("Access-log rows:", count);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
