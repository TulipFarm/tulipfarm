import { keepConfiguration } from '@tulipfarm/config/keep';
import { KnowledgeSearchUnavailable } from '@tulipfarm/memory-core/documents/contracts';
import type { KnowledgeIndexHit, KnowledgeIndexSearch } from '@tulipfarm/memory-core/search';
import {
  createKeepClient,
  keepKnowledgeAllowlistLimit,
  keepWorkspaceKnowledgeScope,
  type KeepClient,
  type KeepKnowledgeEpisode,
  type KeepMemoryResult,
} from '@tulipfarm/memory-keep';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { knowledgeTenantRuntime, type KnowledgeRuntime, type KnowledgeTransaction } from '../storage-ports.ts';

/** The common migration that adds tf_keep_knowledge. */
export const keepKnowledgeVersion = 93;
const deliveryTimeoutMs = 30000;
const searchTimeoutMs = 5000;
const searchLimit = 30;
const searchBudgetTokens = 8000;
// Keep refuses request bodies over 1 MiB, so a document's chunks are sent in batches well under that.
const batchBytes = 512 * 1024;
const batchEpisodes = 256;
const metadataValueBytes = 1024;

export type KnowledgeKeepDependencies = {
  /** The Keep client, or undefined when this deployment has no Keep endpoint. */
  readonly client?: () => KeepClient | undefined;
  /** Whether the workspace's `keep-memory` flag is on. */
  readonly enabled?: (workspaceId: string) => Promise<boolean>;
};

function defaultClient(timeoutMs: number) {
  let client: KeepClient | undefined | null = null;
  return () => {
    if (client !== null) return client;
    const configuration = keepConfiguration();
    client =
      configuration.status === 'configured'
        ? createKeepClient({ endpoint: configuration.endpoint, token: configuration.token, timeoutMs })
        : undefined;
    return client;
  };
}
const defaultEnabled = (workspaceId: string) =>
  isFeatureEnabled('keep-memory', null, { id: workspaceId }).catch(() => false);

function failure(result: Exclude<KeepMemoryResult<unknown>, { status: 'ok' }>) {
  return result.status === 'unavailable'
    ? `${result.reason}${result.code ? `:${result.code}` : ''}`
    : result.status === 'rejected'
      ? `rejected:${result.code}`
      : result.status;
}

/**
 * Searches a workspace's Knowledge in Keep. Keep sees only the document ids passed in, which the search engine takes
 * from the actor's current authorization, and every hit is mapped back to the TulipFarm publication it came from.
 */
export function createKnowledgeKeepIndex({
  client = defaultClient(searchTimeoutMs),
  enabled = defaultEnabled,
}: KnowledgeKeepDependencies = {}): KnowledgeIndexSearch {
  return {
    enabled,
    async search(workspaceId, query, documentIds) {
      const keep = client();
      if (!keep) throw new KnowledgeSearchUnavailable('not-configured');
      const allowed = new Set(documentIds);
      const batches: string[][] = [];
      for (let start = 0; start < documentIds.length; start += keepKnowledgeAllowlistLimit)
        batches.push(documentIds.slice(start, start + keepKnowledgeAllowlistLimit));
      const results = await Promise.all(
        batches.map(sourceIds =>
          keep.searchKnowledge({
            scope: keepWorkspaceKnowledgeScope(workspaceId),
            query,
            sourceIds,
            limit: searchLimit,
            budgetTokens: searchBudgetTokens,
          }),
        ),
      );
      const hits: KnowledgeIndexHit[] = [];
      for (const result of results) {
        if (result.status !== 'ok') throw new KnowledgeSearchUnavailable(failure(result));
        for (const hit of result.value.hits) {
          const metadata = hit.citation?.sourceMetadata ?? {};
          const documentId = hit.sourceId ?? hit.citation?.sourceId;
          const ordinal = Number(hit.citation?.episodeId?.slice(hit.citation.episodeId.lastIndexOf('#') + 1));
          if (
            !documentId ||
            !allowed.has(documentId) ||
            metadata.documentId !== documentId ||
            !metadata.publicationId ||
            !Number.isInteger(ordinal) ||
            ordinal < 0
          )
            continue;
          hits.push({ documentId, publicationId: metadata.publicationId, ordinal, score: hit.score });
        }
      }
      return hits.sort((a, b) => b.score - a.score);
    },
  };
}

