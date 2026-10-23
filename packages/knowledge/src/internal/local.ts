import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { FileError, requireReadableFile, type createFiles } from '@tulipfarm/files';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { KnowledgeParseError, transientParseFailure } from '../parser.ts';
import { parseKnowledgeDocument } from './parse-document.ts';
import {
  knowledgeCommandSchema,
  knowledgeDocumentSchema,
  knowledgeListSchema,
  knowledgeSaveSchema,
  knowledgeSearchSchema,
  knowledgeWorkSchema,
  knowledgeLocationOf,
  type KnowledgeDocument,
  type KnowledgeLocation,
  type KnowledgeWork,
} from '../contracts.ts';
import { citationSchema, knowledgeLimits, KnowledgeError, lexicalInput, revisionInput } from './contracts.ts';
import { createKnowledgeStore, type KnowledgeOptions } from './store.ts';
import { normalizeIdentifier } from './identifiers.ts';
import {
  gappedPublications,
  mediaLimitsForStorage,
  publicationGaps,
  readKnowledgeSettings,
  recognitionFailed,
  recognitionOptions,
  recordParse,
  publicationSeed,
  requeueLocalRecognition,
  resetRecognitionRetries,
  writeKnowledgeSettings,
  type KnowledgeRecognitionAvailability,
  type KnowledgeRecognitionPort,
} from './media.ts';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';

export type LocalKnowledgeOptions = {
  runtime: KnowledgeOptions['runtime'];
  files: ReturnType<typeof createFiles>;
  /** Supplies the document-vision recognizer; without it, images in documents become coverage gaps. */
  recognition?: KnowledgeRecognitionPort;
  /** Whether recognition could run now; when it can, revisions waiting for it are parsed again. */
  recognitionAvailable?: KnowledgeRecognitionAvailability;
};
type Store = ReturnType<typeof createKnowledgeStore>;
type Transaction = Parameters<Store['bind']>[0];
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity = (value: string) => {
  const hex = digest(value);
  return uuidSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
};
const localRow = z.object({
  revision_id: uuidSchema,
  owner_membership_id: uuidSchema,
  owner_user_id: z.string(),
  filename: z.string(),
  media_type: z.string(),
  command_fingerprint: z.string(),
});
const workRow = z.object({
  parsing: knowledgeDocumentSchema.options[0].shape.parsing,
  failure: z.string().nullable(),
  attempts: z.number().int(),
});
const jobRow = z.object({
  revision_id: uuidSchema,
  generation: z.number().int(),
  lease_token: uuidSchema.nullable(),
  lease_until: z.date().nullable(),
});
const retryable = (work: z.infer<typeof workRow>) =>
  work.parsing === 'failed' && work.failure === 'provider' && work.attempts < knowledgeLimits.attemptsPerRevision;
const hidden = (error: unknown) => error instanceof AccessDenied && !(error instanceof SourceAuthorizationUnavailable);

