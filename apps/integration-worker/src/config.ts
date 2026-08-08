/**
 * Lowest `schema_version` this process will run against. The API owns migrations and applies them
 * on boot; this process only reads. Set to the current migration floor since no query depends on a
 * specific table yet — raise it whenever a migration lands that a future query depends on.
 */
export const REQUIRED_SCHEMA_VERSION = 24;

export interface IntegrationWorkerConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly drainTimeoutMs: number;
  /**
   * Deliberate local copy of `packages/constants`' `DEPLOYMENT_BUSINESS_ID` default — this app is
   * not on that package's import allowlist (`docs/architecture/dependency-rules.md`), so the same
   * `BUSINESS_ID` env var and fallback are read here rather than shared in-process.
   */
  readonly businessId: string;
  /** Base URL of `apps/api`, without a trailing slash — e.g. `http://localhost:4010`. */
  readonly internalApiUrl: string;
  /** `tfc_<clientId>.<secret>` — a service API-client credential, mirroring `apps/worker`'s. */
  readonly internalApiCredential: string;
}

export class IntegrationWorkerConfigError extends Error {
  readonly name = "IntegrationWorkerConfigError";
}

type Env = Record<string, string | undefined>;

function requireString(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new IntegrationWorkerConfigError(`${key} is required`);
  }
  return value;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new IntegrationWorkerConfigError(`${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Reads and validates this process's configuration. Called before any connection is opened, so a
 * misconfigured deployment fails at once with a named cause instead of half-starting.
 */
export function loadConfig(env: Env = process.env): IntegrationWorkerConfig {
  return {
    databaseUrl: requireString(env, "DATABASE_URL"),
    port: positiveInt(env, "INTEGRATION_WORKER_PORT", 4030),
    drainTimeoutMs: positiveInt(env, "INTEGRATION_WORKER_DRAIN_TIMEOUT_MS", 15_000),
    businessId: env.BUSINESS_ID?.trim() || "tulipfarm-local",
    internalApiUrl: stripTrailingSlashes(requireString(env, "INTERNAL_API_URL")),
    internalApiCredential: requireString(env, "INTEGRATION_WORKER_API_CREDENTIAL"),
  };
}
