export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthResult {
  readonly status: HealthStatus;
  readonly detail?: string;
}

export interface HealthProbe {
  readonly component: string;
  check(): Promise<HealthResult>;
}

export interface ComponentHealth extends HealthResult {
  readonly component: string;
  readonly checkedAt: string;
}

/** A probe that neither answers nor fails inside this budget is reported as `down`. */
const PROBE_TIMEOUT_MS = 2_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runProbe(probe: HealthProbe, now: () => string): Promise<ComponentHealth> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      probe.check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS
        );
      }),
    ]);
    return { component: probe.component, checkedAt: now(), ...result };
  } catch (error) {
    return {
      component: probe.component,
      status: "down",
      detail: message(error),
      checkedAt: now(),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs probes concurrently; probe failures become `down` components, not route failures. */
export async function probeHealth(
  probes: readonly HealthProbe[],
  now: () => string = () => new Date().toISOString()
): Promise<ComponentHealth[]> {
  return Promise.all(probes.map((probe) => runProbe(probe, now)));
}

export interface QueryableProbeTarget {
  query(text: string): Promise<unknown>;
}

/** PostgreSQL is the correctness boundary: if this probe is down, nothing else is trustworthy. */
export function postgresProbe(database: QueryableProbeTarget): HealthProbe {
  return {
    component: "postgres",
    async check() {
      await database.query("SELECT 1");
      return { status: "ok" };
    },
  };
}

export interface QueueProbeTarget {
  getQueues(): Promise<unknown>;
}

export function queueProbe(queue: QueueProbeTarget): HealthProbe {
  return {
    component: "queue",
    async check() {
      await queue.getQueues();
      return { status: "ok" };
    },
  };
}

export interface SoulProbeTarget {
  getStatus(): Promise<{
    remoteConfigured: boolean;
    ahead: number;
    behind: number;
    lastSyncError: string | null;
    lastSyncAt: string | null;
  }>;
}

/**
 * A soul repo with no remote is a supported local-only deployment, not a fault. A failed sync is
 * `degraded`: authored artifacts still load, but the deployment is diverging from its remote.
 */
export function soulProbe(soul: SoulProbeTarget): HealthProbe {
  return {
    component: "soul",
    async check() {
      const status = await soul.getStatus();
      if (status.lastSyncError) {
        return { status: "degraded", detail: status.lastSyncError };
      }
      if (!status.remoteConfigured) {
        return { status: "ok", detail: "no remote configured (local-only soul)" };
      }
      return {
        status: status.behind > 0 ? "degraded" : "ok",
        detail: `ahead ${status.ahead}, behind ${status.behind}`,
      };
    },
  };
}

export interface ModelProbeTarget {
  effortModel(preset: "balanced"): unknown;
}

/** Whether the configured credential is still accepted. Absent means "not checked". */
export interface ModelReachability {
  /** Rejects only when the provider refused the *credential*; transient faults resolve. */
  verify(): Promise<void>;
}

export interface LlmProbeOptions {
  /**
   * Optional live credential check. Without it the probe reports configuration only, which
   * cannot distinguish a working key from a revoked one.
   */
  readonly reachability?: ModelReachability;
  /** Reachability is cached this long so scraping the health page cannot spend tokens per hit. */
  readonly ttlMs?: number;
  now?(): number;
}

const REACHABILITY_TTL_MS = 60_000;

/**
 * Checks that a model is configured and resolvable, and — when a reachability check is supplied —
 * that the provider still accepts the credential.
 *
 * A provider outage is deliberately *not* our failure: only a refused credential downgrades the
 * component, and only to `degraded`. Reporting `down` would hand a third party the power to fail
 * this deployment's readiness. Without that distinction a revoked key reported `ok` and the first
 * person to learn of it was a participant mid-chat.
 */
export function llmProbe(llm: ModelProbeTarget, options: LlmProbeOptions = {}): HealthProbe {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? REACHABILITY_TTL_MS;
  let cached: { at: number; result: HealthResult } | undefined;

  return {
    component: "llm",
    async check() {
      llm.effortModel("balanced");
      const reachability = options.reachability;
      if (reachability === undefined) return { status: "ok" };

      if (cached !== undefined && now() - cached.at < ttlMs) return cached.result;

      let result: HealthResult;
      try {
        await reachability.verify();
        result = { status: "ok" };
      } catch (error) {
        result = {
          status: "degraded",
          detail: `provider rejected the credential: ${message(error)}`,
        };
      }
      cached = { at: now(), result };
      return result;
    },
  };
}