const stateSchema = z.object({
  document_id: z.uuid(),
  provider: z.string().nullable(),
  deliverable: z.boolean(),
  reparsing: z.boolean(),
  publication_id: z.uuid().nullable(),
  revision_id: z.uuid().nullable(),
  title: z.string().nullable(),
  canonical_url: z.string().nullable(),
  held: z.boolean().nullable(),
  delivered_publication_id: z.uuid().nullable(),
  failed_publication_id: z.uuid().nullable(),
});
const chunkSchema = z.object({ ordinal: z.number().int(), heading: z.string(), passage: z.string() });
const dueSchema = z.object({ document_id: z.uuid(), action: z.enum(['deliver', 'forget']) });

export type KnowledgeKeepWork = z.infer<typeof dueSchema>;
export type KnowledgeKeepOutcome =
  /** Keep now holds the document's current publication. */
  | { status: 'delivered'; publicationId: string }
  /** Keep already held the current publication. */
  | { status: 'current' }
  /** Keep no longer holds the document. */
  | { status: 'forgotten' }
  /** Nothing to send: the document is unpublished, derived, or never reached Keep. */
  | { status: 'skipped' }
  /** The workspace's flag is off, or the deployment has no Keep endpoint. */
  | { status: 'disabled' }
  /** Keep refused this publication itself. It is recorded and not sent again until the document changes. */
  | { status: 'rejected'; error: string };

/** Keep did not answer. The delivery is safe to retry: every send starts over with `replace`. */
export class KnowledgeKeepUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`Keep unavailable: ${reason}`);
    this.name = 'KnowledgeKeepUnavailable';
  }
}

/**
 * Keeps Keep's copy of a workspace's Knowledge in step with what TulipFarm has published. TulipFarm stays the owner of
 * documents: Keep receives the published chunks of each searchable document and forgets documents that are removed,
 * tombstoned or disconnected.
 */
