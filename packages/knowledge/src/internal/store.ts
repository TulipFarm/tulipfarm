import { createHash, randomUUID } from 'node:crypto';
import {
  invalidateRecommendationSource,
  recordRecommendationChange,
} from '@tulipfarm/workspace-storage/recommendations';
import { z } from 'zod';
import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  actorSchema,
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  protectedSourceClosure,
  requireNoMcpDerived,
  requireProtectedSource,
  resolveHuman,
  sourceDependenciesSchema,
  uuidSchema,
  type Actor,
  type AuthorizationTransaction,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { requireReadableFile } from '@tulipfarm/files';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  citationSchema,
  knowledgeLimits,
  KnowledgeError,
  lexicalInput,
  originalSchema,
  proofInput,
  revisionInput,
  sourceInput,
  type KnowledgeCitation,
} from './contracts.ts';
import { exactIdentifiers } from './identifiers.ts';
import { requireConversationReader, requireConversationRevision } from './conversation-authority.ts';

type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type Transaction = AuthorizationTransaction & { workspaceId: string; commonVersion: number };
type Dependency = Extract<SourceDependency, { kind: 'knowledge-document' }>;
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceRow = z.object({
  id: uuidSchema,
  provider: sourceInput.shape.provider,
  owner_membership_id: uuidSchema,
  account_namespace: z.string(),
  selection: z.string(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  access_epoch: z.number().int().positive(),
});
const documentRow = z.object({
  id: uuidSchema,
  source_id: uuidSchema,
  native_id: z.string(),
  observed_revision_id: uuidSchema.nullable(),
  lexical_publication_id: uuidSchema.nullable(),
  vector_publication_id: uuidSchema.nullable(),
  tombstoned_at: z.date().nullable(),
});
const revisionRow = z.object({
  id: uuidSchema,
  document_id: uuidSchema,
  title: z.string(),
  canonical_url: z.string().nullable(),
  original: originalSchema,
  sources: sourceDependenciesSchema,
  fingerprint: z.string(),
});
export type ExternalSource = z.infer<typeof sourceRow>;

export async function requireTaskRun(tx: AuthorizationTransaction, actor: HumanActor, runId: string) {
  const runs = qualified(tx.schema, 'tf_agent_task_runs');
  if (
    !z
      .object({ installed: z.boolean() })
      .parse((await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [runs])).rows[0]).installed
  )
    throw new AccessDenied();
  const bound = await tx.client.query(
    `SELECT 1 FROM ${runs} b JOIN ${qualified(tx.schema, 'tf_agent_tasks')} t ON t.id=b.task_id AND t.generation=b.generation
    WHERE b.run_id=$1 AND t.owner_membership_id=$2 AND t.owner_user_id=$3`,
    [uuidSchema.parse(runId), actor.membershipId, actor.userId],
  );
  if (!bound.rowCount) throw new AccessDenied();
}
export type KnowledgeOptions = {
  runtime: Runtime;
  requireExternalSource?: (tx: AuthorizationTransaction, actor: HumanActor, source: ExternalSource) => Promise<void>;
  requireExternalProof?: (tx: AuthorizationTransaction, actor: HumanActor, documentId: string) => Promise<void>;
  refreshExternalProof?: (input: {
    workspaceId: string;
    actor: HumanActor;
    source: ExternalSource;
    documentId: string;
    nativeId: string;
    accessEpoch: number;
  }) => Promise<z.infer<typeof proofInput>>;
};

