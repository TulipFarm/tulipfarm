import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAccess, currentAccessProof } from '../ports/authorizer.ts';
import type { TenantRuntime } from '../ports/tenant-runtime.ts';
import type { KnowledgeRepository } from '../ports/knowledge-repository.ts';
import type { KnowledgeAuthorization, KnowledgeDependency, AccessErrors } from '../ports/knowledge-authorization.ts';
import {
  uuidSchema,
  sourceRow,
  documentRow,
  type ExternalSource,
  type Actor,
  type Principal as HumanActor,
} from './records.ts';
import {
  citationSchema,
  knowledgeLimits,
  KnowledgeError,
  lexicalInput,
  originalSchema,
  proofInput,
  sourceInput,
  createRevisionInput,
  type KnowledgeCitation,
} from './contracts.ts';
import { exactIdentifiers } from './identifiers.ts';
export type { ExternalSource, KnowledgeDocument } from './records.ts';
type Dependency = KnowledgeDependency;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export type DocumentStoreOptions<Context, Source extends { kind: string }> = {
  runtime: TenantRuntime<Context>;
  repository(context: Context): KnowledgeRepository;
  authorization: KnowledgeAuthorization<Context, Source>;
  errors: AccessErrors;
  tenantId(context: Context): string;
  sourceDependenciesSchema: z.ZodType<Source[]>;
  revisionInput: ReturnType<typeof createRevisionInput<Source>>;
  egressPolicy: { deny(): void };
  invalidateRecommendationSource(context: Context, documentId: string): Promise<unknown>;
  recordRecommendationChange(
    context: Context,
    change: {
      id: string;
      kind: 'knowledge';
      sourceId: string;
      membershipIds: string[];
      invalidate: boolean;
    },
  ): Promise<unknown>;
  refreshExternalProof?: (input: {
    workspaceId: string;
    actor: HumanActor;
    source: ExternalSource;
    documentId: string;
    nativeId: string;
    accessEpoch: number;
  }) => Promise<z.infer<typeof proofInput>>;
};

