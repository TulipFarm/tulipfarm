/**
 * Staleness detection and convergence (SPEC §14.1).
 *
 * `acl.ts` already *denies* a source whose cached ACL is older than its explicit TTL. That is the
 * safe half of the story and, on its own, a trap: a source nobody re-syncs stays denied forever and
 * looks like a permissions bug. This module is the other half — it finds sources past their TTL and
 * enqueues durable revalidation, so staleness converges back to a decision instead of sitting.
 *
 * A snapshot source with no captured ACL at all counts as stale, never as fresh.
 */

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

/**
 * How old this source's authorization evidence is, against the TTL the source itself declares.
 * A snapshot source is measured from when its ACL was captured; a live source holds no cached ACL,
 * so it is measured from its last confirmed sync.
 */
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

/**
 * Sources whose authorization evidence is past its TTL. Revoked and deleted sources are skipped —
 * they are already unreachable, and revalidating them would only churn the queue.
 */
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

/**
 * Enqueue revalidation for every stale source that does not already have one outstanding, and
 * return how many were enqueued. Skipping sources with a pending job keeps a periodic sweep
 * idempotent rather than compounding a backlog.
 */
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
