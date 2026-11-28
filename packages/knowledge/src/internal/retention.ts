import { lockAuthorization } from '@tulipfarm/access';
import { keepConfiguration } from '@tulipfarm/config/keep';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { knowledgeTenantRuntime, type KnowledgeRuntime, type KnowledgeTransaction } from '../storage-ports.ts';

/** The common migration that adds `tf_knowledge_purge_expired`. */
export const knowledgePurgeVersion = 125;
/** Documents deleted per transaction, so one batch never holds locks or writes for long. */
export const knowledgePurgeBatch = 250;

export type KnowledgeRetentionDependencies = {
  readonly runtime: KnowledgeRuntime;
  /** Whether Keep is live in this deployment. When it is, a document Keep holds stays until Keep forgets it. */
  readonly keepLive?: () => boolean;
};

/**
 * Deletes removed Knowledge for good once its retention has passed. Removing a source, narrowing a selection or
 * deleting a note tombstones documents for 30 days, during which a sync that sees an item again revives it. After
 * that, `purge` deletes the expired documents with everything stored for them, and removed sources once they have no
 * documents left. It takes the workspace's shared authorization lock, like a sync, and skips a document that Keep
 * still holds, that a sync of its source holds the lease for, or that another transaction has locked.
 */
export function createKnowledgeRetention({
  runtime,
  keepLive = () => keepConfiguration().status === 'configured',
}: KnowledgeRetentionDependencies) {
  const tenant = knowledgeTenantRuntime(runtime);
  const installed = (tx: KnowledgeTransaction) => tx.commonVersion >= knowledgePurgeVersion;
  const table = (tx: KnowledgeTransaction, name: string) => qualified(tx.schema, name);

  /** Whether the workspace has an expired document or removed source that `purge` may delete. */
  async function pending(workspaceId: string) {
    return tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return false;
      const { rows } = await tx.client.query(
        `SELECT EXISTS (
            SELECT 1 FROM ${table(tx, 'tf_knowledge_documents')} d
            WHERE d.tombstoned_at IS NOT NULL AND d.retain_until <= clock_timestamp()
              AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_keep_knowledge')} k WHERE k.document_id=d.id
                AND (($1 AND k.held) OR k.lease_until > clock_timestamp()))
          ) OR EXISTS (
            SELECT 1 FROM ${table(tx, 'tf_knowledge_sources')} s
            WHERE s.state='removed' AND s.retain_until <= clock_timestamp()
              AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_knowledge_documents')} d WHERE d.source_id=s.id)
          ) AS pending`,
        [keepLive()],
      );
      return z.object({ pending: z.boolean() }).parse(rows[0]).pending;
    });
  }

  /** Deletes one batch and returns how many documents and sources it removed. 0 means nothing more is ready now. */
  async function purge(workspaceId: string, limit = knowledgePurgeBatch) {
    const batch = z.number().int().min(1).max(1000).parse(limit);
    return tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return 0;
      await lockAuthorization(tx, 'read');
      const { rows } = await tx.client.query(`SELECT ${table(tx, 'tf_knowledge_purge_expired')}($1, $2) AS removed`, [
        batch,
        keepLive(),
      ]);
      return z.object({ removed: z.number().int().nonnegative() }).parse(rows[0]).removed;
    });
  }

  return { pending, purge };
}

export type KnowledgeRetention = ReturnType<typeof createKnowledgeRetention>;
