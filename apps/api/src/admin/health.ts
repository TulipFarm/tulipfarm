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

/**
 * Checks that a model is configured and resolvable. It deliberately does not call the provider —
 * a health page must not spend tokens or take a provider outage as its own failure.
 */
export function llmProbe(llm: ModelProbeTarget): HealthProbe {
  return {
    component: "llm",
    async check() {
      llm.effortModel("balanced");
      return { status: "ok" };
    },
  };
}
