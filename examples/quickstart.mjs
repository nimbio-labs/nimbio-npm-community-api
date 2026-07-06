/**
 * Quickstart — plain JavaScript / ESM (no build step).
 *
 * After `npm install @nimbio/community-api`:
 *   NIMBIO_API_KEY=nimbio_test_... node examples/quickstart.mjs
 *
 * (This file imports from the published package name; adjust the import to
 *  "../dist/index.js" to run it against a local build.)
 */
import { NimbioClient, APIError } from "@nimbio/community-api";

const client = new NimbioClient(process.env.NIMBIO_API_KEY, { environment: "dev" });

console.log("mode:", client.mode); // "test" | "live" | null (no network)

const me = await client.me();
console.log("account:", me.accountId);

for (const latch of (await client.community.gateStatus()).latches) {
  console.log(latch.latchName, "->", latch.status);
}

try {
  const r = await client.community.open("latch-id-123");
  console.log("open:", r.result);
} catch (e) {
  if (e instanceof APIError) console.error(e.status, e.code, e.message);
  else throw e;
}
