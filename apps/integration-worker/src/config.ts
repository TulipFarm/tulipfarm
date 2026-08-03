/**
 * Lowest `schema_version` this process will run against. The API owns migrations and applies them
 * on boot; this process only reads. Set to the current migration floor since no query depends on a
 * specific table yet — raise it whenever a migration lands that a future query depends on.
 */
export const REQUIRED_SCHEMA_VERSION = 22;

export interface IntegrationWorkerConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly drainTimeoutMs: number;
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
  };
}
