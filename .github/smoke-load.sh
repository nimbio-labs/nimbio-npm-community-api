#!/usr/bin/env bash
# The build must load, not merely exist: on Node versions the test runner no
# longer supports, this is the check that a syntax or module-resolution
# regression in dist/ would trip. No network — constructing a client is local.
set -euo pipefail

node --input-type=module -e '
  const { NimbioClient, AuthenticationError } = await import("./dist/index.js");
  const c = new NimbioClient("nimbio_test_smoke", { environment: "dev" });
  if (typeof c.me !== "function" || typeof AuthenticationError !== "function") throw new Error("ESM exports incomplete");
  console.log("ESM OK");
'
node -e '
  const { NimbioClient, AuthenticationError } = require("./dist/index.cjs");
  const c = new NimbioClient("nimbio_test_smoke", { environment: "dev" });
  if (typeof c.me !== "function" || typeof AuthenticationError !== "function") throw new Error("CJS exports incomplete");
  console.log("CJS OK");
'