export function createKnowledgeStore({
  runtime,
  requireExternalSource,
  requireExternalProof,
  refreshExternalProof,
}: KnowledgeOptions) {
  async function transaction<T>(
    workspaceId: string,
    actorInput: Actor | string,
    write: boolean,
    operation: (tx: Transaction, actor: HumanActor) => Promise<T>,
    options: { deadlineAt?: number; signal?: AbortSignal | undefined } = {},
  ) {
    options.signal?.throwIfAborted();
    return runtime.transaction(
      uuidSchema.parse(workspaceId),
      { ...commonCompatibility, ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }) },
      async tx => {
        options.signal?.throwIfAborted();
        await lockAuthorization(tx, write ? 'write' : 'read');
        const actor =
          typeof actorInput === 'string' ? await resolveHuman(tx, actorInput) : actorSchema.parse(actorInput);
        if (actor.kind !== 'human') throw new AccessDenied();
        await currentMember(tx, actor);
        const bound = bind(tx);
        const result = await operation(bound, actor);
        options.signal?.throwIfAborted();
        return result;
      },
    );
  }

  async function source(tx: Transaction, actor: HumanActor, id: string, writing = false) {
    const value = sourceRow
      .optional()
      .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'sources')} WHERE id=$1`, [id])).rows[0]);
    if (!value || ['removed', 'disconnected'].includes(value.state)) throw new AccessDenied();
    if (
      value.provider !== 'conversation' &&
      (writing || !['google', 'slack', 'github', 'confluence', 'jira'].includes(value.provider)) &&
      value.owner_membership_id !== actor.membershipId
    )
      throw new AccessDenied();
    if (writing && value.state !== 'active') throw new KnowledgeError('conflict');
    if (value.provider === 'conversation') await requireConversationReader(tx, actor, value.id);
    else if (value.provider !== 'note' && value.provider !== 'file') {
      if (!requireExternalSource) throw new KnowledgeError('adapter-required');
      await requireExternalSource(tx, actor, value);
    }
    return value;
  }

  async function document(tx: Transaction, id: string) {
    const value = documentRow
      .optional()
      .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'documents')} WHERE id=$1`, [id])).rows[0]);
    if (!value || value.tombstoned_at) throw new AccessDenied();
    return value;
  }

  async function dependencies(tx: Transaction, actor: HumanActor, revision: z.infer<typeof revisionRow>) {
    if (revision.original.kind === 'file') {
      const file = await requireReadableFile(tx, actor, revision.original.fileId);
      if (file.sha256 !== revision.original.sha256 || file.size !== revision.original.bytes) throw new AccessDenied();
    }
    const closure = await protectedSourceClosure(tx, revision.sources);
    for (const dependency of closure) {
      // The closure already contains every dependency. Re-entering eligible's closure
      // here would recurse forever on corrupt/cyclic retained citations.
      if (dependency.kind === 'knowledge-document') await eligible(tx, actor, dependency, false);
      else await requireProtectedSource(tx, actor, dependency);
    }
  }

  async function requireProof(
    tx: Transaction,
    actor: HumanActor,
    doc: z.infer<typeof documentRow>,
    origin: ExternalSource,
  ) {
    if (origin.provider === 'note' || origin.provider === 'file') return;
    if (origin.provider === 'conversation') {
      if (!doc.observed_revision_id) throw new AccessDenied();
      await requireConversationRevision(tx, actor, doc.observed_revision_id);
      return;
    }
    if (requireExternalProof) await requireExternalProof(tx, actor, doc.id);
    const proof = await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'access_proofs')}
      WHERE document_id=$1 AND membership_id=$2 AND access_epoch=$3
        AND acl_checked_at<=clock_timestamp() AND membership_checked_at<=clock_timestamp()
        AND expires_at>clock_timestamp()`,
      [doc.id, actor.membershipId, origin.access_epoch],
    );
    if (!proof.rowCount) throw new KnowledgeError('permission-expired');
  }

  async function eligible(tx: Transaction, actor: HumanActor, dependency: Dependency, checkDependencies = true) {
    if (dependency.workspaceId !== tx.workspaceId) throw new AccessDenied();
    const doc = await document(tx, dependency.documentId);
    const origin = await source(tx, actor, doc.source_id);
    if (origin.id !== dependency.sourceId || origin.access_epoch !== dependency.accessEpoch) throw new AccessDenied();
    if (doc.observed_revision_id !== dependency.revisionId || doc.lexical_publication_id !== dependency.publicationId)
      throw new KnowledgeError('superseded');
    const revision = revisionRow.parse(
      (
        await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1 AND document_id=$2`, [
          dependency.revisionId,
          doc.id,
        ])
      ).rows[0],
    );
    await dependencies(tx, actor, checkDependencies ? revision : { ...revision, sources: [] });
    await requireProof(tx, actor, doc, origin);
    return { doc, origin, revision };
  }

  function bind<X extends Transaction>(tx: X): X {
    const bound: X = { ...tx };
    bound.knowledgeSourceDependencies = async dependency => {
      if (dependency.workspaceId !== tx.workspaceId) throw new AccessDenied();
      const row = (
        await tx.client.query(
          `SELECT r.sources FROM ${table(tx, 'revisions')} r
        JOIN ${table(tx, 'documents')} d ON d.id=r.document_id
        JOIN ${table(tx, 'publications')} p ON p.document_id=d.id AND p.revision_id=r.id
        WHERE r.id=$1 AND d.id=$2 AND d.source_id=$3 AND p.id=$4`,
          [dependency.revisionId, dependency.documentId, dependency.sourceId, dependency.publicationId],
        )
      ).rows[0];
      if (!row) throw new AccessDenied();
      return sourceDependenciesSchema.parse(row.sources);
    };
    // A run reads with its requester's authority only while bound to that requester's current task.
    // Public delivery is checked per audience reader by the caller; each reader must be eligible.
    bound.requireKnowledgeSource = async (actor, dependency, context) => {
      await currentMember(bound, actor);
      if (context.runId) await requireTaskRun(bound, actor, context.runId);
      try {
        await eligible(bound, actor, dependency);
      } catch (error) {
        if (error instanceof KnowledgeError) throw new AccessDenied();
        throw error;
      }
    };
    return bound;
  }

  async function configureSource(workspaceId: string, actor: Actor, value: unknown) {
    denyMcpEgress();
    const input = sourceInput.parse(value);
    if (input.provider === 'conversation') throw new AccessDenied();
    return transaction(workspaceId, actor, true, async (tx, human) => {
      const existing = sourceRow
        .optional()
        .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'sources')} WHERE id=$1`, [input.id])).rows[0]);
      if (existing) {
        if (existing.owner_membership_id !== human.membershipId) throw new AccessDenied();
        if (
          existing.provider !== input.provider ||
          existing.account_namespace !== input.accountNamespace ||
          existing.selection !== input.selection ||
          existing.state === 'removed'
        )
          throw new KnowledgeError('conflict');
        return { id: existing.id, accessEpoch: existing.access_epoch };
      }
      const count = z
        .object({ count: z.number() })
        .parse((await tx.client.query(`SELECT count(*)::int AS count FROM ${table(tx, 'sources')}`)).rows[0]);
      if (count.count >= knowledgeLimits.sources) throw new KnowledgeError('quota');
      await tx.client.query(
        `INSERT INTO ${table(tx, 'sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,$2,$3,$4,$5)`,
        [input.id, input.provider, input.accountNamespace, input.selection, human.membershipId],
      );
      return { id: input.id, accessEpoch: 1 };
    });
  }

  async function observeRevision(workspaceId: string, actor: Actor, value: unknown) {
    denyMcpEgress();
    const input = revisionInput.parse(value);
    return transaction(workspaceId, actor, true, (tx, human) => observe(tx, human, input));
  }

  async function observe(
    tx: Transaction,
    human: HumanActor,
    input: z.infer<typeof revisionInput>,
    conversation = false,
  ) {
    const fingerprint = hash(JSON.stringify(conversation ? { ...input, expectedRevisionId: null } : input));
    const prior = documentRow
      .optional()
      .parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'documents')} WHERE id=$1`, [input.documentId])).rows[0],
      );
    if (prior) {
      await source(tx, human, prior.source_id);
      if (prior.observed_revision_id && !conversation) {
        const revision = revisionRow.parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [prior.observed_revision_id]))
            .rows[0],
        );
        await dependencies(tx, human, revision);
      }
    } else if (input.expectedRevisionId !== null) throw new AccessDenied();
    const origin = await source(tx, human, input.sourceId, true);
    if ((origin.provider === 'conversation') !== conversation) throw new AccessDenied();
    if ((origin.provider === 'file') !== (input.original.kind === 'file')) throw new KnowledgeError('conflict');
    await requireNoMcpDerived(tx, input.sources);
    const closure = await protectedSourceClosure(tx, input.sources);
    if (
      !conversation &&
      closure.some(item =>
        ['github-personal', 'private-task', 'private-conversation', 'knowledge-document'].includes(item.kind),
      )
    )
      throw new AccessDenied();
    if (
      conversation &&
      closure.some(item => item.kind === 'knowledge-document' && item.documentId === input.documentId)
    )
      throw new AccessDenied();
    await dependencies(tx, human, {
      ...input,
      document_id: input.documentId,
      canonical_url: input.canonicalUrl,
      fingerprint,
    });
    const replay = revisionRow
      .optional()
      .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [input.id])).rows[0]);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
      const current = await document(tx, input.documentId);
      if (current.observed_revision_id !== input.id) throw new KnowledgeError('superseded');
      return { documentId: input.documentId, revisionId: input.id, accessEpoch: origin.access_epoch };
    }
    if (prior && (prior.source_id !== input.sourceId || prior.native_id !== input.nativeId || prior.tombstoned_at))
      throw new KnowledgeError('conflict');
    if ((prior?.observed_revision_id ?? null) !== input.expectedRevisionId) throw new KnowledgeError('conflict');
    const usage = z.object({ documents: z.number(), revisions: z.number(), bytes: z.coerce.number() }).parse(
      (
        await tx.client.query(
          `SELECT
        (SELECT count(*)::int FROM ${table(tx, 'documents')}) AS documents,
        (SELECT count(*)::int FROM ${table(tx, 'revisions')} WHERE document_id=$1) AS revisions,
        (SELECT COALESCE(sum(original_bytes),0) FROM ${table(tx, 'revisions')}) +
        (SELECT COALESCE(sum(octet_length(normalized_content)),0) FROM ${table(tx, 'google_originals')}) +
        (SELECT COALESCE(sum(octet_length(markdown)),0) FROM ${table(tx, 'publications')}) +
        (SELECT COALESCE(sum(octet_length(passage)+octet_length(heading)),0) FROM ${table(tx, 'chunks')}) AS bytes`,
          [input.documentId],
        )
      ).rows[0],
    );
    if (
      (!prior && usage.documents >= knowledgeLimits.documents) ||
      usage.revisions >= knowledgeLimits.revisionsPerDocument ||
      usage.bytes + input.original.bytes > knowledgeLimits.retainedBytes
    )
      throw new KnowledgeError('quota');
    if (!prior)
      await tx.client.query(`INSERT INTO ${table(tx, 'documents')} (id,source_id,native_id) VALUES ($1,$2,$3)`, [
        input.documentId,
        input.sourceId,
        input.nativeId,
      ]);
    await tx.client.query(
      `INSERT INTO ${table(tx, 'revisions')} (id,document_id,source_revision,title,canonical_url,original,original_bytes,parser_profile,sources,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.id,
        input.documentId,
        input.sourceRevision,
        input.title,
        input.canonicalUrl,
        input.original,
        input.original.bytes,
        input.parserProfile,
        JSON.stringify(input.sources),
        fingerprint,
      ],
    );
    await tx.client.query(`INSERT INTO ${table(tx, 'work')} (revision_id) VALUES ($1)`, [input.id]);
    await tx.client.query(
      `UPDATE ${table(tx, 'documents')} SET observed_revision_id=$2,lexical_publication_id=NULL,vector_publication_id=NULL WHERE id=$1`,
      [input.documentId, input.id],
    );
    if (prior?.observed_revision_id && (origin.provider === 'note' || origin.provider === 'file')) {
      await invalidateRecommendationSource(tx, input.documentId);
    }
    return { documentId: input.documentId, revisionId: input.id, accessEpoch: origin.access_epoch };
  }

  async function publishLexical(workspaceId: string, actor: Actor, value: unknown) {
    denyMcpEgress();
    const input = lexicalInput.parse(value);
    return transaction(workspaceId, actor, true, (tx, human) => publish(tx, human, input));
  }

  async function publish(
    tx: Transaction,
    human: HumanActor,
    input: z.infer<typeof lexicalInput>,
    local?: { filename: string },
  ) {
    const fingerprint = hash(JSON.stringify(input));
    const doc = await document(tx, input.documentId);
    const origin = await source(tx, human, doc.source_id, true);
    if (doc.observed_revision_id !== input.revisionId) throw new KnowledgeError('superseded');
    if (origin.provider === 'conversation') {
      if (!local) throw new AccessDenied();
      await requireConversationRevision(tx, human, input.revisionId, true);
    }
    await requireProof(tx, human, doc, origin);
    const revision = revisionRow.parse(
      (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [input.revisionId])).rows[0],
    );
    await dependencies(tx, human, revision);
    const work = z
      .object({ parsing: z.string() })
      .parse(
        (await tx.client.query(`SELECT parsing FROM ${table(tx, 'work')} WHERE revision_id=$1`, [input.revisionId]))
          .rows[0],
      );
    if (work.parsing === 'ocr-unavailable') throw new KnowledgeError('incomplete');
    const existing = z
      .object({ fingerprint: z.string() })
      .optional()
      .parse(
        (await tx.client.query(`SELECT fingerprint FROM ${table(tx, 'publications')} WHERE id=$1`, [input.id])).rows[0],
      );
    if (existing && existing.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
    if (!existing) {
      const usage = z.object({ publications: z.number(), chunks: z.number(), bytes: z.coerce.number() }).parse(
        (
          await tx.client.query(
            `SELECT
          (SELECT count(*)::int FROM ${table(tx, 'publications')} WHERE revision_id=$1) AS publications,
          (SELECT count(*)::int FROM ${table(tx, 'chunks')}) AS chunks,
          (SELECT COALESCE(sum(original_bytes),0) FROM ${table(tx, 'revisions')}) +
          (SELECT COALESCE(sum(octet_length(normalized_content)),0) FROM ${table(tx, 'google_originals')}) +
          (SELECT COALESCE(sum(octet_length(markdown)),0) FROM ${table(tx, 'publications')}) +
          (SELECT COALESCE(sum(octet_length(passage)+octet_length(heading)),0) FROM ${table(tx, 'chunks')}) AS bytes`,
            [input.revisionId],
          )
        ).rows[0],
      );
      const chunkBytes = input.chunks.reduce(
        (sum, chunk) => sum + Buffer.byteLength(chunk.text) + Buffer.byteLength(chunk.heading),
        0,
      );
      if (
        usage.publications >= knowledgeLimits.publicationsPerRevision ||
        usage.chunks + input.chunks.length > knowledgeLimits.retainedChunks ||
        usage.bytes + Buffer.byteLength(input.markdown) + chunkBytes > knowledgeLimits.retainedBytes
      )
        throw new KnowledgeError('quota');
      await tx.client.query(
        `INSERT INTO ${table(tx, 'publications')} (id,document_id,revision_id,markdown,pages,tokens,chunk_count,fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.id,
          input.documentId,
          input.revisionId,
          input.markdown,
          input.pages,
          input.tokens,
          input.chunks.length,
          fingerprint,
        ],
      );
      for (const [ordinal, chunk] of input.chunks.entries()) {
        const values = [
          input.id,
          ordinal,
          chunk.heading,
          chunk.text,
          chunk.tokens,
          chunk.offset,
          hash(`${chunk.heading}\n${chunk.text}`),
        ];
        if (local)
          await tx.client.query(
            `INSERT INTO ${table(tx, 'chunks')} (publication_id,ordinal,heading,passage,tokens,source_offset,input_hash,search_title,identifiers) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              ...values,
              revision.title,
              exactIdentifiers(`${revision.title}\n${local.filename}\n${chunk.heading}\n${chunk.text}`),
            ],
          );
        else
          await tx.client.query(
            `INSERT INTO ${table(tx, 'chunks')} (publication_id,ordinal,heading,passage,tokens,source_offset,input_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            values,
          );
      }
    }
    await requireProof(tx, human, doc, origin);
    await tx.client.query(
      `UPDATE ${table(tx, 'documents')} SET lexical_publication_id=$2,vector_publication_id=CASE WHEN lexical_publication_id=$2 THEN vector_publication_id ELSE NULL END WHERE id=$1`,
      [doc.id, input.id],
    );
    await tx.client.query(`UPDATE ${table(tx, 'work')} SET parsing='ready',failure=NULL WHERE revision_id=$1`, [
      input.revisionId,
    ]);
    if (doc.lexical_publication_id !== input.id && (origin.provider === 'note' || origin.provider === 'file')) {
      await recordRecommendationChange(tx, {
        id: randomUUID(),
        kind: 'knowledge',
        sourceId: doc.id,
        membershipIds: [origin.owner_membership_id],
        invalidate: doc.lexical_publication_id !== null,
      });
    }
    return citationSchema.parse({
      kind: 'knowledge-document',
      workspaceId: tx.workspaceId,
      sourceId: origin.id,
      documentId: doc.id,
      revisionId: input.revisionId,
      publicationId: input.id,
      accessEpoch: origin.access_epoch,
      ordinal: 0,
    });
  }

  async function recordAccessProof(workspaceId: string, actor: Actor, value: unknown) {
    const request = z.strictObject({ documentId: uuidSchema, accessEpoch: z.number().int().positive() }).parse(value);
    if (!refreshExternalProof) throw new KnowledgeError('adapter-required');
    const context = await transaction(workspaceId, actor, false, async (tx, human) => {
      const doc = await document(tx, request.documentId);
      const origin = await source(tx, human, doc.source_id);
      if (origin.access_epoch !== request.accessEpoch) throw new AccessDenied();
      return {
        workspaceId,
        actor: human,
        source: origin,
        documentId: doc.id,
        nativeId: doc.native_id,
        accessEpoch: origin.access_epoch,
      };
    });
    let observation;
    try {
      observation = await refreshExternalProof(context);
    } catch (error) {
      if (error instanceof AccessDenied && !(error instanceof SourceAuthorizationUnavailable)) {
        await transaction(workspaceId, actor, true, async tx => {
          await tx.client.query(
            `UPDATE ${table(tx, 'sources')} SET access_epoch=access_epoch+1 WHERE id=$1 AND access_epoch=$2`,
            [context.source.id, context.accessEpoch],
          );
        });
      }
      throw error;
    }
    const input = proofInput.parse(observation);
    if (input.documentId !== request.documentId || input.accessEpoch !== request.accessEpoch) throw new AccessDenied();
    return transaction(workspaceId, actor, true, async (tx, human) => {
      const doc = await document(tx, input.documentId);
      const origin = await source(tx, human, doc.source_id);
      if (origin.access_epoch !== input.accessEpoch) throw new AccessDenied();
      const clock = z
        .object({ now: z.date() })
        .parse((await tx.client.query('SELECT clock_timestamp() AS now')).rows[0]).now;
      if (input.aclCheckedAt > clock || input.membershipCheckedAt > clock || input.expiresAt <= clock)
        throw new KnowledgeError('permission-expired');
      const result = await tx.client.query(
        `INSERT INTO ${table(tx, 'access_proofs')} (id,document_id,membership_id,access_epoch,principal,acl_version,membership_version,acl_checked_at,membership_checked_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (document_id,membership_id) DO UPDATE SET id=EXCLUDED.id,access_epoch=EXCLUDED.access_epoch,principal=EXCLUDED.principal,acl_version=EXCLUDED.acl_version,membership_version=EXCLUDED.membership_version,acl_checked_at=EXCLUDED.acl_checked_at,membership_checked_at=EXCLUDED.membership_checked_at,expires_at=EXCLUDED.expires_at
        WHERE EXCLUDED.acl_checked_at>=${table(tx, 'access_proofs')}.acl_checked_at AND EXCLUDED.membership_checked_at>=${table(tx, 'access_proofs')}.membership_checked_at`,
        [
          input.id,
          doc.id,
          human.membershipId,
          input.accessEpoch,
          input.principal,
          input.aclVersion,
          input.membershipVersion,
          input.aclCheckedAt,
          input.membershipCheckedAt,
          input.expiresAt,
        ],
      );
      if (!result.rowCount) throw new KnowledgeError('conflict');
      return { id: input.id };
    });
  }

  async function readEvidence(workspaceId: string, actor: Actor, value: unknown) {
    const citation = citationSchema.parse(value);
    return transaction(workspaceId, actor, false, async (tx, human) => {
      const { revision } = await eligible(tx, human, citation);
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
      await eligible(tx, human, citation);
      return {
        citation,
        title: revision.title,
        canonicalUrl: revision.canonical_url,
        heading: chunk.heading,
        text: chunk.passage,
        offset: chunk.source_offset,
      };
    });
  }

  async function status(workspaceId: string, actor: Actor, documentId: string) {
    return transaction(workspaceId, actor, false, async (tx, human) => {
      const doc = await document(tx, uuidSchema.parse(documentId));
      const origin = await source(tx, human, doc.source_id);
      await requireProof(tx, human, doc, origin);
      if (!doc.observed_revision_id) throw new KnowledgeError('incomplete');
      const revision = revisionRow.parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [doc.observed_revision_id]))
          .rows[0],
      );
      await dependencies(tx, human, revision);
      const work = z
        .object({ parsing: z.string(), embedding: z.string(), failure: z.string().nullable(), attempts: z.number() })
        .parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'work')} WHERE revision_id=$1`, [doc.observed_revision_id]))
            .rows[0],
        );
      await requireProof(tx, human, doc, origin);
      return {
        documentId: doc.id,
        revisionId: doc.observed_revision_id,
        publicationId: doc.lexical_publication_id,
        accessEpoch: origin.access_epoch,
        connectivity: origin.state,
        ...work,
      };
    });
  }

  async function recordFailure(workspaceId: string, actor: Actor, value: unknown) {
    const input = z
      .strictObject({
        documentId: uuidSchema,
        revisionId: uuidSchema,
        axis: z.enum(['parsing', 'embedding']),
        failure: z.enum([
          'unsupported',
          'encrypted',
          'malformed',
          'resource-limited',
          'ocr-required',
          'provider',
          'credits',
        ]),
      })
      .parse(value);
    return transaction(workspaceId, actor, true, async (tx, human) => {
      const doc = await document(tx, input.documentId);
      const origin = await source(tx, human, doc.source_id, true);
      if (origin.provider === 'conversation') await requireConversationRevision(tx, human, input.revisionId, true);
      if (doc.observed_revision_id !== input.revisionId) throw new KnowledgeError('superseded');
      if (input.axis === 'parsing' && doc.lexical_publication_id) throw new KnowledgeError('conflict');
      const result = await tx.client.query(
        input.axis === 'embedding'
          ? `UPDATE ${table(tx, 'work')} SET embedding=$2,failure=$3,attempts=attempts+1 WHERE revision_id=$1 AND attempts<8`
          : `UPDATE ${table(tx, 'work')} SET parsing=CASE WHEN parsing='ocr-unavailable' THEN parsing ELSE $2 END,failure=CASE WHEN parsing='ocr-unavailable' THEN failure ELSE $3 END,attempts=attempts+1 WHERE revision_id=$1 AND attempts<8`,
        [
          input.revisionId,
          input.axis === 'embedding'
            ? input.failure === 'credits'
              ? 'credits-blocked'
              : 'failed'
            : input.failure === 'ocr-required'
              ? 'ocr-unavailable'
              : 'failed',
          input.failure,
        ],
      );
      if (!result.rowCount) throw new KnowledgeError('quota');
      return { revisionId: input.revisionId };
    });
  }

  async function manageSource(
    workspaceId: string,
    actor: Actor,
    sourceId: string,
    action: 'pause' | 'resume' | 'invalidate' | 'disconnect' | 'remove',
  ) {
    sourceId = uuidSchema.parse(sourceId);
    action = z.enum(['pause', 'resume', 'invalidate', 'disconnect', 'remove']).parse(action);
    return transaction(workspaceId, actor, true, async (tx, human) => {
      const origin = sourceRow
        .optional()
        .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'sources')} WHERE id=$1`, [sourceId])).rows[0]);
      if (!origin || origin.provider === 'conversation' || origin.owner_membership_id !== human.membershipId)
        throw new AccessDenied();
      if (origin.state === 'removed' && action !== 'remove') throw new KnowledgeError('conflict');
      if (origin.state === 'disconnected' && ['pause', 'resume'].includes(action)) throw new KnowledgeError('conflict');
      if (action === 'remove') {
        await tx.client.query(
          `UPDATE ${table(tx, 'sources')} SET state='removed',access_epoch=access_epoch+1,removed_at=COALESCE(removed_at,clock_timestamp()),retain_until=COALESCE(retain_until,clock_timestamp()+interval '30 days') WHERE id=$1 AND state<>'removed'`,
          [sourceId],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'documents')} SET tombstoned_at=COALESCE(tombstoned_at,clock_timestamp()),retain_until=COALESCE(retain_until,clock_timestamp()+interval '30 days'),lexical_publication_id=NULL,vector_publication_id=NULL WHERE source_id=$1`,
          [sourceId],
        );
      } else if (action === 'invalidate' || action === 'disconnect') {
        await tx.client.query(
          `UPDATE ${table(tx, 'sources')} SET access_epoch=access_epoch+1,state=CASE WHEN $2='disconnect' THEN 'disconnected' ELSE state END WHERE id=$1`,
          [sourceId, action],
        );
      } else
        await tx.client.query(`UPDATE ${table(tx, 'sources')} SET state=$2 WHERE id=$1`, [
          sourceId,
          action === 'pause' ? 'paused' : 'active',
        ]);
      const next = {
        pause: 'paused',
        resume: 'active',
        disconnect: 'disconnected',
        remove: 'removed',
        invalidate: origin.state,
      }[action];
      if (action === 'invalidate' || origin.state !== next)
        await recordRecommendationChange(tx, {
          id: randomUUID(),
          kind: 'knowledge',
          sourceId,
          membershipIds: [origin.owner_membership_id],
          invalidate: action !== 'resume',
        });
      return { id: sourceId };
    });
  }

  async function validateDependencies(workspaceId: string, actor: Actor, values: readonly KnowledgeCitation[]) {
    const citations = z.array(citationSchema).max(100).parse(values);
    return transaction(workspaceId, actor, false, async (tx, human) => {
      const required: { documentId: string; accessEpoch: number }[] = [];
      for (const citation of citations) {
        const { doc, origin } = await eligible(tx, human, citation);
        if (origin.provider !== 'note' && origin.provider !== 'file' && origin.provider !== 'conversation')
          required.push({ documentId: doc.id, accessEpoch: origin.access_epoch });
      }
      const result = await tx.client.query(
        `WITH cutoff AS MATERIALIZED (SELECT clock_timestamp() AS at)
        SELECT NOT EXISTS (
          SELECT 1 FROM unnest($1::uuid[], $2::integer[]) AS required(document_id, access_epoch)
          CROSS JOIN cutoff
          WHERE NOT EXISTS (
            SELECT 1 FROM ${table(tx, 'access_proofs')} p
            WHERE p.document_id=required.document_id AND p.membership_id=$3 AND p.access_epoch=required.access_epoch
              AND p.acl_checked_at<=cutoff.at AND p.membership_checked_at<=cutoff.at AND p.expires_at>cutoff.at
          )
        ) AS allowed`,
        [required.map(proof => proof.documentId), required.map(proof => proof.accessEpoch), human.membershipId],
      );
      if (!z.object({ allowed: z.boolean() }).parse(result.rows[0]).allowed)
        throw new KnowledgeError('permission-expired');
    });
  }

  return {
    api: {
      configureSource,
      observeRevision,
      publishLexical,
      recordAccessProof,
      readEvidence,
      status,
      recordFailure,
      manageSource,
      validateDependencies,
    },
    transaction,
    source,
    document,
    dependencies,
    eligible,
    bind,
    observe,
    publish,
    revisionRow,
  };
}

export function createKnowledge(options: KnowledgeOptions) {
  return createKnowledgeStore(options).api;
}
