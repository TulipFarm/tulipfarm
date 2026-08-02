import { hostname } from "node:os";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";

/**
 * Lowest `schema_version` this worker will run against. The API owns migrations and applies them
 * on boot; the worker only reads. Anything below this floor means the tables it claims from may
 * not exist or may not have the columns it writes, so it refuses to start rather than corrupt.
 * Raise it whenever a migration lands that the worker's queries depend on.
 */
export const REQUIRED_SCHEMA_VERSION = 17;

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly businessId: string;
  /**
   * Where the API's internal turn host answers, without a trailing slash.
   *
   * Required rather than optional: a worker that cannot reach it can claim a Chat Run and then
   * discover it has no way to resolve the Context, which costs the participant a turn to learn
   * something the deployment already knew. Refusing to start says it once, at boot.
   */
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

/**
 * Trims trailing slashes so `http://api:8080/` and `http://api:8080` build the same request path.
 *
 * A scan, not `replace(/\/+$/, "")`: the regex backtracks on a long run of slashes, and this value
 * comes from the environment, which a deployment tool composes rather than a person types.
 */
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

/**
 * Reads and validates the worker's configuration. Called before any connection is opened, so a
 * misconfigured deployment fails at once with a named cause instead of half-starting and then
 * silently claiming nothing.
 */
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
    drainTimeoutMs: positiveInt(env, "WORKER_DRAIN_TIMEOUT_MS", 15_000),
    maintenance: booleanValue(env, "WORKER_MAINTENANCE", false),
  };
  if (config.owner.trim().length === 0) {
    throw new WorkerConfigError("WORKER_OWNER must not be blank");
  }
  // A lease that expires before the poll interval is reclaimed by this same worker mid-batch,
  // which reads as two workers fighting over one Run. Refuse the combination outright.
  if (config.leaseDurationMs <= config.runPollMs) {
    throw new WorkerConfigError(
      `WORKER_LEASE_MS (${config.leaseDurationMs}) must exceed WORKER_RUN_POLL_MS (${config.runPollMs})`
    );
  }
  return config;
}
