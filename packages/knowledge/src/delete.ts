/**
 * Source lifecycle propagation (SPEC §14.1).
 *
 * Deletion and revocation take effect in two independent places, and both are required:
 *
 * 1. **Immediately, at read time.** The status is written to the source record, and `acl.ts` denies
 *    a `deleted` or `revoked` source on the very next retrieval. Nothing waits for a job.
 * 2. **Eventually, in the derived stores.** An invalidation job removes the indexed text, vectors,
 *    cached answers, summaries, Contexts, and citations, and `invalidationStatus` makes that
 *    convergence observable.
 *
 * Doing only the second would leave a window where revoked content is still answerable; doing only
 * the first would leave protected text sitting in indexes and caches indefinitely.
 */

import type { InvalidationDeps, InvalidationJob } from "./invalidate";
import { enqueueInvalidation } from "./invalidate";
import type { KnowledgeAclSnapshot, MutableKnowledgeSourceStore } from "./source";

export interface SourceLifecycleDeps extends Pick<InvalidationDeps, "queue" | "now" | "newId"> {
  readonly sources: MutableKnowledgeSourceStore;
}

export interface SourceLifecycleRequest {
  readonly businessId: string;
  readonly sourceId: string;
}

export type SourceLifecycleResult =
  | { readonly outcome: "propagated"; readonly job: InvalidationJob }
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "not_found" };

/** Mark a source deleted and enqueue removal of everything derived from it. */
export async function deleteSource(
  deps: SourceLifecycleDeps,
  request: SourceLifecycleRequest
): Promise<SourceLifecycleResult> {
  const source = await deps.sources.get(request.businessId, request.sourceId);
  if (source === undefined) return { outcome: "not_found" };

  await deps.sources.put({ ...source, status: "deleted" });
  const job = await enqueueInvalidation(deps, {
    businessId: request.businessId,
    sourceId: request.sourceId,
    trigger: "source_deleted",
  });
  return { outcome: "propagated", job };
}

/**
 * Mark a source revoked. Revocation differs from deletion only in what happened upstream — the
 * content is equally unreachable and equally purged.
 */
export async function revokeSource(
  deps: SourceLifecycleDeps,
  request: SourceLifecycleRequest
): Promise<SourceLifecycleResult> {
  const source = await deps.sources.get(request.businessId, request.sourceId);
  if (source === undefined) return { outcome: "not_found" };

  await deps.sources.put({ ...source, status: "revoked" });
  const job = await enqueueInvalidation(deps, {
    businessId: request.businessId,
    sourceId: request.sourceId,
    trigger: "source_revoked",
  });
  return { outcome: "propagated", job };
}

export interface SourceSyncRequest extends SourceLifecycleRequest {
  readonly revision: string;
  readonly acl?: KnowledgeAclSnapshot;
  readonly lastSyncedAt?: string;
}

/**
 * Record what a sync observed. A new revision or a new ACL revision obsoletes derived artifacts, so
 * each enqueues invalidation; an unchanged sync enqueues nothing, which keeps a frequent poll from
 * flooding the queue with no-ops.
 */
export async function syncSourceRevision(
  deps: SourceLifecycleDeps,
  request: SourceSyncRequest
): Promise<SourceLifecycleResult> {
  const source = await deps.sources.get(request.businessId, request.sourceId);
  if (source === undefined) return { outcome: "not_found" };

  const revisionChanged = source.revision !== request.revision;
  const aclChanged =
    request.acl !== undefined && request.acl.aclRevision !== source.acl?.aclRevision;

  await deps.sources.put({
    ...source,
    revision: request.revision,
    ...(request.acl === undefined ? {} : { acl: request.acl }),
    ...(request.acl === undefined || source.accessControl.mode !== "snapshot"
      ? {}
      : {
          accessControl: { ...source.accessControl, aclRevision: request.acl.aclRevision },
        }),
    lastSyncedAt: request.lastSyncedAt ?? deps.now().toISOString(),
  });

  if (!revisionChanged && !aclChanged) return { outcome: "unchanged" };
  const job = await enqueueInvalidation(deps, {
    businessId: request.businessId,
    sourceId: request.sourceId,
    // An ACL change invalidates cached *authorization*; a revision change invalidates content.
    // Both purge the same targets, so the trigger is evidence rather than a branch.
    trigger: revisionChanged ? "revision_change" : "acl_change",
  });
  return { outcome: "propagated", job };
}
