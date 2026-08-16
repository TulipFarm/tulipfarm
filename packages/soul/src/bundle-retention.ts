import type { BundleRetentionInput } from "./bundle-store.pg";

/**
 * How long a bundle nothing references is kept anyway.
 *
 * Age is never a reason to delete on its own — the store's exclusion query decides that. This
 * window only holds back bundles whose references may not exist yet: a publication that has
 * stored its bundle but not yet reached `active`, or a Run being minted against a digest whose
 * row is written before `runs`. Thirty days is far beyond either window and still bounds growth.
 */
export const SOUL_BUNDLE_RETENTION_DAYS = 30;
export const SOUL_BUNDLE_RETENTION_MS = SOUL_BUNDLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Rows deleted per statement. Small enough that one pass never holds a long row-lock set. */
export const SOUL_BUNDLE_PRUNE_BATCH = 200;

/**
 * Statements per pass. The product with the batch caps one sweep at 5,000 bundles; a deployment
 * with a larger backlog drains it over consecutive scheduled passes, oldest first, rather than
 * in one unbounded delete.
 */
export const SOUL_BUNDLE_PRUNE_MAX_BATCHES = 25;

/** The one store capability a retention pass needs; keeps the pass off the concrete PG class. */
export interface UnreferencedBundleDeleter {
  deleteUnreferencedBundles(input: BundleRetentionInput): Promise<number>;
}

export interface BundleRetentionPassInput {
  readonly store: UnreferencedBundleDeleter;
  readonly businessId: string;
  readonly now: Date;
  readonly retentionMs?: number;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

export interface BundleRetentionPassResult {
  readonly deleted: number;
  readonly batches: number;
  /** True when the pass hit its statement ceiling, so candidates remain for the next one. */
  readonly backlog: boolean;
}

function bounded(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

/**
 * Deletes unreferenced bundles in bounded batches until a batch comes back short — which means no
 * candidate is left — or the statement ceiling is reached.
 *
 * Every deletion decision belongs to `deleteUnreferencedBundles`, which excludes active,
 * activated, Run-pinned, audited and in-flight-publication digests. This function only bounds it.
 */
export async function pruneUnreferencedBundles(
  input: BundleRetentionPassInput
): Promise<BundleRetentionPassResult> {
  const batchSize = bounded(input.batchSize, SOUL_BUNDLE_PRUNE_BATCH);
  const maxBatches = bounded(input.maxBatches, SOUL_BUNDLE_PRUNE_MAX_BATCHES);
  const retentionMs = bounded(input.retentionMs, SOUL_BUNDLE_RETENTION_MS);
  const olderThan = new Date(input.now.getTime() - retentionMs).toISOString();

  let deleted = 0;
  for (let batch = 1; batch <= maxBatches; batch += 1) {
    const removed = await input.store.deleteUnreferencedBundles({
      businessId: input.businessId,
      olderThan,
      limit: batchSize,
    });
    deleted += removed;
    if (removed < batchSize) return { deleted, batches: batch, backlog: false };
  }
  return { deleted, batches: maxBatches, backlog: true };
}

/** One operator-readable line per pass; the only report a scheduled sweep leaves behind. */
export function bundleRetentionMessage(
  businessId: string,
  result: BundleRetentionPassResult
): string {
  const backlog = result.backlog ? " (backlog remains; next pass continues)" : "";
  return (
    `[soul] bundle retention: deleted ${result.deleted} unreferenced bundle(s) ` +
    `for ${businessId} in ${result.batches} batch(es)${backlog}`
  );
}
