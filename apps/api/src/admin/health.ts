import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { LlmNotConfiguredError } from "@tulipfarm/schema";

/**
 * `unknown` is not a fault: the component has nothing configured to check, so no verdict about it
 * would be honest. Reporting it as `down` tells an operator to fix something that is not broken.
 */
export type HealthStatus = "ok" | "degraded" | "down" | "unknown";

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

/** The verdict a live provider call proved. Absent means "not checked". */
export interface ModelReachability {
  /**
   * Resolves with the verdict for every outcome, including failure: a rejection would leave the
   * probe unable to say anything but that the check itself broke.
   */
  verify(): Promise<HealthResult>;
}

export interface LlmProbeOptions {
  /**
   * Optional live provider call. Without it the probe reports configuration only, which cannot
   * distinguish a reachable provider from a revoked key or a dead endpoint.
   */
  readonly reachability?: ModelReachability;
  /** Reachability is cached this long so scraping the health page cannot spend tokens per hit. */
  readonly ttlMs?: number;
  now?(): number;
}

const REACHABILITY_TTL_MS = 60_000;

/**
 * Checks that a model is configured and resolvable, and — when a reachability check is supplied —
 * what a live call to the configured provider proved.
 *
 * The live call runs *outside* this one: a real model call takes seconds, `runProbe` gives every
 * probe a two-second budget, and awaiting one here reported a working provider as `down` on
 * exactly the deployments whose first call is slowest. `check()` therefore answers from the last
 * verdict and refreshes in the background, so provider latency can never decide the status.
 *
 * The verdict itself is the reachability check's to make, and it distinguishes a provider that
 * answered — a refused credential, a throttle, a request it did not like — from one that never
 * answered at all. Swallowing the second class reported `ok` straight through an outage, which is
 * the more dangerous half of an untrustworthy health row: it is wrong silently.
 */
export function llmProbe(llm: ModelProbeTarget, options: LlmProbeOptions = {}): HealthProbe {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? REACHABILITY_TTL_MS;
  let cached: { at: number; result: HealthResult } | undefined;
  let refreshing = false;

  function refresh(reachability: ModelReachability): void {
    if (refreshing) return;
    refreshing = true;
    void reachability
      .verify()
      .then(
        (result) => {
          cached = { at: now(), result };
        },
        (error: unknown) => {
          cached = {
            at: now(),
            result: {
              status: "down",
              detail: `the provider check could not run: ${message(error)}`,
            },
          };
        }
      )
      .finally(() => {
        refreshing = false;
      });
  }

  return {
    component: "llm",
    async check() {
      try {
        llm.effortModel("balanced");
      } catch (error) {
        if (error instanceof LlmNotConfiguredError) {
          return {
            status: "unknown",
            detail: "no LLM provider is configured — connect one under Business → Models",
          };
        }
        throw error;
      }

      const reachability = options.reachability;
      if (reachability === undefined) return { status: "ok" };

      if (cached !== undefined && now() - cached.at < ttlMs) return cached.result;

      refresh(reachability);
      return cached?.result ?? { status: "ok", detail: "provider check pending" };
    },
  };
}

function numberFrom(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function dateMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface SoulPublicationProbeTarget {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: Row[] }>;
}

export function soulPublicationProbe(database: SoulPublicationProbeTarget): HealthProbe {
  return {
    component: "soul-publication",
    async check() {
      const result = await database.query(
        `
          WITH stats AS (
            SELECT
              COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_lettered_count,
              MAX(publication_sequence) AS newest_sequence
            FROM soul_publications
            WHERE business_id = $1
          ),
          newest AS (
            SELECT created_at, publication_sequence
            FROM soul_publications
            WHERE business_id = $1
            ORDER BY publication_sequence DESC
            LIMIT 1
          ),
          active_publication AS (
            SELECT p.created_at, p.publication_sequence
            FROM soul_active_bundles active
            JOIN soul_publications p
              ON p.business_id = active.business_id
             AND p.digest = active.digest
            WHERE active.business_id = $1
            ORDER BY p.publication_sequence DESC
            LIMIT 1
          )
          SELECT
            stats.dead_lettered_count,
            stats.newest_sequence,
            newest.created_at AS newest_created_at,
            newest.publication_sequence AS newest_publication_sequence,
            active_publication.created_at AS active_created_at,
            active_publication.publication_sequence AS active_publication_sequence
          FROM stats
          LEFT JOIN newest ON true
          LEFT JOIN active_publication ON true
        `,
        [DEPLOYMENT_BUSINESS_ID]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      const deadLetteredCount = numberFrom(row?.dead_lettered_count);
      const newestSequence = numberFrom(row?.newest_publication_sequence);
      const activeSequence = numberFrom(row?.active_publication_sequence);
      const newestCreatedMs = dateMs(row?.newest_created_at);
      const activeCreatedMs = dateMs(row?.active_created_at);
      const activeLagMs =
        newestCreatedMs !== undefined && activeCreatedMs !== undefined
          ? Math.max(0, newestCreatedMs - activeCreatedMs)
          : undefined;

      if (newestSequence === 0) {
        return { status: "degraded", detail: "no Soul publication has been recorded" };
      }
      if (activeSequence === 0) {
        return {
          status: "degraded",
          detail: `dead-lettered ${deadLetteredCount}, no active Soul bundle`,
        };
      }
      const detail = `dead-lettered ${deadLetteredCount}, active lag ${activeLagMs ?? 0}ms`;
      if (deadLetteredCount > 0 || activeSequence < newestSequence) {
        return { status: "degraded", detail };
      }
      return { status: "ok", detail };
    },
  };
}
