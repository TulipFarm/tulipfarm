import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uuidSchema, type Principal as HumanActor } from '../documents/records.ts';
import { requireAccess } from '../ports/authorizer.ts';
import type { TenantRuntime, StorageErrorPolicy } from '../ports/tenant-runtime.ts';
import type { KnowledgeAuthorization, AccessErrors } from '../ports/knowledge-authorization.ts';
import type { LexicalIndex } from '../ports/lexical-index.ts';
import type { VectorIndex } from '../ports/vector-index.ts';
import type { SearchSessions } from '../ports/search-sessions.ts';
import type { Clock } from '../ports/runtime.ts';
import {
  knowledgeCitationSchema,
  knowledgeSearchFiltersSchema,
  knowledgeSearchRequestSchema,
  knowledgeSearchReasonSchema,
  type KnowledgeSearchFilters,
  type KnowledgeSearchResult,
} from '../contracts/knowledge.ts';
import type { createEmbeddingEngine } from '../embeddings/engine.ts';
import { KnowledgeError } from '../documents/contracts.ts';
import type { createDocumentStore } from '../documents/store.ts';
import { normalizeIdentifier } from '../documents/identifiers.ts';

const candidateSchema = z.object({
  document_id: uuidSchema,
  source_id: uuidSchema,
  revision_id: uuidSchema,
  publication_id: uuidSchema,
  access_epoch: z.number().int(),
  ordinal: z.number().int(),
  vector_publication_id: uuidSchema.nullable(),
  exact: z.boolean().default(false),
  broadened: z.boolean().optional(),
});
type Candidate = z.infer<typeof candidateSchema>;
const eligibleVectorSchema = z.object({
  document_id: uuidSchema,
  source_id: uuidSchema,
  revision_id: uuidSchema,
  publication_id: uuidSchema,
  access_epoch: z.number().int(),
  vector_publication_id: uuidSchema,
});
const eligibleLexicalSchema = z.object({
  document_id: uuidSchema,
  source_id: uuidSchema,
  revision_id: uuidSchema,
  publication_id: uuidSchema,
  access_epoch: z.number().int(),
  semantic: z.boolean(),
});
const lexicalMatchSchema = z.object({
  publication_id: uuidSchema,
  ordinal: z.number().int(),
  exact: z.boolean(),
  rank: z.number(),
});
const nearestSchema = z.object({
  vector_publication_id: uuidSchema,
  lexical_publication_id: uuidSchema,
  ordinal: z.number().int(),
  distance: z.number(),
});
const sessionSchema = z.object({
  id: uuidSchema,
  fingerprint: z.string(),
  filters: knowledgeSearchFiltersSchema,
  candidates: z.array(candidateSchema).max(100),
  mode: z.enum(['keyword-only', 'hybrid']),
  reason: knowledgeSearchReasonSchema.nullable(),
  coverage: z.enum(['complete', 'partial', 'keyword-only']),
  expires_at: z.date(),
});
type Session = z.infer<typeof sessionSchema>;

const values = (actor: HumanActor, filters: KnowledgeSearchFilters): [string, string, string[], string[], string[]] => [
  actor.membershipId,
  actor.userId,
  filters.kinds,
  filters.sourceIds,
  filters.documentIds,
];
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function fuseKnowledgeCandidates(lexical: Candidate[], semantic: Candidate[]) {
  const ranked = new Map<string, { candidate: Candidate; score: number }>();
  for (const list of [lexical, semantic])
    list.forEach((candidate, index) => {
      const key = `${candidate.publication_id}:${candidate.ordinal}`;
      const existing = ranked.get(key);
      ranked.set(key, {
        candidate: {
          ...candidate,
          exact: candidate.exact || existing?.candidate.exact === true,
          vector_publication_id: candidate.vector_publication_id ?? existing?.candidate.vector_publication_id ?? null,
          ...(candidate.broadened || existing?.candidate.broadened ? { broadened: true } : {}),
        },
        score: (existing?.score ?? 0) + 1 / (60 + index + 1),
      });
    });
  const documents = new Set<string>();
  return [...ranked.values()]
    .sort(
      (a, b) =>
        Number(b.candidate.exact) - Number(a.candidate.exact) ||
        b.score - a.score ||
        a.candidate.document_id.localeCompare(b.candidate.document_id) ||
        a.candidate.ordinal - b.candidate.ordinal,
    )
    .filter(({ candidate }) => {
      if (documents.has(candidate.document_id)) return false;
      documents.add(candidate.document_id);
      return true;
    })
    .slice(0, 100)
    .map(({ candidate }) => candidate);
}

