/**
 * Environment -> base URL mapping for the Nimbio public API.
 *
 * The Nimbio public API is deployed at two hosts:
 *
 * - `prod`  -> https://api.nimbio.com   (live production system)
 * - `dev`   -> https://api.nimbio.dev   (staging / development system)
 *
 * A third convenience target, `local`, points at a service running on the
 * developer's machine (the FastAPI app on port 8000).
 *
 * Whether a call runs in *test* or *live* mode is **not** an environment
 * choice: it is determined by the API key you authenticate with (a
 * `nimbio_test_*` key simulates side effects; a `nimbio_live_*` key performs
 * them). Both key types work against either environment.
 */

/** A canonical environment name accepted by the client. */
export type Environment = "prod" | "dev" | "local";

/** Canonical environment names mapped to their base URLs. */
export const ENVIRONMENTS: Readonly<Record<Environment, string>> = Object.freeze({
  prod: "https://api.nimbio.com",
  dev: "https://api.nimbio.dev",
  local: "http://localhost:8000",
});

/** The environment used when none is specified. */
export const DEFAULT_ENVIRONMENT: Environment = "prod";

/**
 * Resolve the effective base URL from an environment name or explicit URL.
 *
 * `baseUrl` always wins when provided. Otherwise `environment` is looked up in
 * {@link ENVIRONMENTS}. A trailing slash is stripped so callers can safely join
 * `"/v1/..."` paths.
 *
 * @throws {Error} if `environment` is not a known name (caught upstream and
 *   re-raised as `NimbioConfigError`).
 */
export function resolveBaseUrl(
  environment?: string | null,
  baseUrl?: string | null,
): string {
  if (baseUrl) {
    return baseUrl.replace(/\/+$/, "");
  }
  const env = (environment || DEFAULT_ENVIRONMENT).toLowerCase();
  if (env in ENVIRONMENTS) {
    return ENVIRONMENTS[env as Environment];
  }
  const valid = Object.keys(ENVIRONMENTS).sort().join(", ");
  throw new Error(
    `Unknown environment ${JSON.stringify(environment)}. ` +
      `Use one of: ${valid} — or pass baseUrl=... explicitly.`,
  );
}
