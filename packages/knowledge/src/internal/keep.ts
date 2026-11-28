import { randomUUID } from 'node:crypto';
import { keepConfiguration } from '@tulipfarm/config/keep';
import { KnowledgeSearchUnavailable } from '@tulipfarm/memory-core/documents/contracts';
import type { KnowledgeIndexHit, KnowledgeIndexSearch } from '@tulipfarm/memory-core/search';
import {
  createKeepClient,
  keepForgetSourcesLimit,
  keepKnowledgeAllowlistLimit,
  keepWorkspaceKnowledgeScope,
  type KeepClient,
  type KeepKnowledgeEpisode,
  type KeepMemoryResult,
} from '@tulipfarm/memory-keep';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { knowledgeTenantRuntime, type KnowledgeRuntime, type KnowledgeTransaction } from '../storage-ports.ts';

/** The common migration that adds tf_keep_knowledge. */
export const keepKnowledgeVersion = 93;
/** The common migration that records how far a document's batches have reached Keep, so a retry resumes there. */
export const keepKnowledgeResumeVersion = 116;
const deliveryTimeoutMs = 30000;
const searchTimeoutMs = 5000;
const searchLimit = 30;
const searchBudgetTokens = 8000;
// Keep refuses request bodies over 1 MiB and embeds every chunk before it answers, so a document's chunks
// are sent in small batches: each call must finish within the delivery timeout even while Keep is busy.
const batchBytes = 128 * 1024;
const batchEpisodes = 32;
const metadataValueBytes = 1024;

