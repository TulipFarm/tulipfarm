import { randomUUID } from 'node:crypto';
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
  publication_id: z.uuid().nullable(),
  revision_id: z.uuid().nullable(),
  title: z.string().nullable(),
  canonical_url: z.string().nullable(),
  held: z.boolean().nullable(),
  delivered_publication_id: z.uuid().nullable(),
});
const chunkSchema = z.object({ ordinal: z.number().int(), heading: z.string(), passage: z.string() });
const dueSchema = z.object({ document_id: z.uuid(), action: z.enum(['deliver', 'forget']) });

/** Transient failures of one document before its publication is pinned and not sent again until it changes. */
export const keepKnowledgeMaxAttempts = 8;
// One sync holds a document's lease, so a timed-out attempt and its retry never send the same document at once. Each
// Keep call is bounded by the client timeout, well inside the lease, and the lease is renewed before every call.
const leaseSeconds = 180;

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
  /** Another sync of this document is still running; the document stays due. */
  | { status: 'busy' }
  /** The workspace's flag is off, or the deployment has no Keep endpoint. */
  | { status: 'disabled' }
  /** Keep refused this publication itself. It is recorded and not sent again until the document changes. */
  | { status: 'rejected'; error: string };

/**
 * How far a failure reaches: `keep` when Keep cannot be reached or is not ready, which affects every document;
 * `document` when only this document's call failed, such as a timeout on a large document.
 */
export type KnowledgeKeepFailureScope = 'keep' | 'document';
/** How a failed sync is recorded: a Keep outage, a transient failure of this document, or a permanent one. */
export type KnowledgeKeepFailureKind = KnowledgeKeepFailureScope | 'permanent';

/** Keep did not answer. The delivery is safe to retry: every send starts over with `replace`. */
export class KnowledgeKeepUnavailable extends Error {
  readonly scope: KnowledgeKeepFailureScope;
  constructor(readonly reason: string) {
    super(`Keep unavailable: ${reason}`);
    this.name = 'KnowledgeKeepUnavailable';
    this.scope = reason.startsWith('unreachable') || reason.startsWith('not_ready') ? 'keep' : 'document';
  }
}

