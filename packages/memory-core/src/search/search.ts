import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uuidSchema, type Principal as HumanActor } from '../documents/records.ts';
import { requireAccess } from '../ports/authorizer.ts';
import type { TenantRuntime } from '../ports/tenant-runtime.ts';
import type { KnowledgeAuthorization, AccessErrors } from '../ports/knowledge-authorization.ts';
import type { SearchSessions } from '../ports/search-sessions.ts';
import type { Clock } from '../ports/runtime.ts';
import {
  knowledgeCitationSchema,
  knowledgeLocationOf,
  knowledgeSearchFiltersSchema,
  knowledgeSearchRequestSchema,
  type KnowledgeSearchFilters,
  type KnowledgeSearchResult,
} from '../contracts/knowledge.ts';
import { KnowledgeError, KnowledgeSearchUnavailable } from '../documents/contracts.ts';
import type { createDocumentStore } from '../documents/store.ts';

const withLocation = (offset: unknown) => {
  const location = knowledgeLocationOf(offset);
  return location ? { location } : {};
};

const candidateSchema = z.object({
  document_id: uuidSchema,
  source_id: uuidSchema,
  revision_id: uuidSchema,
  publication_id: uuidSchema,
  access_epoch: z.number().int(),
  ordinal: z.number().int(),
});
type Candidate = z.infer<typeof candidateSchema>;
const eligibleSchema = z.object({
  document_id: uuidSchema,
  source_id: uuidSchema,
  revision_id: uuidSchema,
  publication_id: uuidSchema,
  access_epoch: z.number().int(),
});
const sessionSchema = z.object({
  id: uuidSchema,
  fingerprint: z.string(),
  filters: knowledgeSearchFiltersSchema,
  candidates: z.array(candidateSchema).max(100),
  mode: z.string(),
  reason: z.string().nullable(),
  coverage: z.string(),
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

/** A ranked passage from the external Knowledge index, already mapped to TulipFarm ids. */
export type KnowledgeIndexHit = { documentId: string; publicationId: string; ordinal: number; score: number };
/**
 * The external Knowledge index, the only search engine. It answers for the documents whose current publication it
 * holds; a readable document it does not hold yet makes the result partial.
 * `search` receives only document ids the actor may read now and throws `KnowledgeSearchUnavailable` when it cannot answer.
 */
export type KnowledgeIndexSearch<Context = unknown> = {
  configured(): boolean;
  /** Which of these documents the index holds at exactly the given publication, read in the search transaction. */
  held(
    context: Context,
    publications: readonly { documentId: string; publicationId: string }[],
  ): Promise<ReadonlySet<string>>;
  search(workspaceId: string, query: string, documentIds: string[]): Promise<KnowledgeIndexHit[]>;
};

export type SearchEngineOptions<Context, Source extends { kind: string }> = {
  runtime: TenantRuntime<Context>;
  store: ReturnType<typeof createDocumentStore<Context, Source>>;
  authorization: Pick<KnowledgeAuthorization<Context, Source>, 'authority' | 'admit'>;
  sessions(context: Context): SearchSessions;
  selectReaders(context: Context, actor: HumanActor): Promise<void>;
  availability(context: Context, actor: HumanActor, filters: KnowledgeSearchFilters): Promise<boolean>;
  errors: AccessErrors;
  clock: Clock;
  callTimeoutMs: number;
  index?: KnowledgeIndexSearch<Context>;
};
export function createSearchEngine<Context, Source extends { kind: string }>({
  runtime,
  store,
  authorization,
  sessions,
  selectReaders,
  availability,
  errors,
  clock,
  callTimeoutMs,
  index,
}: SearchEngineOptions<Context, Source>) {
  type Transaction = Context;
  const { AccessDenied, SourceAuthorizationUnavailable } = errors;
  const { authority: createKnowledgeAuthorizer, admit: admitKnowledgePrincipal } = authorization;

  async function transaction<T>(
    workspaceId: string,
    userId: string,
    deadlineAt: number,
    operation: (tx: Transaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(workspaceId, { deadlineAt }, async raw => {
      const tx = store.bind(raw);
      const actor = requireAccess(await admitKnowledgePrincipal(tx, userId, 'read'));
      await selectReaders(tx, actor);
      return operation(tx, actor);
    });
  }
  async function readable(
    externalIndex: KnowledgeIndexSearch<Context>,
    workspaceId: string,
    userId: string,
    filters: KnowledgeSearchFilters,
    deadlineAt: number,
  ) {
    return transaction(workspaceId, userId, deadlineAt, async (tx, actor) => {
      const eligible = z
        .array(eligibleSchema)
        .parse((await sessions(tx).eligiblePublications(values(actor, filters))).rows);
      const held = eligible.length
        ? await externalIndex.held(
            tx,
            eligible.map(row => ({ documentId: row.document_id, publicationId: row.publication_id })),
          )
        : new Set<string>();
      return {
        held: eligible.filter(row => held.has(row.document_id)),
        complete: held.size === eligible.length && !(await availability(tx, actor, filters)),
      };
    });
  }
  async function rank(
    externalIndex: KnowledgeIndexSearch<Context>,
    workspaceId: string,
    query: string,
    held: z.infer<typeof eligibleSchema>[],
  ) {
    const byDocument = new Map(held.map(row => [row.document_id, row]));
    // The index only sees documents this actor may read now; page() re-checks each hit before returning it.
    const hits = byDocument.size ? await externalIndex.search(workspaceId, query, [...byDocument.keys()]) : [];
    const documents = new Set<string>();
    const candidates: Candidate[] = [];
    for (const hit of [...hits].sort(
      (a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId) || a.ordinal - b.ordinal,
    )) {
      const owner = byDocument.get(hit.documentId);
      // A hit from an older publication points at passages that no longer exist; its replacement is still in flight.
      if (!owner || owner.publication_id !== hit.publicationId || documents.has(hit.documentId)) continue;
      documents.add(hit.documentId);
      candidates.push({
        document_id: owner.document_id,
        source_id: owner.source_id,
        revision_id: owner.revision_id,
        publication_id: owner.publication_id,
        access_epoch: owner.access_epoch,
        ordinal: hit.ordinal,
      });
      if (candidates.length === 100) break;
    }
    return z.array(candidateSchema).parse(candidates);
  }
  async function readSession(workspaceId: string, userId: string, id: string, deadlineAt: number) {
    return transaction(workspaceId, userId, deadlineAt, async (tx, actor) =>
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
    return transaction(workspaceId, userId, deadlineAt, async (tx, actor) => {
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
              indexed_at: z.date(),
              observed_at: z.date(),
              source_revision: z.string().nullable(),
              synced_at: z.date().nullable(),
              source_offset: z.unknown().optional(),
            })
            .extend(candidateSchema.shape),
        )
        .parse(
          (
            await sessions(tx).readPage([
              ...values(actor, session.filters),
              JSON.stringify(session.candidates),
              offset,
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
      const port = sessions(tx);
      const gapped =
        port.readGaps && freshRows.length
          ? new Set(
              z
                .array(z.object({ publication_id: uuidSchema }))
                .parse((await port.readGaps([[...new Set(freshRows.map(row => row.publication_id))]])).rows)
                .map(row => row.publication_id),
            )
          : undefined;
      const hits = freshRows.map(row => ({
        title: row.title,
        heading: row.heading,
        text: row.passage,
        ...withLocation(row.source_offset),
        ...(gapped ? { coverageGaps: gapped.has(row.publication_id) } : {}),
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
        freshness: {
          indexedAt: row.indexed_at.toISOString(),
          observedAt: row.observed_at.toISOString(),
          sourceRevision: row.source_revision,
          sourceSyncedAt: row.synced_at?.toISOString() ?? null,
        },
      }));
      const next =
        rows.length === 20 ? (rows.at(-1)?.position ?? session.candidates.length) + 1 : session.candidates.length;
      return {
        hits,
        mode: 'hybrid',
        reason: null,
        coverage:
          freshRows.length < rows.length ||
          rows.length < Math.min(20, session.candidates.length - offset) ||
          session.coverage !== 'complete'
            ? 'partial'
            : 'complete',
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
    const hash = fingerprint({ query: input.query, filters });
    if (input.kind === 'submitted') {
      const previous = await readSession(workspaceId, userId, input.commandId, deadlineAt);
      if (previous) {
        if (previous.fingerprint !== hash) throw new KnowledgeError('conflict');
        return page(workspaceId, userId, previous, 0, deadlineAt, false);
      }
    }
    if (!index?.configured()) throw new KnowledgeSearchUnavailable('not-configured');
    const found = await readable(index, workspaceId, userId, filters, deadlineAt - 400);
    signal?.throwIfAborted();
    const session: Session = {
      id: input.kind === 'submitted' ? input.commandId : randomUUID(),
      fingerprint: hash,
      filters,
      candidates: await rank(index, workspaceId, input.query, found.held),
      mode: 'hybrid',
      reason: null,
      coverage: found.complete ? 'complete' : 'partial',
      expires_at: new Date(clock.now() + 300000),
    };
    const result = await page(workspaceId, userId, session, 0, deadlineAt, input.kind === 'submitted');
    return input.kind === 'typing' ? { ...result, continuation: null } : result;
  }
  return {
    search,
    close: async () => {},
  };
}