export function createDocumentStore<Context, Source extends { kind: string }>({
  runtime,
  repository,
  authorization,
  errors,
  tenantId,
  sourceDependenciesSchema,
  revisionInput,
  egressPolicy: knowledgeEgressPolicy,
  invalidateRecommendationSource,
  recordRecommendationChange,
  refreshExternalProof,
}: DocumentStoreOptions<Context, Source>) {
  type Transaction = Context;
  const { AccessDenied, SourceAuthorizationUnavailable } = errors;
  const {
    authority,
    admit: admitKnowledgePrincipal,
    document: authorizeKnowledgeDocument,
    bind: bindKnowledgeAuthorization,
    knowledgeDependency,
  } = authorization;
  const revisionRow = z.object({
    id: uuidSchema,
    document_id: uuidSchema,
    title: z.string(),
    canonical_url: z.string().nullable(),
    original: originalSchema,
    sources: sourceDependenciesSchema,
    fingerprint: z.string(),
  });

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
      options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt },
      async tx => {
        options.signal?.throwIfAborted();
        const actor = requireAccess(await admitKnowledgePrincipal(tx, actorInput, write ? 'write' : 'read'));
        const bound = bind(tx);
        const result = await operation(bound, actor);
        options.signal?.throwIfAborted();
        return result;
      },
    );
  }

  async function source(tx: Transaction, actor: HumanActor, id: string, writing = false) {
    const value = sourceRow.optional().parse((await repository(tx).readSource([id])).rows[0]);
    return requireAccess(await authority(tx, actor).decide('source', { value, writing }));
  }

  async function document(tx: Transaction, id: string) {
    const value = documentRow.optional().parse((await repository(tx).readDocument([id])).rows[0]);
    return requireAccess(await authorizeKnowledgeDocument(value));
  }

  async function dependencies(tx: Transaction, actor: HumanActor, revision: z.infer<typeof revisionRow>) {
    const authorizer = authority(tx, actor);
    const closure = requireAccess(await authorizer.decide('dependencies', revision));
    for (const dependency of closure) {
      // The closure already contains every dependency. Re-entering eligible's closure
      // here would recurse forever on corrupt/cyclic retained citations.
      const retained = knowledgeDependency(dependency);
      if (retained) await eligible(tx, actor, retained, false);
      else requireAccess(await authorizer.decide('protectedSource', dependency));
    }
  }

  async function requireProof(
    tx: Transaction,
    actor: HumanActor,
    doc: z.infer<typeof documentRow>,
    origin: ExternalSource,
  ) {
    requireAccess(await authority(tx, actor).decide('proof', { document: doc, source: origin }));
  }

  async function eligible(tx: Transaction, actor: HumanActor, dependency: Dependency, checkDependencies = true) {
    requireAccess(await authority(tx, actor).decide('tenant', dependency.workspaceId));
    const doc = await document(tx, dependency.documentId);
    const origin = await source(tx, actor, doc.source_id);
    requireAccess(await authority(tx, actor).decide('binding', { document: doc, source: origin, dependency }));
    const revision = revisionRow.parse(
      (await repository(tx).readDocumentRevision([dependency.revisionId, doc.id])).rows[0],
    );
    await dependencies(tx, actor, checkDependencies ? revision : { ...revision, sources: [] });
    await requireProof(tx, actor, doc, origin);
    return { doc, origin, revision };
  }

  function bind<X extends Transaction>(tx: X): X {
    return bindKnowledgeAuthorization(tx, eligible);
  }

  async function configureSource(workspaceId: string, actor: Actor, value: unknown) {
    knowledgeEgressPolicy.deny();
    const input = sourceInput.parse(value);
    if (input.provider === 'conversation') throw new AccessDenied();
    return transaction(workspaceId, actor, true, async (tx, human) => {
      const existing = sourceRow.optional().parse((await repository(tx).readSource([input.id])).rows[0]);
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
      await repository(tx).insertSource([
        input.id,
        input.provider,
        input.accountNamespace,
        input.selection,
        human.membershipId,
      ]);
      return { id: input.id, accessEpoch: 1 };
    });
  }

  async function observeRevision(workspaceId: string, actor: Actor, value: unknown) {
    knowledgeEgressPolicy.deny();
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
    const prior = documentRow.optional().parse((await repository(tx).readDocument([input.documentId])).rows[0]);
    if (prior) {
      await source(tx, human, prior.source_id);
      if (prior.observed_revision_id && !conversation) {
        const revision = revisionRow.parse((await repository(tx).readRevision([prior.observed_revision_id])).rows[0]);
        await dependencies(tx, human, revision);
      }
    } else if (input.expectedRevisionId !== null) throw new AccessDenied();
    const origin = await source(tx, human, input.sourceId, true);
    if ((origin.provider === 'conversation') !== conversation) throw new AccessDenied();
    if ((origin.provider === 'file') !== (input.original.kind === 'file')) throw new KnowledgeError('conflict');
    requireAccess(
      await authority(tx, human).decide('observation', {
        sources: input.sources,
        conversation,
        documentId: input.documentId,
      }),
    );
    await dependencies(tx, human, {
      ...input,
      document_id: input.documentId,
      canonical_url: input.canonicalUrl,
      fingerprint,
    });
    const replay = revisionRow.optional().parse((await repository(tx).readRevision([input.id])).rows[0]);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
      const current = await document(tx, input.documentId);
      if (current.observed_revision_id !== input.id) throw new KnowledgeError('superseded');
      return { documentId: input.documentId, revisionId: input.id, accessEpoch: origin.access_epoch };
    }
    if (prior && (prior.source_id !== input.sourceId || prior.native_id !== input.nativeId || prior.tombstoned_at))
      throw new KnowledgeError('conflict');
    if ((prior?.observed_revision_id ?? null) !== input.expectedRevisionId) throw new KnowledgeError('conflict');
    const usage = z
      .object({ documents: z.number(), revisions: z.number(), bytes: z.coerce.number() })
      .parse((await repository(tx).documentUsage([input.documentId])).rows[0]);
    if (
      (!prior && usage.documents >= knowledgeLimits.documents) ||
      usage.revisions >= knowledgeLimits.revisionsPerDocument ||
      usage.bytes + input.original.bytes > knowledgeLimits.retainedBytes
    )
      throw new KnowledgeError('quota');
    if (!prior) await repository(tx).insertDocument([input.documentId, input.sourceId, input.nativeId]);
    await repository(tx).insertRevision([
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
    ]);
    await repository(tx).insertWork([input.id]);
    await repository(tx).observeDocument([input.documentId, input.id]);
    if (prior?.observed_revision_id && (origin.provider === 'note' || origin.provider === 'file')) {
      await invalidateRecommendationSource(tx, input.documentId);
    }
    return { documentId: input.documentId, revisionId: input.id, accessEpoch: origin.access_epoch };
  }

  async function publishLexical(workspaceId: string, actor: Actor, value: unknown) {
    knowledgeEgressPolicy.deny();
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
      requireAccess(await authority(tx, human).decide('conversation', { revisionId: input.revisionId, writing: true }));
    }
    await requireProof(tx, human, doc, origin);
    const revision = revisionRow.parse((await repository(tx).readRevision([input.revisionId])).rows[0]);
    await dependencies(tx, human, revision);
    const work = z
      .object({ parsing: z.string() })
      .parse((await repository(tx).readParsing([input.revisionId])).rows[0]);
    if (work.parsing === 'ocr-unavailable') throw new KnowledgeError('incomplete');
    const existing = z
      .object({ fingerprint: z.string() })
      .optional()
      .parse((await repository(tx).publicationFingerprint([input.id])).rows[0]);
    if (existing && existing.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
    if (!existing) {
      const usage = z
        .object({ publications: z.number(), chunks: z.number(), bytes: z.coerce.number() })
        .parse((await repository(tx).publicationUsage([input.revisionId])).rows[0]);
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
      await repository(tx).insertPublication([
        input.id,
        input.documentId,
        input.revisionId,
        input.markdown,
        input.pages,
        input.tokens,
        input.chunks.length,
        fingerprint,
      ]);
      for (const [ordinal, chunk] of input.chunks.entries()) {
        const values: [
          string,
          number,
          string,
          string,
          number,
          z.infer<typeof lexicalInput>['chunks'][number]['offset'],
          string,
        ] = [
          input.id,
          ordinal,
          chunk.heading,
          chunk.text,
          chunk.tokens,
          chunk.offset,
          hash(`${chunk.heading}\n${chunk.text}`),
        ];
        if (local)
          await repository(tx).insertSearchChunk([
            ...values,
            revision.title,
            exactIdentifiers(`${revision.title}\n${local.filename}\n${chunk.heading}\n${chunk.text}`),
          ]);
        else await repository(tx).insertChunk(values);
      }
    }
    await requireProof(tx, human, doc, origin);
    await repository(tx).publishDocument([doc.id, input.id]);
    await repository(tx).completeParsing([input.revisionId]);
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
      workspaceId: tenantId(tx),
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
          await repository(tx).invalidateAccessEpoch([context.source.id, context.accessEpoch]);
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
      const clock = z.object({ now: z.date() }).parse((await repository(tx).currentTime()).rows[0]).now;
      if (!currentAccessProof({ ...input, principalCheckedAt: input.membershipCheckedAt }, clock))
        throw new KnowledgeError('permission-expired');
      const result = await repository(tx).recordProof([
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
      ]);
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
        .parse((await repository(tx).readChunk([citation.publicationId, citation.ordinal])).rows[0]);
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
      const revision = revisionRow.parse((await repository(tx).readRevision([doc.observed_revision_id])).rows[0]);
      await dependencies(tx, human, revision);
      const work = z
        .object({ parsing: z.string(), embedding: z.string(), failure: z.string().nullable(), attempts: z.number() })
        .parse((await repository(tx).readWork([doc.observed_revision_id])).rows[0]);
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
      if (origin.provider === 'conversation')
        requireAccess(
          await authority(tx, human).decide('conversation', { revisionId: input.revisionId, writing: true }),
        );
      if (doc.observed_revision_id !== input.revisionId) throw new KnowledgeError('superseded');
      if (input.axis === 'parsing' && doc.lexical_publication_id) throw new KnowledgeError('conflict');
      const result = await repository(tx).recordFailure(
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
        input.axis,
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
      const origin = sourceRow.optional().parse((await repository(tx).readSource([sourceId])).rows[0]);
      if (!origin || origin.provider === 'conversation' || origin.owner_membership_id !== human.membershipId)
        throw new AccessDenied();
      if (origin.state === 'removed' && action !== 'remove') throw new KnowledgeError('conflict');
      if (origin.state === 'disconnected' && ['pause', 'resume'].includes(action)) throw new KnowledgeError('conflict');
      if (action === 'remove') {
        await repository(tx).removeSource([sourceId]);
        await repository(tx).tombstoneSourceDocuments([sourceId]);
      } else if (action === 'invalidate' || action === 'disconnect') {
        await repository(tx).invalidateSource([sourceId, action]);
      } else await repository(tx).setSourceState([sourceId, action === 'pause' ? 'paused' : 'active']);
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
      const result = await repository(tx).validateProofs([
        required.map(proof => proof.documentId),
        required.map(proof => proof.accessEpoch),
        human.membershipId,
      ]);
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