export function createLocalKnowledge({ runtime, files, recognition, recognitionAvailable }: LocalKnowledgeOptions) {
  const store = createKnowledgeStore({ runtime });
  async function transaction<T>(
    workspaceId: string,
    principal: string | HumanActor,
    write: boolean,
    operation: (tx: Transaction, actor: HumanActor) => Promise<T>,
  ) {
    return store.transaction(workspaceId, principal, write, async (tx, actor) => {
      return operation(tx, actor);
    });
  }
  async function localRevision(tx: Transaction, actor: HumanActor, revisionId: string) {
    const local = localRow
      .optional()
      .parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'local_revisions')} WHERE revision_id=$1`, [revisionId]))
          .rows[0],
      );
    if (!local || local.owner_membership_id !== actor.membershipId || local.owner_user_id !== actor.userId)
      throw new AccessDenied();
    return local;
  }
  async function context(tx: Transaction, actor: HumanActor, documentId: string) {
    const doc = await store.document(tx, documentId);
    const source = await store.source(tx, actor, doc.source_id);
    if (!doc.observed_revision_id || (source.provider !== 'note' && source.provider !== 'file'))
      throw new AccessDenied();
    const local = await localRevision(tx, actor, doc.observed_revision_id);
    const revision = store.revisionRow.parse(
      (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [doc.observed_revision_id]))
        .rows[0],
    );
    await store.dependencies(tx, actor, revision);
    return { doc, source, local, revision };
  }
  async function noteBytes(tx: Transaction, revision: z.infer<Store['revisionRow']>) {
    if (revision.original.kind !== 'object' || revision.original.key !== revision.id) throw new AccessDenied();
    const row = z
      .object({ bytes: z.instanceof(Uint8Array) })
      .optional()
      .parse(
        (await tx.client.query(`SELECT bytes FROM ${table(tx, 'note_originals')} WHERE revision_id=$1`, [revision.id]))
          .rows[0],
      );
    if (!row || row.bytes.byteLength !== revision.original.bytes || digest(row.bytes) !== revision.original.sha256)
      throw new KnowledgeError('integrity');
    return row.bytes;
  }
  async function dto(
    tx: Transaction,
    actor: HumanActor,
    documentId: string,
    includeText = false,
  ): Promise<KnowledgeDocument> {
    const { doc, revision } = await context(tx, actor, documentId);
    const work = workRow.parse(
      (await tx.client.query(`SELECT * FROM ${table(tx, 'work')} WHERE revision_id=$1`, [revision.id])).rows[0],
    );
    const base = {
      documentId,
      revisionId: revision.id,
      title: revision.title,
      parsing: work.parsing,
      failure: work.failure,
      publicationId: doc.lexical_publication_id,
      canRetry: retryable(work),
    };
    const gaps = await publicationGaps(tx, doc.lexical_publication_id);
    if (gaps) Object.assign(base, { gaps });
    if (revision.original.kind === 'file') return { ...base, kind: 'file', fileId: revision.original.fileId };
    return {
      ...base,
      kind: 'note',
      ...(includeText
        ? { noteText: new TextDecoder('utf-8', { fatal: true }).decode(await noteBytes(tx, revision)) }
        : {}),
    };
  }
  async function finalDocuments(tx: Transaction, actor: HumanActor, ids: string[]) {
    await currentMember(tx, actor);
    for (const id of ids) await context(tx, actor, id);
  }
  async function clock(tx: Transaction) {
    return z.object({ now: z.date() }).parse((await tx.client.query('SELECT clock_timestamp() AS now')).rows[0]).now;
  }
  async function get(workspaceId: string, userId: string, documentId: string) {
    documentId = uuidSchema.parse(documentId);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const result = await dto(tx, actor, documentId, true);
      await finalDocuments(tx, actor, [documentId]);
      return result;
    });
  }
  async function save(workspaceId: string, userId: string, value: unknown) {
    denyMcpEgress();
    const input = knowledgeSaveSchema.parse(value);
    const fingerprint = digest(JSON.stringify(input));
    const actor = await transaction(workspaceId, userId, false, async (_tx, human) => human);
    const download = input.input.kind === 'file' ? await files.download(workspaceId, userId, input.input.fileId) : null;
    const bytes = input.input.kind === 'note' ? Buffer.from(input.input.text, 'utf8') : download?.bytes;
    if (!bytes || bytes.byteLength < 1 || bytes.byteLength > knowledgeLimits.originalBytes)
      throw new KnowledgeError('quota');
    const filename = download?.name ?? 'note.md';
    const mediaType = download?.mediaType ?? 'text/markdown';
    return transaction(workspaceId, actor, true, async (tx, human) => {
      const existing = await tx.client.query(`SELECT 1 FROM ${table(tx, 'documents')} WHERE id=$1`, [input.documentId]);
      if (existing.rowCount) await context(tx, human, input.documentId);
      else if (input.expectedRevisionId !== null) throw new AccessDenied();
      const replay = localRow
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT * FROM ${table(tx, 'local_revisions')} WHERE revision_id=$1`, [
              input.commandId,
            ])
          ).rows[0],
        );
      if (replay) {
        if (replay.owner_membership_id !== human.membershipId || replay.owner_user_id !== human.userId)
          throw new AccessDenied();
        if (replay.command_fingerprint !== fingerprint) throw new KnowledgeError('conflict');
        const current = await context(tx, human, input.documentId);
        if (current.revision.id !== input.commandId) throw new KnowledgeError('superseded');
        return dto(tx, human, input.documentId, true);
      }
      if (
        (await tx.client.query(`SELECT 1 FROM ${table(tx, 'commands')} WHERE command_id=$1`, [input.commandId]))
          .rowCount
      )
        throw new KnowledgeError('conflict');
      if (input.input.kind === 'file' && !existing.rowCount) {
        // One entry per person and file: adding a file already in this person's Knowledge returns that entry instead of a duplicate.
        await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `knowledge-file:${human.membershipId}:${input.input.fileId}`,
        ]);
        const added = z
          .object({ id: uuidSchema })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT d.id FROM ${table(tx, 'documents')} d
          JOIN ${table(tx, 'revisions')} r ON r.id=d.observed_revision_id
          JOIN ${table(tx, 'local_revisions')} l ON l.revision_id=d.observed_revision_id
          JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
          WHERE l.owner_membership_id=$1 AND l.owner_user_id=$2 AND s.owner_membership_id=$1
            AND d.tombstoned_at IS NULL AND s.state IN ('active','paused') AND r.original->>'kind'='file' AND r.original->>'fileId'=$3
          ORDER BY d.id LIMIT 1`,
                [human.membershipId, human.userId, input.input.fileId],
              )
            ).rows[0],
          );
        if (added) {
          try {
            return await dto(tx, human, added.id, true);
          } catch (error) {
            if (!hidden(error)) throw error;
          }
        }
      }
      const sourceId = identity(`local:${human.membershipId}:${input.input.kind}`);
      const existingSource = await tx.client.query(`SELECT 1 FROM ${table(tx, 'sources')} WHERE id=$1`, [sourceId]);
      if (!existingSource.rowCount) {
        await tx.client.query(
          `INSERT INTO ${table(tx, 'sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,$2,$3,'local',$4)`,
          [sourceId, input.input.kind, human.membershipId, human.membershipId],
        );
      }
      const original =
        input.input.kind === 'note'
          ? { kind: 'object', key: input.commandId, sha256: digest(bytes), bytes: bytes.byteLength }
          : { kind: 'file', fileId: input.input.fileId, sha256: digest(bytes), bytes: bytes.byteLength };
      if (input.input.kind === 'file') {
        const reference = await requireReadableFile(tx, human, input.input.fileId);
        if (reference.sha256 !== digest(bytes) || reference.size !== bytes.byteLength)
          throw new KnowledgeError('integrity');
      }
      await store.observe(
        tx,
        human,
        revisionInput.parse({
          id: input.commandId,
          documentId: input.documentId,
          sourceId,
          nativeId: input.documentId,
          expectedRevisionId: input.expectedRevisionId,
          sourceRevision: input.commandId,
          title: input.title,
          canonicalUrl: null,
          original,
          parserProfile: {
            id: 'local-ingestion-v1',
            engine: 'text',
            version: '1',
            normalization: 'pending',
            ocr: 'disabled',
          },
          sources: [],
        }),
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'local_revisions')} (revision_id,owner_membership_id,owner_user_id,filename,media_type,command_fingerprint) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.commandId, human.membershipId, human.userId, filename, mediaType, fingerprint],
      );
      if (input.input.kind === 'note')
        await tx.client.query(`INSERT INTO ${table(tx, 'note_originals')} (revision_id,bytes) VALUES ($1,$2)`, [
          input.commandId,
          bytes,
        ]);
      await tx.client.query(`INSERT INTO ${table(tx, 'jobs')} (revision_id) VALUES ($1)`, [input.commandId]);
      return dto(tx, human, input.documentId, true);
    });
  }
  async function list(workspaceId: string, userId: string, value: unknown = {}) {
    const input = knowledgeListSchema.parse(value);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const rows = z.array(z.object({ id: uuidSchema })).parse(
        (
          await tx.client.query(
            `SELECT d.id FROM ${table(tx, 'documents')} d
        JOIN ${table(tx, 'local_revisions')} l ON l.revision_id=d.observed_revision_id
        JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
        WHERE l.owner_membership_id=$1 AND l.owner_user_id=$2 AND s.owner_membership_id=$1
          AND d.tombstoned_at IS NULL AND s.state IN ('active','paused') AND ($3::uuid IS NULL OR d.id>$3)
        ORDER BY d.id LIMIT 101`,
            [actor.membershipId, actor.userId, input.cursor ?? null],
          )
        ).rows,
      );
      const items: KnowledgeDocument[] = [];
      for (const row of rows.slice(0, 100)) {
        try {
          items.push(await dto(tx, actor, row.id));
        } catch (error) {
          if (!hidden(error)) throw error;
        }
      }
      await finalDocuments(
        tx,
        actor,
        items.map(item => item.documentId),
      );
      return { items, nextCursor: rows.length > 100 ? (rows[99]?.id ?? null) : null };
    });
  }
  async function search(workspaceId: string, userId: string, value: unknown) {
    const input = knowledgeSearchSchema.parse(value);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const hits: {
        title: string;
        text: string;
        heading: string;
        citation: z.infer<typeof citationSchema>;
        location?: KnowledgeLocation;
        coverageGaps?: boolean;
      }[] = [];
      for (let offset = 0; offset < knowledgeLimits.documents && hits.length < 20; offset += 100) {
        const rows = z
          .array(
            z.object({
              title: z.string(),
              heading: z.string(),
              passage: z.string(),
              ordinal: z.number().int(),
              source_id: uuidSchema,
              document_id: uuidSchema,
              revision_id: uuidSchema,
              publication_id: uuidSchema,
              access_epoch: z.number().int(),
              source_offset: z.unknown(),
            }),
          )
          .parse(
            (
              await tx.client.query(
                `WITH matches AS (
        SELECT k.search_title AS title,k.heading,k.passage,k.ordinal,k.source_offset,d.source_id,d.id AS document_id,d.observed_revision_id AS revision_id,k.publication_id,s.access_epoch,
          (k.identifiers @> ARRAY[$4]::text[]) AS exact_match,ts_rank_cd(k.search_vector,websearch_to_tsquery('english',$3)) AS rank
        FROM ${table(tx, 'chunks')} k JOIN ${table(tx, 'documents')} d ON d.lexical_publication_id=k.publication_id
        JOIN ${table(tx, 'local_revisions')} l ON l.revision_id=d.observed_revision_id
        JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
        WHERE l.owner_membership_id=$1 AND l.owner_user_id=$2 AND s.owner_membership_id=$1 AND s.state IN ('active','paused') AND d.tombstoned_at IS NULL
          AND (k.search_vector @@ websearch_to_tsquery('english',$3) OR k.identifiers @> ARRAY[$4]::text[])
      ), documents AS (
        SELECT DISTINCT ON (document_id) * FROM matches ORDER BY document_id,exact_match DESC,rank DESC,ordinal
      ) SELECT * FROM documents ORDER BY exact_match DESC,rank DESC,document_id,ordinal LIMIT 100 OFFSET $5`,
                [actor.membershipId, actor.userId, input.query, normalizeIdentifier(input.query), offset],
              )
            ).rows,
          );
        for (const row of rows) {
          const citation = citationSchema.parse({
            kind: 'knowledge-document',
            workspaceId,
            sourceId: row.source_id,
            documentId: row.document_id,
            revisionId: row.revision_id,
            publicationId: row.publication_id,
            accessEpoch: row.access_epoch,
            ordinal: row.ordinal,
          });
          try {
            await store.eligible(tx, actor, citation);
            const location = knowledgeLocationOf(row.source_offset);
            hits.push({
              title: row.title,
              text: row.passage,
              heading: row.heading,
              citation,
              ...(location ? { location } : {}),
            });
            if (hits.length === 20) break;
          } catch (error) {
            if (!hidden(error)) throw error;
          }
        }
        if (rows.length < 100) break;
      }
      await finalDocuments(
        tx,
        actor,
        hits.map(hit => hit.citation.documentId),
      );
      for (const hit of hits) await store.eligible(tx, actor, hit.citation);
      const gapped = await gappedPublications(
        tx,
        hits.map(hit => hit.citation.publicationId),
      );
      for (const hit of hits) if (gapped.has(hit.citation.publicationId)) hit.coverageGaps = true;
      return {
        mode: 'keyword-only',
        reason: 'semantic-not-enabled',
        hits,
        validUntil: new Date((await clock(tx)).getTime() + knowledgeLimits.permissionAgeMs).toISOString(),
      } satisfies { mode: 'keyword-only'; reason: 'semantic-not-enabled'; hits: typeof hits; validUntil: string };
    });
  }
  async function evidence(workspaceId: string, userId: string, value: unknown) {
    const citation = citationSchema.parse(value);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const { revision } = await store.eligible(tx, actor, citation);
      await localRevision(tx, actor, revision.id);
      const chunk = z
        .object({ heading: z.string(), passage: z.string(), source_offset: z.unknown() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT heading,passage,source_offset FROM ${table(tx, 'chunks')} WHERE publication_id=$1 AND ordinal=$2`,
              [citation.publicationId, citation.ordinal],
            )
          ).rows[0],
        );
      if (!chunk) throw new AccessDenied();
      await store.eligible(tx, actor, citation);
      const original: { kind: 'file'; fileId: string } | { kind: 'note' } =
        revision.original.kind === 'file' ? { kind: 'file', fileId: revision.original.fileId } : { kind: 'note' };
      const location = knowledgeLocationOf(chunk.source_offset);
      const gapped = await gappedPublications(tx, [citation.publicationId]);
      return {
        title: revision.title,
        text: chunk.passage,
        heading: chunk.heading,
        citation,
        ...(location ? { location } : {}),
        ...(gapped.size ? { coverageGaps: true } : {}),
        original,
        validUntil: new Date((await clock(tx)).getTime() + knowledgeLimits.permissionAgeMs).toISOString(),
      };
    });
  }
  async function original(workspaceId: string, userId: string, documentId: string, expectedRevisionId?: string) {
    documentId = uuidSchema.parse(documentId);
    expectedRevisionId = uuidSchema.optional().parse(expectedRevisionId);
    const captured = await transaction(workspaceId, userId, false, async (tx, actor) => {
      const ctx = await context(tx, actor, documentId);
      if (expectedRevisionId !== undefined && ctx.revision.id !== expectedRevisionId)
        throw new KnowledgeError('superseded');
      return {
        ...ctx,
        actor,
        bytes: ctx.revision.original.kind === 'object' ? await noteBytes(tx, ctx.revision) : null,
      };
    });
    const bytes =
      captured.revision.original.kind === 'file'
        ? (await files.download(workspaceId, userId, captured.revision.original.fileId)).bytes
        : captured.bytes;
    if (
      !bytes ||
      bytes.byteLength !== captured.revision.original.bytes ||
      digest(bytes) !== captured.revision.original.sha256
    )
      throw new KnowledgeError('integrity');
    return transaction(workspaceId, captured.actor, false, async (tx, actor) => {
      const current = await context(tx, actor, documentId);
      if (current.revision.id !== captured.revision.id) throw new KnowledgeError('superseded');
      return { bytes, filename: captured.local.filename, mediaType: captured.local.media_type };
    });
  }
  async function command(workspaceId: string, userId: string, value: unknown, action: 'retry' | 'remove') {
    denyMcpEgress();
    const input = knowledgeCommandSchema.parse(value);
    const fingerprint = digest(JSON.stringify({ action, ...input }));
    return transaction(workspaceId, userId, true, async (tx, actor) => {
      await localRevision(tx, actor, input.expectedRevisionId);
      const replay = z
        .object({ fingerprint: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT fingerprint FROM ${table(tx, 'commands')} WHERE command_id=$1`, [
              input.commandId,
            ])
          ).rows[0],
        );
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
        return input;
      }
      if ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'revisions')} WHERE id=$1`, [input.commandId])).rowCount)
        throw new KnowledgeError('conflict');
      const ctx = await context(tx, actor, input.documentId);
      if (ctx.revision.id !== input.expectedRevisionId) throw new KnowledgeError('conflict');
      if (action === 'remove') {
        await tx.client.query(
          `UPDATE ${table(tx, 'documents')} SET tombstoned_at=clock_timestamp(),retain_until=clock_timestamp()+interval '30 days',lexical_publication_id=NULL,vector_publication_id=NULL WHERE id=$1`,
          [input.documentId],
        );
        if (ctx.doc.tombstoned_at === null)
          await recordRecommendationChange(tx, {
            id: randomUUID(),
            kind: 'knowledge',
            sourceId: input.documentId,
            membershipIds: [actor.membershipId],
            invalidate: true,
          });
      } else {
        await store.source(tx, actor, ctx.source.id, true);
        const work = workRow.parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'work')} WHERE revision_id=$1`, [input.expectedRevisionId]))
            .rows[0],
        );
        if (!retryable(work)) throw new KnowledgeError('conflict');
        await tx.client.query(`UPDATE ${table(tx, 'work')} SET parsing='queued',failure=NULL WHERE revision_id=$1`, [
          input.expectedRevisionId,
        ]);
      }
      await tx.client.query(
        `UPDATE ${table(tx, 'jobs')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,dispatched_at=NULL,dispatch_after=clock_timestamp() WHERE revision_id=$1`,
        [input.expectedRevisionId],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'commands')} (command_id,revision_id,action,fingerprint) VALUES ($1,$2,$3,$4)`,
        [input.commandId, input.expectedRevisionId, action, fingerprint],
      );
      return input;
    });
  }
  async function retry(workspaceId: string, userId: string, value: unknown) {
    const input = await command(workspaceId, userId, value, 'retry');
    return get(workspaceId, userId, input.documentId);
  }
  async function remove(workspaceId: string, userId: string, value: unknown) {
    const input = await command(workspaceId, userId, value, 'remove');
    return { documentId: input.documentId, revisionId: input.expectedRevisionId, removed: true } satisfies {
      documentId: string;
      revisionId: string;
      removed: true;
    };
  }

  async function jobTransaction<T>(workspaceId: string, operation: (tx: Transaction) => Promise<T>) {
    return runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async raw => {
      const tx = store.bind(raw);
      await lockAuthorization(tx, 'write');
      return operation(tx);
    });
  }
  async function due(workspaceId: string): Promise<KnowledgeWork[]> {
    const available = recognitionAvailable ? await recognitionAvailable(workspaceId) : false;
    return jobTransaction(workspaceId, async tx => {
      if (available) await requeueLocalRecognition(tx, mediaLimitsForStorage.sweepBatch);
      await tx.client
        .query(`UPDATE ${table(tx, 'work')} w SET parsing=CASE WHEN w.attempts>=8 THEN 'failed' ELSE 'queued' END,failure=CASE WHEN w.attempts>=8 THEN 'provider' ELSE NULL END
        FROM ${table(tx, 'jobs')} j WHERE w.revision_id=j.revision_id AND w.parsing='parsing' AND j.lease_until<=clock_timestamp()`);
      await tx.client.query(
        `UPDATE ${table(tx, 'jobs')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,dispatched_at=NULL,dispatch_after=clock_timestamp() WHERE lease_until<=clock_timestamp()`,
      );
      await tx.client
        .query(`UPDATE ${table(tx, 'jobs')} j SET generation=generation+1,dispatched_at=NULL FROM ${table(tx, 'work')} w
        WHERE w.revision_id=j.revision_id AND w.parsing='queued' AND j.lease_token IS NULL AND j.dispatched_at IS NOT NULL AND j.dispatch_after<=clock_timestamp()`);
      const rows = z.array(z.object({ revision_id: uuidSchema, generation: z.number().int() })).parse(
        (
          await tx.client.query(`SELECT j.revision_id,j.generation FROM ${table(tx, 'jobs')} j
        JOIN ${table(tx, 'work')} w ON w.revision_id=j.revision_id JOIN ${table(tx, 'revisions')} r ON r.id=j.revision_id
        JOIN ${table(tx, 'documents')} d ON d.id=r.document_id JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
        JOIN ${table(tx, 'local_revisions')} l ON l.revision_id=r.id JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=l.owner_membership_id AND m.user_id=l.owner_user_id
        WHERE w.parsing='queued' AND w.attempts<8 AND j.dispatch_after<=clock_timestamp() AND j.lease_token IS NULL
          AND d.observed_revision_id=r.id AND d.tombstoned_at IS NULL AND s.state='active' AND m.removed_at IS NULL
        ORDER BY j.dispatch_after,j.revision_id LIMIT 100`)
        ).rows,
      );
      return rows.map(row => ({ workspaceId, revisionId: row.revision_id, generation: row.generation }));
    });
  }
  async function acknowledge(value: KnowledgeWork) {
    const work = knowledgeWorkSchema.parse(value);
    return jobTransaction(work.workspaceId, async tx => {
      const result = await tx.client.query(
        `UPDATE ${table(tx, 'jobs')} SET dispatched_at=COALESCE(dispatched_at,clock_timestamp()),dispatch_after=CASE WHEN dispatched_at IS NULL THEN clock_timestamp()+interval '1 minute' ELSE dispatch_after END WHERE revision_id=$1 AND generation=$2 AND lease_token IS NULL`,
        [work.revisionId, work.generation],
      );
      return { acknowledged: result.rowCount === 1 };
    });
  }
  async function process(
    value: KnowledgeWork,
  ): Promise<{ disposition: 'ready' | 'failed' | 'retry' | 'busy' | 'stale' }> {
    denyMcpEgress();
    const work = knowledgeWorkSchema.parse(value);
    const token = randomUUID();
    const claim = await jobTransaction(work.workspaceId, async tx => {
      const job = jobRow
        .optional()
        .parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'jobs')} WHERE revision_id=$1`, [work.revisionId])).rows[0],
        );
      if (!job || job.generation !== work.generation) return 'stale';
      const state = workRow.parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'work')} WHERE revision_id=$1`, [work.revisionId])).rows[0],
      );
      if (state.parsing === 'ready') return 'ready';
      if (job.lease_token) return 'busy';
      if (state.parsing !== 'queued' || state.attempts >= 8) return 'failed';
      const local = localRow.parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'local_revisions')} WHERE revision_id=$1`, [work.revisionId]))
          .rows[0],
      );
      const actor: HumanActor = { kind: 'human', userId: local.owner_user_id, membershipId: local.owner_membership_id };
      try {
        await currentMember(tx, actor);
      } catch (error) {
        if (hidden(error)) return 'stale';
        throw error;
      }
      const revision = store.revisionRow.parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [work.revisionId])).rows[0],
      );
      let sourceId: string;
      try {
        const ctx = await context(tx, actor, revision.document_id);
        if (ctx.revision.id !== work.revisionId || ctx.source.state !== 'active') return 'stale';
        sourceId = ctx.source.id;
      } catch (error) {
        if (!hidden(error)) throw error;
        await tx.client.query(
          `UPDATE ${table(tx, 'work')} SET parsing='failed',failure='provider' WHERE revision_id=$1`,
          [work.revisionId],
        );
        return 'stale';
      }
      await tx.client.query(
        `UPDATE ${table(tx, 'jobs')} SET lease_token=$2,lease_until=clock_timestamp()+interval '5 minutes' WHERE revision_id=$1`,
        [work.revisionId, token],
      );
      await tx.client.query(
        `UPDATE ${table(tx, 'work')} SET parsing='parsing',attempts=attempts+1,failure=NULL WHERE revision_id=$1`,
        [work.revisionId],
      );
      return { actor, revision, local, sourceId };
    });
    if (typeof claim === 'string') return { disposition: z.enum(['stale', 'ready', 'busy', 'failed']).parse(claim) };
    try {
      const content = await original(work.workspaceId, claim.actor.userId, claim.revision.document_id);
      if (
        content.bytes.byteLength !== claim.revision.original.bytes ||
        digest(content.bytes) !== claim.revision.original.sha256
      )
        throw new KnowledgeError('superseded');
      const parsed = await parseKnowledgeDocument(
        content,
        await recognitionOptions(runtime, recognition, {
          workspaceId: work.workspaceId,
          sourceId: claim.sourceId,
          documentId: claim.revision.document_id,
          revisionId: work.revisionId,
          membershipId: claim.actor.membershipId,
        }),
      );
      return await transaction(work.workspaceId, claim.actor, true, async (tx, actor) => {
        const owned = await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'jobs')} WHERE revision_id=$1 AND generation=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
          [work.revisionId, work.generation, token],
        );
        if (!owned.rowCount) return { disposition: 'stale' };
        const publicationId = identity(publicationSeed('', work.revisionId, parsed));
        const publication = lexicalInput.parse({
          id: publicationId,
          documentId: claim.revision.document_id,
          revisionId: work.revisionId,
          markdown: parsed.markdown,
          pages: parsed.pages,
          tokens: parsed.tokens,
          chunks: parsed.chunks,
        });
        await store.publish(tx, actor, publication, { filename: claim.local.filename });
        await recordParse(tx, publicationId, parsed);
        const finished = await tx.client.query(
          `UPDATE ${table(tx, 'jobs')} SET lease_token=NULL,lease_until=NULL WHERE revision_id=$1 AND generation=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
          [work.revisionId, work.generation, token],
        );
        if (!finished.rowCount) throw new KnowledgeError('superseded');
        return { disposition: 'ready' };
      });
    } catch (error) {
      const failure = recognitionFailed(error)
        ? 'provider'
        : error instanceof KnowledgeParseError
          ? error.failure
          : error instanceof KnowledgeError && error.code === 'quota'
            ? 'resource-limited'
            : (error instanceof KnowledgeError && error.code === 'integrity') ||
                (error instanceof FileError && error.code === 'integrity')
              ? 'malformed'
              : 'provider';
      return jobTransaction(work.workspaceId, async tx => {
        const job = await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'jobs')} WHERE revision_id=$1 AND generation=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
          [work.revisionId, work.generation, token],
        );
        if (!job.rowCount) return { disposition: 'stale' };
        const state = workRow.parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'work')} WHERE revision_id=$1`, [work.revisionId])).rows[0],
        );
        const stale =
          hidden(error) || (error instanceof KnowledgeError && ['superseded', 'conflict'].includes(error.code));
        // Provider and transient parser failures retry with exponential backoff until the attempt bound.
        const again = (failure === 'provider' || transientParseFailure(error)) && state.attempts < 8 && !stale;
        // A re-parse that fails for good leaves the revision's earlier publication in place.
        const published = z
          .object({ id: uuidSchema.nullable() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT d.lexical_publication_id AS id FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'publications')} p
                  ON p.id=d.lexical_publication_id AND p.revision_id=$1 WHERE d.observed_revision_id=$1`,
                [work.revisionId],
              )
            ).rows[0],
          )?.id;
        await tx.client.query(`UPDATE ${table(tx, 'work')} SET parsing=$2,failure=$3 WHERE revision_id=$1`, [
          work.revisionId,
          again ? 'queued' : published ? 'ready' : failure === 'ocr-required' ? 'ocr-unavailable' : 'failed',
          again || !published ? failure : null,
        ]);
        await tx.client.query(
          `UPDATE ${table(tx, 'jobs')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,dispatched_at=NULL,dispatch_after=clock_timestamp()+least(interval '1 hour',interval '30 seconds'*power(2,greatest($2::int-1,0))) WHERE revision_id=$1`,
          [work.revisionId, state.attempts],
        );
        return { disposition: stale ? 'stale' : again ? 'retry' : 'failed' };
      });
    }
  }
  async function settings(workspaceId: string, userId: string) {
    return transaction(workspaceId, userId, false, (tx, actor) => readKnowledgeSettings(tx, actor));
  }
  async function updateSettings(workspaceId: string, userId: string, value: unknown) {
    const available = recognitionAvailable ? await recognitionAvailable(workspaceId) : true;
    return transaction(workspaceId, userId, true, async (tx, actor) => {
      const changed = await writeKnowledgeSettings(tx, actor, value);
      if (changed.turnedOn) {
        await resetRecognitionRetries(tx);
        if (available) await requeueLocalRecognition(tx, mediaLimitsForStorage.enableBatch);
      }
      return readKnowledgeSettings(tx, actor);
    });
  }
  return {
    save,
    list,
    get,
    search,
    evidence,
    original,
    retry,
    remove,
    due,
    acknowledge,
    process,
    settings,
    updateSettings,
  };
}