/**
 * Keeps Keep's copy of a workspace's Knowledge in step with what TulipFarm has published. TulipFarm stays the owner of
 * documents: Keep receives the published chunks of each searchable document and forgets any document that is no
 * longer searchable, whether removed, tombstoned, disconnected, unpublished or waiting for a new revision to parse.
 * A document that is published again is sent again with `replace`.
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
  // Searchable is the same publication test the eligibility filter applies. Anything else, including a cleared
  // publication without a tombstone (lost access, unsupported content, a revision still parsing), is forgotten.
  const deliverable = `d.tombstoned_at IS NULL AND s.state IN ('active','paused') AND r.sources='[]'::jsonb`;
  const searchable = `d.id IS NOT NULL AND p.id IS NOT NULL AND ${deliverable}`;
  const ready = `(k.next_attempt_at IS NULL OR k.next_attempt_at <= clock_timestamp())`;

  /**
   * The next documents, in id order after `after`, that Keep must receive or forget. Documents are only sent while the
   * workspace's flag is on, and turning it on makes every published document due, which is the backfill. Documents
   * are forgotten whatever the flag. A document waiting out the backoff of an earlier failure is not due yet.
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
          WHERE $3 AND ${deliverable} AND ($1::uuid IS NULL OR d.id > $1::uuid) AND ${ready}
            AND k.publication_id IS DISTINCT FROM p.id AND k.failed_publication_id IS DISTINCT FROM p.id
          ORDER BY d.id LIMIT $2)
        UNION ALL
        (SELECT k.document_id, 'forget' AS action
          FROM ${keepTable(tx)} k
          LEFT JOIN ${table(tx, 'documents')} d ON d.id=k.document_id
          LEFT JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
          LEFT JOIN ${table(tx, 'publications')} p ON p.id=d.lexical_publication_id AND p.document_id=d.id
          LEFT JOIN ${table(tx, 'revisions')} r ON r.id=p.revision_id
          WHERE k.held AND NOT coalesce(${searchable}, false) AND ${ready}
            AND ($1::uuid IS NULL OR k.document_id > $1::uuid)
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
        `SELECT $1::uuid AS document_id, s.provider, coalesce(${searchable}, false) AS deliverable,
            p.id AS publication_id, r.id AS revision_id, r.title, r.canonical_url,
            k.held, k.publication_id AS delivered_publication_id
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
    return tenant.transaction(
      workspaceId,
      {},
      async tx => (await tx.client.query(sql.replaceAll('$table', keepTable(tx)), values)).rowCount ?? 0,
    );
  }

  /**
   * Runs `work` while holding the document's lease. Returns `busy` when another sync holds it. `renew` extends the lease
   * before each Keep call and throws when the lease was lost, so a stale attempt stops before sending anything more.
   */
  async function leased(
    workspaceId: string,
    documentId: string,
    work: (renew: () => Promise<void>, token: string) => Promise<KnowledgeKeepOutcome>,
  ): Promise<KnowledgeKeepOutcome> {
    const token = randomUUID();
    const acquired = await write(
      workspaceId,
      `INSERT INTO $table AS k (document_id, lease_token, lease_until)
        VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3))
        ON CONFLICT (document_id) DO UPDATE SET lease_token=excluded.lease_token, lease_until=excluded.lease_until
        WHERE k.lease_until IS NULL OR k.lease_until < clock_timestamp()`,
      [documentId, token, leaseSeconds],
    );
    if (!acquired) return { status: 'busy' };
    const renew = async () => {
      const renewed = await write(
        workspaceId,
        `UPDATE $table SET lease_until=clock_timestamp() + make_interval(secs => $3)
          WHERE document_id=$1 AND lease_token=$2`,
        [documentId, token, leaseSeconds],
      );
      if (!renewed) throw new KnowledgeKeepUnavailable('lease-lost');
    };
    try {
      return await work(renew, token);
    } finally {
      await write(
        workspaceId,
        `UPDATE $table SET lease_token=NULL, lease_until=NULL WHERE document_id=$1 AND lease_token=$2`,
        [documentId, token],
      );
    }
  }

  /**
   * Brings Keep's copy of one document up to date: sends its current publication, or forgets it once it is no longer
   * searchable. Reads current state each time, so a repeated or late call is harmless. `progress` is called before
   * each Keep call, and `signal` stops the sync between calls. Throws `KnowledgeKeepUnavailable` when Keep does not
   * answer.
   */
  async function sync(
    workspaceId: string,
    documentId: string,
    options: { signal?: AbortSignal; progress?: () => void } = {},
  ): Promise<KnowledgeKeepOutcome> {
    const keep = client();
    if (!keep) return { status: 'disabled' };
    const current = await state(workspaceId, documentId);
    if (!current) return { status: 'skipped' };
    const before = async (renew: () => Promise<void>) => {
      options.signal?.throwIfAborted();
      await renew();
      options.progress?.();
    };
    if (!current.deliverable) {
      if (!current.held) return { status: 'skipped' };
      return leased(workspaceId, documentId, async (renew, token) => {
        await before(renew);
        const result = await keep.forgetKnowledgeSource({
          scope: keepWorkspaceKnowledgeScope(workspaceId),
          sourceId: documentId,
        });
        if (result.status !== 'ok' && result.status !== 'not_found')
          throw new KnowledgeKeepUnavailable(failure(result));
        await write(workspaceId, `DELETE FROM $table WHERE document_id=$1 AND lease_token=$2`, [documentId, token]);
        return { status: 'forgotten' };
      });
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
    return leased(workspaceId, documentId, async renew => {
      await write(workspaceId, `UPDATE $table SET held=true WHERE document_id=$1`, [documentId]);
      for (const [index, batch] of batches.entries()) {
        await before(renew);
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
            `UPDATE $table SET failed_publication_id=$2, failed_at=clock_timestamp(), last_error=$3,
                attempts=attempts+1, next_attempt_at=NULL
              WHERE document_id=$1`,
            [documentId, publicationId, error],
          );
          return { status: 'rejected', error };
        }
      }
      await write(
        workspaceId,
        `UPDATE $table SET publication_id=$2, delivered_at=clock_timestamp(), failed_publication_id=NULL,
            failed_at=NULL, last_error=NULL, attempts=0, next_attempt_at=NULL
          WHERE document_id=$1`,
        [documentId, publicationId],
      );
      return { status: 'delivered', publicationId };
    });
  }

  /**
   * Records a failed sync so it stays visible until a later run succeeds.
   * - `keep`: Keep itself was down. Recorded without backoff; the workflow waits for Keep instead.
   * - `document`: this document's call failed. It backs off exponentially (1 minute doubling to 6 hours), and after
   *   {@link keepKnowledgeMaxAttempts} failures its current publication is pinned instead, until the document changes.
   * - `permanent`: the current publication is pinned at once.
   * Forgetting is never pinned: has no publication to pin, so it keeps retrying with backoff.
   */
  async function recordFailure(
    workspaceId: string,
    documentId: string,
    error: string,
    kind: KnowledgeKeepFailureKind = 'document',
  ) {
    await tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return;
      await tx.client.query(
        `WITH current AS (SELECT (SELECT lexical_publication_id FROM ${table(tx, 'documents')} WHERE id=$1) AS id),
          prior AS (SELECT attempts, failed_publication_id FROM ${keepTable(tx)} WHERE document_id=$1),
          -- A pin on an earlier publication says nothing about the current one, which starts counting afresh.
          counted AS (SELECT CASE WHEN $3='keep' THEN coalesce((SELECT attempts FROM prior), 0)
              WHEN (SELECT failed_publication_id FROM prior) IS DISTINCT FROM (SELECT id FROM current)
                AND (SELECT failed_publication_id FROM prior) IS NOT NULL THEN 1
              ELSE coalesce((SELECT attempts FROM prior), 0) + 1 END AS attempts)
        INSERT INTO ${keepTable(tx)} AS k (document_id, failed_publication_id, failed_at, last_error, attempts,
            next_attempt_at)
          SELECT $1,
            CASE WHEN $3='permanent' OR ($3='document' AND counted.attempts >= $4) THEN current.id
              ELSE (SELECT failed_publication_id FROM prior) END,
            clock_timestamp(), $2, counted.attempts,
            CASE WHEN $3='document' AND counted.attempts < $4 THEN clock_timestamp()
              + least(interval '1 minute' * power(2, greatest(counted.attempts - 1, 0)), interval '6 hours') END
          FROM current, counted
          ON CONFLICT (document_id) DO UPDATE SET failed_publication_id=excluded.failed_publication_id,
            failed_at=excluded.failed_at, last_error=excluded.last_error, attempts=excluded.attempts,
            next_attempt_at=excluded.next_attempt_at`,
        [documentId, error.slice(0, 1024), kind, keepKnowledgeMaxAttempts],
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
