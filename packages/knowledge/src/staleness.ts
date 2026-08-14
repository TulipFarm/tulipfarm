/** Stale ACL evidence denies access and must enqueue revalidation; missing snapshot ACL is stale. */

import type { InvalidationDeps } from "./invalidate";
import { enqueueInvalidation } from "./invalidate";
import type { KnowledgeSourceRecord, KnowledgeSourceStore } from "./source";

export interface StalenessEvaluation {
  readonly stale: boolean;
  readonly ageSeconds: number;
}

function ageSeconds(from: string, now: Date): number {
  const parsed = Date.parse(from);
  // An unparseable timestamp cannot prove freshness, so it reads as maximally old.
  if (Number.isNaN(parsed)) return Number.MAX_SAFE_INTEGER;
  return Math.floor((now.getTime() - parsed) / 1000);
}

/** Measures auth-evidence age from snapshot ACL capture or last confirmed live sync. */
export function evaluateStaleness(source: KnowledgeSourceRecord, now: Date): StalenessEvaluation {
  const { accessControl } = source;
  if (accessControl.mode === "snapshot") {
    if (source.acl === undefined) {
      return { stale: true, ageSeconds: ageSeconds(source.lastSyncedAt, now) };
    }
    const age = ageSeconds(source.acl.capturedAt, now);
    return { stale: age > accessControl.maximumAgeSeconds, ageSeconds: age };
  }
  const age = ageSeconds(source.lastSyncedAt, now);
  return { stale: age > accessControl.maximumAgeSeconds, ageSeconds: age };
}

export interface StaleSource {
  readonly sourceId: string;
  readonly ageSeconds: number;
}

/** Finds sources past ACL TTL; revoked/deleted sources are already unreachable. */
export async function selectStaleSources(
  deps: { readonly sources: KnowledgeSourceStore },
  businessId: string,
  now: Date
): Promise<readonly StaleSource[]> {
  const stale: StaleSource[] = [];
  for (const source of await deps.sources.list(businessId)) {
    if (source.status !== "active") continue;
    const evaluation = evaluateStaleness(source, now);
    if (evaluation.stale)
      stale.push({ sourceId: source.sourceId, ageSeconds: evaluation.ageSeconds });
  }
  return stale;
}

export interface StaleRevalidationDeps extends Pick<InvalidationDeps, "queue" | "now" | "newId"> {
  readonly sources: KnowledgeSourceStore;
}

/** Enqueues one revalidation per stale source; pending jobs make sweeps idempotent. */
export async function enqueueStaleRevalidation(
  deps: StaleRevalidationDeps,
  businessId: string
): Promise<number> {
  const now = deps.now();
  let enqueued = 0;
  for (const stale of await selectStaleSources(deps, businessId, now)) {
    const existing = await deps.queue.listBySource(businessId, stale.sourceId);
    if (existing.some((job) => job.status === "pending" && job.trigger === "acl_stale")) continue;
    await enqueueInvalidation(deps, {
      businessId,
      sourceId: stale.sourceId,
      trigger: "acl_stale",
    });
    enqueued += 1;
  }
  return enqueued;
}