export function createKnowledgeKeepFeed({
  runtime,
  client = defaultClient(deliveryTimeoutMs),
  enabled = defaultEnabled,
}: { runtime: KnowledgeRuntime } & KnowledgeKeepDependencies) {
  const tenant = knowledgeTenantRuntime(runtime);
  const table = (tx: KnowledgeTransaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
  const keepTable = (tx: KnowledgeTransaction) => qualified(tx.schema, 'tf_keep_knowledge');
  const installed = (tx: KnowledgeTransaction) => tx.commonVersion >= keepKnowledgeVersion;
  // Searchable is the same publication test the eligibility filter applies; a document whose publication is only
  // cleared while a new revision parses is not gone, and its replacement arrives with `replace`.
  const deliverable = `d.tombstoned_at IS NULL AND s.state IN ('active','paused') AND r.sources='[]'::jsonb`;
  const kept = `d.id IS NOT NULL AND d.tombstoned_at IS NULL AND s.state IN ('active','paused')
    AND (d.lexical_publication_id IS NULL OR r.sources='[]'::jsonb)`;

  /**
   * The next documents, in id order after `after`, that Keep must receive or forget. Documents are only sent while the
   * workspace's flag is on, and turning it on makes every published document due, which is the backfill. Documents
   * are forgotten whatever the flag.
   */
  async function due(workspaceId: string, after: string | null, limit: number): Promise<KnowledgeKeepWork[]> {
    if (!client()) return [];
    const deliver = await enabled(workspaceId);
    return tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return [];
      const { rows } = await tx.client.query(
        `(SELECT d.id AS document_id, 'deliver' AS action
          FROM ${table(tx, 'documents')} d
          JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
          JOIN ${table(tx, 'publications')} p ON p.id=d.lexical_publication_id AND p.document_id=d.id
          JOIN ${table(tx, 'revisions')} r ON r.id=p.revision_id
          LEFT JOIN ${keepTable(tx)} k ON k.document_id=d.id
          WHERE $3 AND ${deliverable} AND ($1::uuid IS NULL OR d.id > $1::uuid)
            AND k.publication_id IS DISTINCT FROM p.id AND k.failed_publication_id IS DISTINCT FROM p.id
          ORDER BY d.id LIMIT $2)
        UNION ALL
        (SELECT k.document_id, 'forget' AS action
          FROM ${keepTable(tx)} k
          LEFT JOIN ${table(tx, 'documents')} d ON d.id=k.document_id
          LEFT JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
          LEFT JOIN ${table(tx, 'publications')} p ON p.id=d.lexical_publication_id
          LEFT JOIN ${table(tx, 'revisions')} r ON r.id=p.revision_id
          WHERE k.held AND NOT coalesce(${kept}, false) AND ($1::uuid IS NULL OR k.document_id > $1::uuid)
          ORDER BY k.document_id LIMIT $2)
        ORDER BY document_id LIMIT $2`,
        [after, limit, deliver],
      );
      return z.array(dueSchema).parse(rows);
    });
  }

  async function state(workspaceId: string, documentId: string) {
    return tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return undefined;
      const { rows } = await tx.client.query(
        `SELECT $1::uuid AS document_id, s.provider,
            coalesce(d.id IS NOT NULL AND p.id IS NOT NULL AND ${deliverable}, false) AS deliverable,
            coalesce(${kept} AND d.lexical_publication_id IS NULL, false) AS reparsing,
            p.id AS publication_id, r.id AS revision_id, r.title, r.canonical_url,
            k.held, k.publication_id AS delivered_publication_id, k.failed_publication_id
          FROM (SELECT 1) one
          LEFT JOIN ${table(tx, 'documents')} d ON d.id=$1
          LEFT JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
          LEFT JOIN ${table(tx, 'publications')} p ON p.id=d.lexical_publication_id AND p.document_id=d.id
          LEFT JOIN ${table(tx, 'revisions')} r ON r.id=p.revision_id
          LEFT JOIN ${keepTable(tx)} k ON k.document_id=$1`,
        [documentId],
      );
      return stateSchema.parse(rows[0]);
    });
  }

  async function write(workspaceId: string, sql: string, values: unknown[]) {
    await tenant.transaction(workspaceId, {}, async tx => {
      await tx.client.query(sql.replaceAll('$table', keepTable(tx)), values);
    });
  }

  async function forget(keep: KeepClient, workspaceId: string, documentId: string): Promise<KnowledgeKeepOutcome> {
    const result = await keep.forgetKnowledgeSource({
      scope: keepWorkspaceKnowledgeScope(workspaceId),
      sourceId: documentId,
    });
    if (result.status !== 'ok' && result.status !== 'not_found') throw new KnowledgeKeepUnavailable(failure(result));
    await write(workspaceId, `DELETE FROM $table WHERE document_id=$1`, [documentId]);
    return { status: 'forgotten' };
  }

  /**
   * Brings Keep's copy of one document up to date: sends its current publication, or forgets it once it is gone.
   * Reads current state each time, so a repeated or late call is harmless. Throws `KnowledgeKeepUnavailable` when Keep
   * does not answer.
   */
  async function sync(workspaceId: string, documentId: string): Promise<KnowledgeKeepOutcome> {
    const keep = client();
    if (!keep) return { status: 'disabled' };
    const current = await state(workspaceId, documentId);
    if (!current) return { status: 'skipped' };
    if (!current.deliverable) {
      if (current.held && !current.reparsing) return forget(keep, workspaceId, documentId);
      return { status: 'skipped' };
    }
    if (!(await enabled(workspaceId))) return { status: 'disabled' };
    const publicationId = z.uuid().parse(current.publication_id);
    if (current.delivered_publication_id === publicationId) return { status: 'current' };
    const chunks = await tenant.transaction(workspaceId, {}, async tx =>
      z
        .array(chunkSchema)
        .parse(
          (
            await tx.client.query(
              `SELECT ordinal, heading, passage FROM ${table(tx, 'chunks')} WHERE publication_id=$1 ORDER BY ordinal`,
              [publicationId],
            )
          ).rows,
        ),
    );
    if (!chunks.length) return { status: 'skipped' };
    const metadata: Record<string, string> = {
      documentId,
      revisionId: z.uuid().parse(current.revision_id),
      publicationId,
      provider: current.provider ?? 'unknown',
    };
    if (current.canonical_url && Buffer.byteLength(current.canonical_url) <= metadataValueBytes)
      metadata.url = current.canonical_url;
    const episodes: KeepKnowledgeEpisode[] = chunks.map(chunk => ({
      id: String(chunk.ordinal),
      text: chunk.heading ? `${chunk.heading}\n\n${chunk.passage}` : chunk.passage,
    }));
    const batches: KeepKnowledgeEpisode[][] = [[]];
    let size = 0;
    for (const episode of episodes) {
      const bytes = Buffer.byteLength(JSON.stringify(episode));
      const last = batches.at(-1)!;
      if (last.length && (size + bytes > batchBytes || last.length >= batchEpisodes)) {
        batches.push([episode]);
        size = bytes;
      } else {
        last.push(episode);
        size += bytes;
      }
    }
    await write(
      workspaceId,
      `INSERT INTO $table (document_id, held) VALUES ($1, true) ON CONFLICT (document_id) DO UPDATE SET held=true`,
      [documentId],
    );
    for (const [index, batch] of batches.entries()) {
      // The first batch replaces any earlier revision; later batches append the rest of this one.
      const result = await keep.ingestKnowledge({
        scope: keepWorkspaceKnowledgeScope(workspaceId),
        sourceId: documentId,
        title: z.string().parse(current.title),
        collection: metadata.provider!,
        kind: 'document',
        episodes: batch,
        metadata,
        ...(index === 0 ? { replace: true } : {}),
      });
      if (result.status === 'unavailable') throw new KnowledgeKeepUnavailable(failure(result));
      if (result.status !== 'ok') {
        const error = failure(result);
        await write(
          workspaceId,
          `UPDATE $table SET failed_publication_id=$2, failed_at=clock_timestamp(), last_error=$3, attempts=attempts+1
            WHERE document_id=$1`,
          [documentId, publicationId, error],
        );
        return { status: 'rejected', error };
      }
    }
    await write(
      workspaceId,
      `UPDATE $table SET publication_id=$2, delivered_at=clock_timestamp(), failed_publication_id=NULL, failed_at=NULL,
          last_error=NULL, attempts=0
        WHERE document_id=$1`,
      [documentId, publicationId],
    );
    return { status: 'delivered', publicationId };
  }

  /**
   * Records a delivery that failed after its retries, so the failure stays visible until a later run succeeds. A
   * permanent failure also pins the current publication, which is then not sent again until the document changes.
   */
  async function recordFailure(workspaceId: string, documentId: string, error: string, permanent = false) {
    await tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return;
      await tx.client.query(
        `INSERT INTO ${keepTable(tx)} AS k (document_id, failed_publication_id, failed_at, last_error, attempts)
          VALUES ($1, CASE WHEN $3 THEN (SELECT lexical_publication_id FROM ${table(tx, 'documents')} WHERE id=$1) END,
            clock_timestamp(), $2, 1)
          ON CONFLICT (document_id) DO UPDATE SET failed_publication_id=coalesce(excluded.failed_publication_id,
              k.failed_publication_id), failed_at=excluded.failed_at, last_error=excluded.last_error,
            attempts=k.attempts+1`,
        [documentId, error.slice(0, 1024), permanent],
      );
    });
  }

  /** Whether the workspace has any Keep work due. */
  async function pending(workspaceId: string) {
    return (await due(workspaceId, null, 1)).length > 0;
  }

  return { due, sync, recordFailure, pending };
}
export type KnowledgeKeepFeed = ReturnType<typeof createKnowledgeKeepFeed>;
