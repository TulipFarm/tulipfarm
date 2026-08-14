/** Minimum DB schema version this read-only worker will run against. */
export const REQUIRED_SCHEMA_VERSION = 24;

export interface IntegrationWorkerConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly drainTimeoutMs: number;
  /** Local copy of BUSINESS_ID default; apps cannot import packages/constants here. */
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

/** Validates config before opening connections, so startup fails before half-starting. */
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