export type KnowledgeKeepDependencies = {
  /** The Keep client, or undefined when this deployment has no Keep endpoint. */
  readonly client?: () => KeepClient | undefined;
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

function failure(result: Exclude<KeepMemoryResult<unknown>, { status: 'ok' }>) {
  return result.status === 'unavailable'
    ? `${result.reason}${result.code ? `:${result.code}` : ''}`
    : result.status === 'rejected'
      ? `rejected:${result.code}`
      : result.status;
}

/**
 * Searches a workspace's Knowledge in Keep. Keep answers only for documents whose current publication it has received;
 * documents it has not indexed yet are absent from results until delivery catches up. Keep sees only the document
 * ids passed in, which the search engine takes from the actor's current authorization, and every hit is mapped back to
 * the TulipFarm publication it came from.
 */
export function createKnowledgeKeepIndex({
  client = defaultClient(searchTimeoutMs),
}: KnowledgeKeepDependencies = {}): KnowledgeIndexSearch<KnowledgeTransaction> {
  return {
    configured: () => client() !== undefined,
    async held(tx, publications) {
      if (tx.commonVersion < keepKnowledgeVersion || !publications.length) return new Set();
      const { rows } = await tx.client.query(
        `SELECT k.document_id FROM ${qualified(tx.schema, 'tf_keep_knowledge')} k
          JOIN unnest($1::uuid[], $2::uuid[]) AS p(document_id, publication_id)
            ON p.document_id=k.document_id AND p.publication_id=k.publication_id
          WHERE k.held`,
        [publications.map(item => item.documentId), publications.map(item => item.publicationId)],
      );
      return new Set(
        z
          .array(z.object({ document_id: z.uuid() }))
          .parse(rows)
          .map(row => row.document_id),
      );
    },
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
  sending_publication_id: z.uuid().nullable(),
  sending_chunks: z.number().int().nullable(),
  sent_ordinal: z.number().int().nullable(),
});
const chunkSchema = z.object({ ordinal: z.number().int(), heading: z.string(), passage: z.string() });
const dueSchema = z.object({ document_id: z.uuid(), action: z.enum(['deliver', 'forget']) });

/** Transient failures of one document before its publication is pinned and not sent again until it changes. */
export const keepKnowledgeMaxAttempts = 8;
/**
 * Keep timeouts in a row on one publication, with no batch acknowledged in between, before the document is treated as
 * failing rather than Keep as busy: it then backs off like any failing document and the run moves on.
 */
export const keepKnowledgeMaxTimeouts = 3;
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
  /** The deployment has no Keep endpoint. */
  | { status: 'disabled' }
  /** Keep refused this publication itself. It is recorded and not sent again until the document changes. */
  | { status: 'rejected'; error: string };

/** How a batch forget ended. */
export type KnowledgeKeepBatchOutcome =
  /** Keep no longer holds these documents. Listed documents left out were busy or searchable again. */
  | { status: 'forgotten'; documentIds: string[] }
  /** Keep has no batch route; forget the documents one at a time. */
  | { status: 'unsupported' }
  /** The deployment has no Keep endpoint. */
  | { status: 'disabled' };

/**
 * How far a failure reaches:
 * - `keep`: Keep cannot be reached or is not ready, which affects every document.
 * - `busy`: Keep timed out. A timeout almost always means Keep is overloaded, so sending the next document would only add
 *   to its load; the workflow waits as for an outage and retries the same document, which resumes where it stopped.
 *   After {@link keepKnowledgeMaxTimeouts} timeouts in a row on one publication it is recorded as `document` instead.
 * - `document`: only this document's call failed.
 */
export type KnowledgeKeepFailureScope = 'keep' | 'busy' | 'document';
/** How a failed sync is reported: a Keep outage, Keep busy, a transient failure of this document, or a permanent one. */
export type KnowledgeKeepFailureKind = KnowledgeKeepFailureScope | 'permanent';
/** How a failure was recorded. `busy` becomes `keep` while Keep may only be overloaded, and `document` after that. */
export type KnowledgeKeepRecordedFailure = Exclude<KnowledgeKeepFailureKind, 'busy'>;

/**
 * Keep did not answer. The delivery is safe to retry: a retry of the same publication resends only the batches Keep
 * has not acknowledged, and re-sending an episode Keep already stores is a no-op; any other retry starts over with
 * `replace`.
 */
export class KnowledgeKeepUnavailable extends Error {
  readonly scope: KnowledgeKeepFailureScope;
  constructor(readonly reason: string) {
    super(`Keep unavailable: ${reason}`);
    this.name = 'KnowledgeKeepUnavailable';
    this.scope =
      reason.startsWith('unreachable') || reason.startsWith('not_ready')
        ? 'keep'
        : reason.startsWith('timeout')
          ? 'busy'
          : 'document';
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
}: { runtime: KnowledgeRuntime } & KnowledgeKeepDependencies) {
  const tenant = knowledgeTenantRuntime(runtime);
  const table = (tx: KnowledgeTransaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
  const keepTable = (tx: KnowledgeTransaction) => qualified(tx.schema, 'tf_keep_knowledge');
  const installed = (tx: KnowledgeTransaction) => tx.commonVersion >= keepKnowledgeVersion;
  const resumable = (tx: KnowledgeTransaction) => tx.commonVersion >= keepKnowledgeResumeVersion;
  // Searchable is the same publication test the eligibility filter applies. Anything else, including a cleared
  // publication without a tombstone (lost access, unsupported content, a revision still parsing), is forgotten.
  const deliverable = `d.tombstoned_at IS NULL AND s.state IN ('active','paused') AND r.sources='[]'::jsonb`;
  const searchable = `d.id IS NOT NULL AND p.id IS NOT NULL AND ${deliverable}`;
  const ready = `(k.next_attempt_at IS NULL OR k.next_attempt_at <= clock_timestamp())`;

  /**
   * The next documents, in id order after `after`, that Keep must receive or forget. Every published document Keep
   * does not hold yet is due, so the first run is the backfill. A document waiting out the backoff of an earlier
   * failure is not due yet.
   */
  async function due(workspaceId: string, after: string | null, limit: number): Promise<KnowledgeKeepWork[]> {
    if (!client()) return [];
    return tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return [];
      const { rows } = await tx.client.query(
        `(SELECT d.id AS document_id, 'deliver' AS action
          FROM ${table(tx, 'documents')} d
          JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
          JOIN ${table(tx, 'publications')} p ON p.id=d.lexical_publication_id AND p.document_id=d.id
          JOIN ${table(tx, 'revisions')} r ON r.id=p.revision_id
          LEFT JOIN ${keepTable(tx)} k ON k.document_id=d.id
          WHERE ${deliverable} AND ($1::uuid IS NULL OR d.id > $1::uuid) AND ${ready}
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
        [after, limit],
      );
      return z.array(dueSchema).parse(rows);
    });
  }

  async function state(workspaceId: string, documentId: string) {
    return tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return undefined;
      const progress = resumable(tx)
        ? 'k.sending_publication_id, k.sending_chunks, k.sent_ordinal'
        : 'NULL::uuid AS sending_publication_id, NULL::int AS sending_chunks, NULL::int AS sent_ordinal';
      const { rows } = await tx.client.query(
        `SELECT $1::uuid AS document_id, s.provider, coalesce(${searchable}, false) AS deliverable,
            p.id AS publication_id, r.id AS revision_id, r.title, r.canonical_url,
            k.held, k.publication_id AS delivered_publication_id, ${progress}
          FROM (SELECT 1) one
          LEFT JOIN ${table(tx, 'documents')} d ON d.id=$1
          LEFT JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
          LEFT JOIN ${table(tx, 'publications')} p ON p.id=d.lexical_publication_id AND p.document_id=d.id
          LEFT JOIN ${table(tx, 'revisions')} r ON r.id=p.revision_id
          LEFT JOIN ${keepTable(tx)} k ON k.document_id=$1`,
        [documentId],
      );
      return { ...stateSchema.parse(rows[0]), resumable: resumable(tx) };
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
   *
   * A publication is sent in batches of its chunks in ordinal order; the first batch replaces whatever Keep held and
   * the rest append. Each acknowledged batch is recorded, so when a sync stops part way, a later sync of the same
   * publication sends only the chunks after the last acknowledged one, all without `replace`, rather than making Keep
   * purge and embed the document again. A different publication, or one whose chunk count no longer matches the record,
   * starts over with `replace`.
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
    const resume =
      current.resumable &&
      current.sending_publication_id === publicationId &&
      current.sending_chunks === chunks.length &&
      current.sent_ordinal !== null;
    const remaining = resume ? chunks.filter(chunk => chunk.ordinal > current.sent_ordinal!) : chunks;
    const batches: { episodes: KeepKnowledgeEpisode[]; through: number }[] = [];
    let size = 0;
    for (const chunk of remaining) {
      const episode = {
        id: String(chunk.ordinal),
        text: chunk.heading ? `${chunk.heading}\n\n${chunk.passage}` : chunk.passage,
      };
      const bytes = Buffer.byteLength(JSON.stringify(episode));
      const last = batches.at(-1);
      if (!last || size + bytes > batchBytes || last.episodes.length >= batchEpisodes) {
        batches.push({ episodes: [episode], through: chunk.ordinal });
        size = bytes;
      } else {
        last.episodes.push(episode);
        last.through = chunk.ordinal;
        size += bytes;
      }
    }
    return leased(workspaceId, documentId, async (renew, token) => {
      await write(
        workspaceId,
        current.resumable && !resume
          ? // Timeouts keep counting across restarts of the same publication; a new publication counts afresh.
            `UPDATE $table SET held=true, sending_publication_id=$2, sending_chunks=$3, sent_ordinal=NULL,
                timeouts=CASE WHEN sending_publication_id IS DISTINCT FROM $2 THEN 0 ELSE timeouts END
              WHERE document_id=$1`
          : `UPDATE $table SET held=true WHERE document_id=$1`,
        current.resumable && !resume ? [documentId, publicationId, chunks.length] : [documentId],
      );
      for (const [index, batch] of batches.entries()) {
        await before(renew);
        // Only the first batch of a fresh send replaces any earlier revision; every other batch appends.
        const result = await keep.ingestKnowledge({
          scope: keepWorkspaceKnowledgeScope(workspaceId),
          sourceId: documentId,
          title: z.string().parse(current.title),
          collection: metadata.provider!,
          kind: 'document',
          episodes: batch.episodes,
          metadata,
          ...(index === 0 && !resume ? { replace: true } : {}),
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
        if (
          current.resumable &&
          !(await write(
            workspaceId,
            `UPDATE $table SET sent_ordinal=$4, timeouts=0
              WHERE document_id=$1 AND lease_token=$2 AND sending_publication_id=$3`,
            [documentId, token, publicationId, batch.through],
          ))
        )
          throw new KnowledgeKeepUnavailable('lease-lost');
      }
      await write(
        workspaceId,
        `UPDATE $table SET publication_id=$2, delivered_at=clock_timestamp(), failed_publication_id=NULL,
            failed_at=NULL, last_error=NULL, attempts=0, next_attempt_at=NULL${
              current.resumable
                ? ', sending_publication_id=NULL, sending_chunks=NULL, sent_ordinal=NULL, timeouts=0'
                : ''
            }
          WHERE document_id=$1`,
        [documentId, publicationId],
      );
      return { status: 'delivered', publicationId };
    });
  }

  /**
   * Forgets many documents with one Keep call. Leases every listed document that Keep holds, that is no longer
   * searchable, and that no other sync holds, all under one token; asks Keep to forget them; and deletes their records.
   * Documents it could not lease, or that are searchable again, are left for a later sync. Returns `unsupported` when
   * Keep has no batch route, so the caller forgets one document at a time instead. Throws `KnowledgeKeepUnavailable`
   * when Keep does not answer; nothing is recorded then, and the documents stay due.
   */
  async function forget(
    workspaceId: string,
    documentIds: readonly string[],
    options: { signal?: AbortSignal; progress?: () => void } = {},
  ): Promise<KnowledgeKeepBatchOutcome> {
    const keep = client();
    if (!keep) return { status: 'disabled' };
    const ids = [...new Set(documentIds)];
    if (!ids.length || ids.length > keepForgetSourcesLimit) throw new Error('Forget between 1 and 1000 documents');
    const token = randomUUID();
    const leasedIds = await tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return [];
      const { rows } = await tx.client.query(
        `UPDATE ${keepTable(tx)} k SET lease_token=$2, lease_until=clock_timestamp() + make_interval(secs => $3)
          WHERE k.document_id = ANY($1::uuid[]) AND k.held
            AND (k.lease_until IS NULL OR k.lease_until < clock_timestamp())
            AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d
              JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
              JOIN ${table(tx, 'publications')} p ON p.id=d.lexical_publication_id AND p.document_id=d.id
              JOIN ${table(tx, 'revisions')} r ON r.id=p.revision_id
              WHERE d.id=k.document_id AND ${deliverable})
          RETURNING k.document_id`,
        [ids, token, leaseSeconds],
      );
      return z
        .array(z.object({ document_id: z.uuid() }))
        .parse(rows)
        .map(row => row.document_id);
    });
    if (!leasedIds.length) return { status: 'forgotten', documentIds: [] };
    try {
      options.signal?.throwIfAborted();
      options.progress?.();
      const result = await keep.forgetKnowledgeSources({
        scope: keepWorkspaceKnowledgeScope(workspaceId),
        sourceIds: leasedIds,
      });
      if (result.status === 'not_found') return { status: 'unsupported' };
      if (result.status !== 'ok') throw new KnowledgeKeepUnavailable(failure(result));
      // Keep holds none of them now: each was either forgotten or already missing.
      await write(workspaceId, `DELETE FROM $table WHERE document_id = ANY($1::uuid[]) AND lease_token=$2`, [
        leasedIds,
        token,
      ]);
      return { status: 'forgotten', documentIds: leasedIds };
    } finally {
      await write(
        workspaceId,
        `UPDATE $table SET lease_token=NULL, lease_until=NULL WHERE document_id = ANY($1::uuid[]) AND lease_token=$2`,
        [leasedIds, token],
      );
    }
  }

  /**
   * Records a failed sync so it stays visible until a later run succeeds, and returns how it was recorded.
   * - `keep`: Keep itself was down. Recorded without backoff; the workflow waits for Keep instead.
   * - `busy`: Keep timed out. Recorded as `keep` and counted against the document; the
   *   {@link keepKnowledgeMaxTimeouts}th timeout in a row is recorded as `document`. Storage that cannot count
   *   timeouts records every one as `document`.
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
  ): Promise<KnowledgeKeepRecordedFailure> {
    return tenant.transaction(workspaceId, {}, async tx => {
      const recorded: KnowledgeKeepRecordedFailure = kind !== 'busy' ? kind : resumable(tx) ? 'keep' : 'document';
      if (!installed(tx)) return recorded;
      if (kind === 'busy' && recorded === 'keep') {
        const { rows } = await tx.client.query(
          `INSERT INTO ${keepTable(tx)} AS k (document_id, timeouts) VALUES ($1, 1)
            ON CONFLICT (document_id) DO UPDATE SET timeouts=k.timeouts + 1
            RETURNING timeouts`,
          [documentId],
        );
        const timeouts = z.object({ timeouts: z.number().int() }).parse(rows[0]).timeouts;
        if (timeouts >= keepKnowledgeMaxTimeouts) {
          await tx.client.query(`UPDATE ${keepTable(tx)} SET timeouts=0 WHERE document_id=$1`, [documentId]);
          return record(tx, 'document');
        }
      }
      return record(tx, recorded);
    });
    async function record(tx: KnowledgeTransaction, recorded: KnowledgeKeepRecordedFailure) {
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
        [documentId, error.slice(0, 1024), recorded, keepKnowledgeMaxAttempts],
      );
      return recorded;
    }
  }

  /**
   * Whether the workspace has any Keep work due: the same documents {@link due} returns, counted rather than listed.
   * Nothing is due most of the time, and proving that visits every document. Without a limit Postgres hashes the narrow
   * tables and reads only the publication and revision indexes, instead of walking every document in id order and
   * loading its wide publication and revision rows.
   */
  async function pending(workspaceId: string) {
    if (!client()) return false;
    return tenant.transaction(workspaceId, {}, async tx => {
      if (!installed(tx)) return false;
      const plain = `EXISTS (SELECT 1 FROM ${table(tx, 'publications')} p
          JOIN ${table(tx, 'revisions')} r ON r.id=p.revision_id
          WHERE p.id=d.lexical_publication_id AND p.document_id=d.id AND r.sources='[]'::jsonb)`;
      const { rows } = await tx.client.query(
        `SELECT (SELECT count(*) FROM ${table(tx, 'documents')} d
            JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
            LEFT JOIN ${keepTable(tx)} k ON k.document_id=d.id
            WHERE d.tombstoned_at IS NULL AND s.state IN ('active','paused') AND ${ready}
              AND k.publication_id IS DISTINCT FROM d.lexical_publication_id
              AND k.failed_publication_id IS DISTINCT FROM d.lexical_publication_id AND ${plain})
          + (SELECT count(*) FROM ${keepTable(tx)} k
            LEFT JOIN ${table(tx, 'documents')} d ON d.id=k.document_id
            LEFT JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
            WHERE k.held AND ${ready}
              AND NOT coalesce(d.id IS NOT NULL AND d.tombstoned_at IS NULL AND s.state IN ('active','paused') AND ${plain}, false)) > 0
          AS pending`,
      );
      return z.object({ pending: z.boolean() }).parse(rows[0]).pending;
    });
  }

  return { due, sync, forget, recordFailure, pending };
}
export type KnowledgeKeepFeed = ReturnType<typeof createKnowledgeKeepFeed>;
