import { hostname } from "node:os";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";

/**
 * Refuse to boot below the schema floor the worker's work requires.
 *
 * 86, not 81: the hosted `file_create` Tool now writes Chat drafts and generation idempotency
 * fields added by migration 86. A worker below that floor could claim a Run and fail mid-Tool.
 */
export const REQUIRED_SCHEMA_VERSION = 90;

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly businessId: string;
  /** API internal turn host, no trailing slash; required before any Run can be claimed. */
  readonly internalApiUrl: string;
  /** `tfc_<clientId>.<secret>` for a service API client. Names a Run, never a principal. */
  readonly internalApiCredential: string;
  /** Lease owner recorded on every Run this process claims; must be unique per process. */
  readonly owner: string;
  readonly port: number;
  readonly runPollMs: number;
  readonly waitSweepMs: number;
  readonly outboxPollMs: number;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
  /** Must exceed the lease; caps hung executors while healthy turns can renew. */
  readonly runMaxLifetimeMs: number;
  readonly drainTimeoutMs: number;
  /** Only one replica enables scheduled maintenance consumers. */
  readonly maintenance: boolean;
}

export class WorkerConfigError extends Error {
  readonly name = "WorkerConfigError";
}

type Env = Record<string, string | undefined>;

function requireString(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new WorkerConfigError(`${key} is required`);
  }
  return value;
}

/** Scan instead of regex: env-provided slash runs must not trigger backtracking. */
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
    throw new WorkerConfigError(`${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function booleanValue(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new WorkerConfigError(`${key} must be "true" or "false", got "${raw}"`);
}

/** Validate before opening connections, so misconfigured workers never claim Runs. */
export function loadConfig(env: Env = process.env): WorkerConfig {
  const config: WorkerConfig = {
    databaseUrl: requireString(env, "DATABASE_URL"),
    businessId: DEPLOYMENT_BUSINESS_ID,
    internalApiUrl: stripTrailingSlashes(requireString(env, "INTERNAL_API_URL")),
    internalApiCredential: requireString(env, "WORKER_API_CREDENTIAL"),
    owner: env.WORKER_OWNER ?? `${hostname()}:${process.pid}`,
    port: positiveInt(env, "WORKER_PORT", 4020),
    runPollMs: positiveInt(env, "WORKER_RUN_POLL_MS", 1_000),
    waitSweepMs: positiveInt(env, "WORKER_WAIT_SWEEP_MS", 5_000),
    outboxPollMs: positiveInt(env, "WORKER_OUTBOX_POLL_MS", 1_000),
    batchSize: positiveInt(env, "WORKER_BATCH_SIZE", 25),
    leaseDurationMs: positiveInt(env, "WORKER_LEASE_MS", 60_000),
    runMaxLifetimeMs: positiveInt(env, "WORKER_RUN_MAX_LIFETIME_MS", 900_000),
    drainTimeoutMs: positiveInt(env, "WORKER_DRAIN_TIMEOUT_MS", 15_000),
    maintenance: booleanValue(env, "WORKER_MAINTENANCE", false),
  };
  if (config.owner.trim().length === 0) {
    throw new WorkerConfigError("WORKER_OWNER must not be blank");
  }
  // The lease must outlive the poll interval or this worker can reclaim its own batch.
  if (config.leaseDurationMs <= config.runPollMs) {
    throw new WorkerConfigError(
      `WORKER_LEASE_MS (${config.leaseDurationMs}) must exceed WORKER_RUN_POLL_MS (${config.runPollMs})`
    );
  }
  // The lifetime cap must leave room for at least one healthy lease renewal.
  if (config.runMaxLifetimeMs <= config.leaseDurationMs) {
    throw new WorkerConfigError(
      `WORKER_RUN_MAX_LIFETIME_MS (${config.runMaxLifetimeMs}) must exceed WORKER_LEASE_MS (${config.leaseDurationMs})`
    );
  }
  return config;
}