export type SearchEngineOptions<Context, Source extends { kind: string }> = {
  runtime: TenantRuntime<Context>;
  store: ReturnType<typeof createDocumentStore<Context, Source>>;
  embeddings: ReturnType<typeof createEmbeddingEngine<Context, Source>>;
  authorization: Pick<KnowledgeAuthorization<Context, Source>, 'authority' | 'admit'>;
  lexical(context: Context): LexicalIndex;
  vector(context: Context): VectorIndex;
  sessions(context: Context): SearchSessions;
  selectReaders(context: Context, actor: HumanActor): Promise<void>;
  availability(context: Context, actor: HumanActor, filters: KnowledgeSearchFilters): Promise<boolean>;
  errors: AccessErrors;
  storageErrors: StorageErrorPolicy;
  clock: Clock;
  callTimeoutMs: number;
  profile: { id: string };
};
export function createSearchEngine<Context, Source extends { kind: string }>({
  runtime,
  store,
  embeddings,
  authorization,
  lexical: lexicalIndex,
  vector: vectorIndex,
  sessions,
  selectReaders,
  availability,
  errors,
  storageErrors,
  clock,
  callTimeoutMs,
  profile: knowledgeEmbeddingProfile,
}: SearchEngineOptions<Context, Source>) {
  type Transaction = Context;
  const { AccessDenied, SourceAuthorizationUnavailable } = errors;
  const { authority: createKnowledgeAuthorizer, admit: admitKnowledgePrincipal } = authorization;
  async function until<T>(promise: Promise<T>, deadlineAt: number, clock: Clock): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(storageErrors.timeout()), Math.max(0, deadlineAt - clock.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const processing = new Set<Promise<unknown>>();
  async function transaction<T>(
    workspaceId: string,
    userId: string,
    deadlineAt: number,
    write: boolean,
    operation: (tx: Transaction, actor: HumanActor) => Promise<T>,
  ) {
    const compatibility = { deadlineAt };
    return runtime.transaction(workspaceId, compatibility, async raw => {
      const tx = store.bind(raw);
      const actor = requireAccess(await admitKnowledgePrincipal(tx, userId, write ? 'write' : 'read'));
      await selectReaders(tx, actor);
      return operation(tx, actor);
    });
  }
  async function lexical(
    workspaceId: string,
    userId: string,
    query: string,
    filters: KnowledgeSearchFilters,
    typing: boolean,
    deadlineAt: number,
    allowKeywordFallback = false,
  ) {
    return transaction(workspaceId, userId, deadlineAt, false, async (tx, actor) => {
      const prefix = (query.match(/[\p{L}\p{N}]+/gu) ?? [])
        .slice(0, 8)
        .map(word => `${word.slice(0, 64)}:*`)
        .join(' & ');
      // Load eligibility once, then drive matching from the GIN indexes with a hashed publication filter.
      // A join against the eligibility CTE is misestimated as one row and scans every eligible chunk.
      const eligible = z
        .array(eligibleLexicalSchema)
        .parse(
          (await lexicalIndex(tx).eligiblePublications([...values(actor, filters), knowledgeEmbeddingProfile.id])).rows,
        );
      const coverage = { lexical: eligible.length, semantic: eligible.filter(row => row.semantic).length };
      const byPublication = new Map(eligible.map(row => [row.publication_id, row]));
      const match = async (broaden: boolean) =>
        eligible.length
          ? z
              .array(lexicalMatchSchema)
              .parse(
                (
                  await lexicalIndex(tx).match(
                    [query, prefix, typing, normalizeIdentifier(query), [...byPublication.keys()]],
                    { broaden, publicationCount: byPublication.size },
                  )
                ).rows,
              )
          : [];
      let matched = await match(false);
      let broadened = false;
      // Preserve explicit phrases, exclusions and OR syntax; only widen plain topic queries with no strict match.
      if (allowKeywordFallback && !typing && !matched.length && !/"|(?:^|\s)-\S|\bor\b/i.test(query)) {
        matched = await match(true);
        broadened = matched.length > 0;
      }
      const candidates = matched
        .flatMap(row => {
          const owner = byPublication.get(row.publication_id);
          return owner ? [{ row, owner }] : [];
        })
        .sort(
          (a, b) =>
            Number(b.row.exact) - Number(a.row.exact) ||
            b.row.rank - a.row.rank ||
            (a.owner.document_id < b.owner.document_id
              ? -1
              : a.owner.document_id > b.owner.document_id
                ? 1
                : a.row.ordinal - b.row.ordinal),
        )
        .map(({ row, owner }) => ({
          document_id: owner.document_id,
          source_id: owner.source_id,
          revision_id: owner.revision_id,
          publication_id: owner.publication_id,
          access_epoch: owner.access_epoch,
          ordinal: row.ordinal,
          vector_publication_id: null,
          exact: row.exact,
          ...(broadened ? { broadened: true } : {}),
        }));
      const unavailable = await availability(tx, actor, filters);
      return {
        candidates: z.array(candidateSchema).parse(candidates),
        coverage,
        unavailable,
      };
    });
  }
  async function semantic(
    workspaceId: string,
    userId: string,
    filters: KnowledgeSearchFilters,
    vector: number[],
    deadlineAt: number,
  ) {
    return transaction(workspaceId, userId, deadlineAt, false, async (tx, actor) => {
      // Load eligible publications first. Joining the eligibility CTE inside the vector query lets the
      // planner misestimate it as one row and replace the HNSW scan with a brute-force distance sort.
      const eligible = z
        .array(eligibleVectorSchema)
        .parse(
          (await vectorIndex(tx).eligiblePublications([...values(actor, filters), knowledgeEmbeddingProfile.id])).rows,
        );
      if (!eligible.length) return [];
      const byVector = new Map(eligible.map(row => [row.vector_publication_id, row]));
      const ids = [...byVector.keys()];
      const query = JSON.stringify(vector);
      const count = z
        .object({ count: z.number() })
        .parse((await vectorIndex(tx).boundedCount([knowledgeEmbeddingProfile.id, ids])).rows[0]).count;
      const exact = count <= 2048;
      if (!exact) await vectorIndex(tx).configureNearest();

      const documents = new Set<string>();
      const candidates: Candidate[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const rows = z
          .array(nearestSchema)
          .parse(
            (
              await vectorIndex(tx).nearest(
                exact
                  ? [knowledgeEmbeddingProfile.id, ids, query]
                  : [knowledgeEmbeddingProfile.id, ids, query, candidates.map(candidate => candidate.publication_id)],
                exact,
              )
            ).rows,
          );
        const ranked = rows
          .flatMap(row => {
            const owner = byVector.get(row.vector_publication_id);
            return owner && owner.publication_id === row.lexical_publication_id ? [{ row, owner }] : [];
          })
          .sort(
            (a, b) =>
              a.row.distance - b.row.distance ||
              (a.owner.document_id < b.owner.document_id
                ? -1
                : a.owner.document_id > b.owner.document_id
                  ? 1
                  : a.row.ordinal - b.row.ordinal),
          );
        for (const { row, owner } of ranked)
          if (!documents.has(owner.document_id)) {
            documents.add(owner.document_id);
            candidates.push({
              document_id: owner.document_id,
              source_id: owner.source_id,
              revision_id: owner.revision_id,
              publication_id: owner.publication_id,
              access_epoch: owner.access_epoch,
              ordinal: row.ordinal,
              vector_publication_id: row.vector_publication_id,
              exact: false,
            });
          }
        if (exact || candidates.length >= 100 || rows.length < 2000) break;
      }
      return candidates.slice(0, 200);
    });
  }
  async function readSession(workspaceId: string, userId: string, id: string, deadlineAt: number) {
    return transaction(workspaceId, userId, deadlineAt, false, async (tx, actor) =>
      sessionSchema.optional().parse((await sessions(tx).readLive([id, actor.membershipId, actor.userId])).rows[0]),
    );
  }
  async function page(
    workspaceId: string,
    userId: string,
    session: Session,
    offset: number,
    deadlineAt: number,
    persist: boolean,
  ): Promise<KnowledgeSearchResult> {
    // Saving a session admits in read mode. A chat tool's guarded transaction already holds the shared authorization
    // lock and then its conversation row, so upgrading here deadlocks against a reply transaction waiting on that row.
    return transaction(workspaceId, userId, deadlineAt, false, async (tx, actor) => {
      if (session.expires_at.getTime() <= clock.now()) throw new KnowledgeError('superseded');
      if (persist) {
        await sessions(tx).lockOwner([actor.membershipId]);
        await sessions(tx).pruneExpired();
        const count = z
          .object({ count: z.number() })
          .parse((await sessions(tx).countOwned([actor.membershipId])).rows[0]).count;
        if (count >= 100) await sessions(tx).evictOldest([actor.membershipId]);
        await sessions(tx).insert([
          session.id,
          actor.membershipId,
          actor.userId,
          session.fingerprint,
          session.filters,
          JSON.stringify(session.candidates),
          session.mode,
          session.reason,
          session.coverage,
          session.expires_at,
        ]);
        const existing = sessionSchema.parse(
          (await sessions(tx).readOwned([session.id, actor.membershipId, actor.userId])).rows[0],
        );
        if (existing.fingerprint !== session.fingerprint) throw new KnowledgeError('conflict');
        session = existing;
      }
      const rows = z
        .array(
          z
            .object({
              position: z.number(),
              title: z.string(),
              passage: z.string(),
              heading: z.string(),
              expires_at: z.date().nullable(),
              file_id: uuidSchema.nullable(),
            })
            .extend(candidateSchema.shape),
        )
        .parse(
          (
            await sessions(tx).readPage([
              ...values(actor, session.filters),
              JSON.stringify(session.candidates),
              offset,
              knowledgeEmbeddingProfile.id,
              session.candidates.slice(offset).map(candidate => candidate.document_id),
            ])
          ).rows,
        );
      const authorizer = createKnowledgeAuthorizer(tx, actor);
      requireAccess(await authorizer.decide('member', undefined));
      // Eligibility SQL cannot follow a generated file's recursive sources, so the Files check runs for each file-backed hit.
      const readable = new Map<string, boolean>();
      for (const fileId of new Set(rows.flatMap(row => (row.file_id ? [row.file_id] : [])))) {
        try {
          requireAccess(await authorizer.decide('file', fileId));
          readable.set(fileId, true);
        } catch (error) {
          if (!(error instanceof AccessDenied) || error instanceof SourceAuthorizationUnavailable) throw error;
          readable.set(fileId, false);
        }
      }
      const authorized = new Set<string>();
      for (const row of rows) {
        if (authorized.has(row.document_id)) continue;
        try {
          await store.eligible(tx, actor, {
            kind: 'knowledge-document',
            workspaceId,
            documentId: row.document_id,
            sourceId: row.source_id,
            revisionId: row.revision_id,
            publicationId: row.publication_id,
            accessEpoch: row.access_epoch,
          });
          authorized.add(row.document_id);
        } catch (error) {
          if (
            !(error instanceof KnowledgeError) &&
            (!(error instanceof AccessDenied) || error instanceof SourceAuthorizationUnavailable)
          )
            throw error;
        }
      }
      const freshRows = rows.filter(
        row =>
          authorized.has(row.document_id) &&
          (row.expires_at === null || row.expires_at.getTime() > clock.now()) &&
          (row.file_id === null || readable.get(row.file_id)),
      );
      const hits = freshRows.map(row => ({
        title: row.title,
        heading: row.heading,
        text: row.passage,
        citation: knowledgeCitationSchema.parse({
          kind: 'knowledge-document',
          workspaceId,
          documentId: row.document_id,
          sourceId: row.source_id,
          revisionId: row.revision_id,
          publicationId: row.publication_id,
          accessEpoch: row.access_epoch,
          ordinal: row.ordinal,
        }),
      }));
      const next =
        rows.length === 20 ? (rows.at(-1)?.position ?? session.candidates.length) + 1 : session.candidates.length;
      return {
        hits,
        mode: session.mode,
        reason: session.reason,
        ...(session.candidates.some(candidate => candidate.broadened) ? { queryBroadened: true } : {}),
        coverage:
          freshRows.length < rows.length ||
          (rows.length < Math.min(20, session.candidates.length - offset) && session.coverage === 'complete')
            ? 'partial'
            : session.coverage,
        bounded: true,
        continuation: next < session.candidates.length ? `${session.id}:${next}` : null,
        validUntil: new Date(
          Math.min(
            session.expires_at.getTime(),
            clock.now() + 300000,
            ...freshRows.flatMap(row => (row.expires_at ? [row.expires_at.getTime()] : [])),
          ),
        ).toISOString(),
      };
    });
  }
  async function search(
    workspaceId: string,
    userId: string,
    value: unknown,
    requestDeadline = clock.now() + callTimeoutMs,
    signal?: AbortSignal,
    attribution?: { taskFlowId?: string; allowKeywordFallback?: boolean },
  ): Promise<KnowledgeSearchResult> {
    const deadlineAt = Math.min(requestDeadline, clock.now() + callTimeoutMs);
    const input = knowledgeSearchRequestSchema.parse(value);
    signal?.throwIfAborted();
    if (input.kind === 'continue') {
      const [id, position] = input.continuation.split(':');
      const session = await readSession(workspaceId, userId, uuidSchema.parse(id), deadlineAt);
      if (!session) throw new KnowledgeError('superseded');
      return page(workspaceId, userId, session, Number(position), deadlineAt, false);
    }
    const filters = {
      kinds: [...new Set(input.filters.kinds)].sort(),
      sourceIds: [...new Set(input.filters.sourceIds)].sort(),
      documentIds: [...new Set(input.filters.documentIds)].sort(),
    };
    const hash = fingerprint({
      query: input.query,
      filters,
      ...(attribution?.allowKeywordFallback ? { allowKeywordFallback: true } : {}),
    });
    if (input.kind === 'submitted') {
      const previous = await readSession(workspaceId, userId, input.commandId, deadlineAt);
      if (previous) {
        if (previous.fingerprint !== hash) throw new KnowledgeError('conflict');
        return page(workspaceId, userId, previous, 0, deadlineAt, false);
      }
    }
    const lexicalResult = await lexical(
      workspaceId,
      userId,
      input.query,
      filters,
      input.kind === 'typing',
      deadlineAt - 400,
      attribution?.allowKeywordFallback,
    );
    let semanticCandidates: Candidate[] = [];
    let reason: KnowledgeSearchResult['reason'] = input.kind === 'typing' ? 'typing' : 'no-semantic-content';
    let hybrid = false;
    if (input.kind === 'submitted' && lexicalResult.coverage.semantic > 0 && clock.now() < deadlineAt - 600) {
      try {
        signal?.throwIfAborted();
        const prepared = await embeddings.prepareSearchQuery(workspaceId, userId, {
          commandId: input.commandId,
          query: input.query,
          filters,
          deadlineAt: deadlineAt - 550,
          retrySemantic: input.retrySemantic,
          taskFlowId: attribution?.taskFlowId,
        });
        const cancel = () => {
          void embeddings.cancelSearchQuery(workspaceId, userId, prepared.commandId).catch(() => undefined);
        };
        if (signal?.aborted) {
          cancel();
          signal.throwIfAborted();
        }
        signal?.addEventListener('abort', cancel, { once: true });
        let status = prepared;
        if (status.state === 'queued' || status.state === 'capacity-blocked') {
          const pending = embeddings.process(
            { workspaceId, jobId: prepared.jobId, generation: prepared.generation },
            deadlineAt - 550,
            signal,
          );
          processing.add(pending);
          void pending.then(
            () => {
              processing.delete(pending);
              signal?.removeEventListener('abort', cancel);
            },
            () => {
              processing.delete(pending);
              signal?.removeEventListener('abort', cancel);
            },
          );
          await until(pending, deadlineAt - 550, clock);
          status = await embeddings.queryStatus(workspaceId, userId, prepared.commandId, deadlineAt - 500);
        } else signal?.removeEventListener('abort', cancel);
        while (status.state === 'busy' && clock.now() < deadlineAt - 650) {
          await clock.sleep(25);
          status = await embeddings.queryStatus(workspaceId, userId, prepared.commandId, deadlineAt - 550);
        }
        if (status.state === 'ready' && status.vector?.some(value => value !== 0)) {
          semanticCandidates = await semantic(workspaceId, userId, filters, status.vector, deadlineAt - 350);
          hybrid = true;
          reason = null;
        } else
          reason =
            status.state === 'disabled'
              ? 'semantic-not-enabled'
              : status.state === 'credits-blocked'
                ? 'credits-blocked'
                : status.state === 'capacity-blocked'
                  ? 'capacity-blocked'
                  : status.state === 'busy' || status.state === 'queued'
                    ? 'embedding-pending'
                    : 'provider-unavailable';
      } catch (error) {
        if (error instanceof KnowledgeError && error.code === 'conflict') throw error;
        if (storageErrors.deadline(error)) reason = 'deadline';
        else throw error;
      }
    }
    const session: Session = {
      id: input.kind === 'submitted' ? input.commandId : randomUUID(),
      fingerprint: hash,
      filters,
      candidates: fuseKnowledgeCandidates(lexicalResult.candidates, semanticCandidates),
      mode: hybrid ? 'hybrid' : 'keyword-only',
      reason,
      coverage: lexicalResult.unavailable
        ? 'partial'
        : hybrid
          ? lexicalResult.coverage.lexical === lexicalResult.coverage.semantic
            ? 'complete'
            : 'partial'
          : 'keyword-only',
      expires_at: new Date(clock.now() + 300000),
    };
    const result = await page(workspaceId, userId, session, 0, deadlineAt, input.kind === 'submitted');
    return input.kind === 'typing' ? { ...result, continuation: null } : result;
  }
  return {
    search,
    close: async () => {
      await Promise.allSettled(processing);
    },
  };
}
