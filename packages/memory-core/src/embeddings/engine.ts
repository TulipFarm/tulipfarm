import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uuidSchema, type Principal as HumanActor } from '../documents/records.ts';
import { requireAccess, type AccessDecision } from '../ports/authorizer.ts';
import type { KnowledgeAuthorization, EligibilitySelection, AccessErrors } from '../ports/knowledge-authorization.ts';
import type { TenantRuntime, StorageErrorPolicy } from '../ports/tenant-runtime.ts';
import type { EmbeddingRepository } from '../ports/embedding-repository.ts';
import type { Clock, UsageMeter } from '../ports/runtime.ts';
import type { EmbeddingProfile } from '../ports/embedding-provider.ts';
import {
  embeddingDocumentRetrySchema,
  embeddingDocumentStatusSchema,
  embeddingQuerySchema,
  embeddingQueryStatusSchema,
  embeddingRetrySchema,
  embeddingStateSchema,
  embeddingWorkSchema,
  type EmbeddingState,
  type EmbeddingWork,
} from '../contracts/embeddings.ts';
import { KnowledgeError } from '../documents/contracts.ts';
import type { createDocumentStore } from '../documents/store.ts';
import type {
  EmbeddingProvider as KnowledgeEmbeddingProvider,
  EmbeddingResult as KnowledgeEmbeddingResult,
} from '../ports/embedding-provider.ts';
import { knowledgeSearchFiltersSchema, type KnowledgeSearchFilters } from '../contracts/knowledge.ts';

export type EmbeddingCapacity = (input: {
  workspaceId: string;
  purpose: 'query' | 'ingestion';
  tokens: number;
  attemptId: string;
  deadlineAt?: number;
}) => Promise<boolean>;
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
const jobFields = {
  id: uuidSchema,
  owner_membership_id: uuidSchema,
  owner_user_id: z.string(),
  profile_id: z.string(),
  generation: z.number().int(),
  retry_count: z.number().int().optional(),
  state: embeddingStateSchema,
  total_chunks: z.number().int(),
};
const jobSchema = z.discriminatedUnion('purpose', [
  z.object({ ...jobFields, purpose: z.literal('query'), command_id: uuidSchema, query_fingerprint: z.string() }),
  z.object({
    ...jobFields,
    purpose: z.literal('ingestion'),
    document_id: uuidSchema,
    revision_id: uuidSchema,
    publication_id: uuidSchema,
    access_epoch: z.number().int(),
  }),
]);
type Job = z.infer<typeof jobSchema>;
const itemSchema = z.object({
  ordinal: z.number().int(),
  input_hash: z.string(),
  input_text: z.string(),
  tokens: z.number().int(),
});
const cacheSchema = z.object({
  state: z.enum(['queued', 'claimed', 'dispatched', 'ready', 'failed', 'unknown']),
  attempt_id: uuidSchema.nullable(),
  attempts: z.number().int(),
});
const retryableStates: readonly EmbeddingState[] = [
  'disabled',
  'credits-blocked',
  'capacity-blocked',
  'failed',
  'unknown',
];

export type EmbeddingEngineOptions<Context, Source extends { kind: string }> = {
  runtime: TenantRuntime<Context>;
  store: ReturnType<typeof createDocumentStore<Context, Source>>;
  repository(context: Context): EmbeddingRepository;
  authorization: Pick<KnowledgeAuthorization<Context, Source>, 'authority'>;
  lock(context: Context, mode: 'read' | 'write'): Promise<AccessDecision<void>>;
  resolveMember(context: Context, userId: string): Promise<AccessDecision<HumanActor>>;
  discoveryCandidate(
    context: Context,
    profileId: string,
    documentId: string | undefined,
    selection: EligibilitySelection,
  ): Promise<unknown>;
  changedOwners(context: Context): Promise<unknown>;
  selection(context: Context): EligibilitySelection;
  conversationEnabled(context: Context): boolean;
  tenantId(context: Context): string;
  externalProviders(): string[];
  egressPolicy: { deny(): void };
  errors: Pick<AccessErrors, 'AccessDenied'> & {
    CreditsExhausted: new () => Error;
  };
  storageErrors: StorageErrorPolicy;
  profile: EmbeddingProfile;
  enabled(): boolean;
  provider: KnowledgeEmbeddingProvider;
  prepareInputs(inputs: readonly string[]): { inputHash: string; inputTokensUpperBound: number };
  clock: Clock;
  usageMeter: UsageMeter<Context>;
  capacity: EmbeddingCapacity;
  gate?: (tenantId: string) => Promise<string[]>;
};

export function createEmbeddingEngine<Context, Source extends { kind: string }>({
  runtime,
  store,
  repository,
  authorization,
  lock: lockKnowledgeAuthorization,
  resolveMember: resolveKnowledgeMember,
  discoveryCandidate: embeddingDiscoveryCandidate,
  changedOwners: changedConversationEmbeddingOwners,
  selection,
  conversationEnabled,
  tenantId,
  externalProviders,
  egressPolicy: knowledgeEgressPolicy,
  errors,
  storageErrors,
  profile,
  enabled,
  provider,
  prepareInputs: prepareKnowledgeEmbeddingInputs,
  clock,
  usageMeter,
  capacity,
  gate,
}: EmbeddingEngineOptions<Context, Source>) {
  type Transaction = Context;
  const { AccessDenied, CreditsExhausted } = errors;
  const { authority: createKnowledgeAuthorizer } = authorization;
  const vectorSchema = z.array(z.number().finite()).length(profile.dimensions);
  async function transaction<T>(workspaceId: string, operation: (tx: Transaction) => Promise<T>, deadlineAt?: number) {
    return runtime.transaction(
      uuidSchema.parse(workspaceId),
      deadlineAt === undefined ? {} : { deadlineAt },
      async raw => {
        const tx = store.bind(raw);
        requireAccess(await lockKnowledgeAuthorization(tx, 'write'));
        return operation(tx);
      },
    );
  }
  async function member(tx: Transaction, userId: string) {
    return requireAccess(await resolveKnowledgeMember(tx, userId));
  }
  async function authorized(
    tx: Transaction,
    job: Job,
    actor: HumanActor = { kind: 'human', userId: job.owner_user_id, membershipId: job.owner_membership_id },
    dispatch = false,
  ) {
    const authorizer = createKnowledgeAuthorizer(tx, actor);
    requireAccess(await authorizer.decide('member', undefined));
    requireAccess(await authorizer.decide('embeddingOwner', job));
    if (job.purpose === 'query' && dispatch) {
      const expiresAt = requireAccess(
        await authorizer.decide('queryDispatch', {
          jobId: job.id,
          clock,
          selection: selection(tx),
        }),
      );
      if (expiresAt !== undefined) return expiresAt;
    }
    if (job.purpose === 'ingestion') {
      const doc = await store.document(tx, job.document_id);
      const origin = await store.source(tx, actor, doc.source_id, true);
      requireAccess(await authorizer.decide('embeddingProvider', { source: origin, providers: externalProviders() }));
      if (origin.provider === 'conversation')
        requireAccess(await authorizer.decide('conversation', { revisionId: job.revision_id, writing: true }));
      await store.eligible(tx, actor, {
        kind: 'knowledge-document',
        workspaceId: tenantId(tx),
        sourceId: origin.id,
        documentId: job.document_id,
        revisionId: job.revision_id,
        publicationId: job.publication_id,
        accessEpoch: job.access_epoch,
      });
    }
  }
  async function installProfile(tx: Transaction) {
    await repository(tx).installProfile([profile.id, profile]);
    const stored = z
      .object({ matches: z.boolean() })
      .parse((await repository(tx).profileMatches([profile.id, profile])).rows[0]);
    if (!stored.matches) throw new KnowledgeError('conflict');
  }
  async function currentIncarnation(tx: Transaction, job: Job, actor?: HumanActor) {
    if (job.purpose !== 'ingestion' || !externalProviders().length) {
      await authorized(tx, job, actor);
      return job;
    }
    const doc = await store.document(tx, job.document_id);
    const origin = await store.source(
      tx,
      actor ?? { kind: 'human', membershipId: job.owner_membership_id, userId: job.owner_user_id },
      doc.source_id,
      true,
    );
    const current = externalProviders().includes(origin.provider) ? { ...job, access_epoch: origin.access_epoch } : job;
    await authorized(tx, current, actor);
    return current;
  }
  async function rebindGoogleJobs(tx: Transaction) {
    const providers = externalProviders();
    if (!providers.length) return;
    const jobs = z.array(jobSchema).parse((await repository(tx).changedEpochJobs([providers])).rows);
    for (const job of jobs) {
      let current;
      try {
        current = await currentIncarnation(tx, job);
      } catch (error) {
        if (error instanceof AccessDenied || error instanceof KnowledgeError) continue;
        throw error;
      }
      if (current.purpose !== 'ingestion') continue;
      await repository(tx).rebindEpoch([job.id, current.access_epoch]);
    }
  }
  async function readJob(tx: Transaction, id: string) {
    const job = jobSchema.optional().parse((await repository(tx).lockJob([id])).rows[0]);
    if (!job) throw new AccessDenied();
    return job;
  }
  async function queryJob(tx: Transaction, actor: HumanActor, commandId: string) {
    const job = jobSchema
      .optional()
      .parse((await repository(tx).lockQueryJob([actor.membershipId, commandId])).rows[0]);
    if (!job || job.purpose !== 'query') throw new AccessDenied();
    await authorized(tx, job, actor);
    return job;
  }
  async function insertItems(tx: Transaction, jobId: string, texts: readonly string[]) {
    let items: z.infer<typeof itemSchema>[];
    try {
      items = texts.map((input_text, ordinal) => {
        const prepared = prepareKnowledgeEmbeddingInputs([input_text]);
        return { ordinal, input_text, input_hash: prepared.inputHash, tokens: prepared.inputTokensUpperBound };
      });
    } catch {
      await repository(tx).invalidateInput([jobId]);
      return;
    }
    const payload = JSON.stringify(items);
    await repository(tx).insertCache([profile.id, payload]);
    await repository(tx).insertItems([jobId, profile.id, payload]);
  }
  async function copyPublicationInputs(tx: Transaction, job: Job) {
    if (job.purpose !== 'ingestion' || (await repository(tx).hasItems([job.id])).rowCount) return job;
    const chunks = z
      .array(z.object({ passage: z.string() }))
      .parse((await repository(tx).publicationPassages([job.publication_id])).rows);
    await insertItems(
      tx,
      job.id,
      chunks.map(chunk => chunk.passage),
    );
    return readJob(tx, job.id);
  }
  async function state(tx: Transaction, job: Job) {
    const counts = z
      .object({
        total: z.number(),
        completed: z.number(),
        busy: z.boolean(),
        unknown: z.boolean(),
        failed: z.boolean(),
        exhausted: z.boolean(),
      })
      .parse((await repository(tx).counts([job.id])).rows[0]);
    const status: EmbeddingState =
      job.state === 'invalid-input'
        ? 'invalid-input'
        : counts.total === job.total_chunks && counts.completed === job.total_chunks
          ? 'ready'
          : counts.busy
            ? 'busy'
            : counts.unknown
              ? 'unknown'
              : counts.failed
                ? 'failed'
                : !enabled()
                  ? 'disabled'
                  : job.state;
    return {
      jobId: job.id,
      generation: job.generation,
      profileId: job.profile_id,
      state: status,
      canRetry: (job.retry_count ?? job.generation - 1) < 7 && !counts.exhausted && retryableStates.includes(status),
      completedChunks: counts.completed,
      totalChunks: job.total_chunks,
    };
  }
  async function queryDto(tx: Transaction, job: Extract<Job, { purpose: 'query' }>) {
    const status = await state(tx, job);
    const row = status.state === 'ready' ? (await repository(tx).queryVector([job.id])).rows[0] : undefined;
    return embeddingQueryStatusSchema.parse({
      ...status,
      commandId: job.command_id,
      vector: row ? vectorSchema.parse(row.vector) : null,
    });
  }
  async function publish(tx: Transaction, job: Job) {
    await authorized(tx, job);
    if (job.purpose === 'ingestion') {
      if (job.profile_id !== profile.id) throw new KnowledgeError('conflict');
      const chunks = z
        .array(z.object({ ordinal: z.number().int(), input_hash: z.string(), vector: vectorSchema }))
        .parse(
          (await repository(tx).publicationVectors([job.id, job.publication_id, job.profile_id, job.total_chunks]))
            .rows,
        );
      if (chunks.length !== job.total_chunks || chunks.some((chunk, ordinal) => chunk.ordinal !== ordinal))
        throw new KnowledgeError('incomplete');
      const publication = z
        .object({ id: uuidSchema })
        .parse(
          (
            await repository(tx).insertVectorPublication([
              randomUUID(),
              job.document_id,
              job.revision_id,
              job.publication_id,
              profile,
              job.profile_id,
            ])
          ).rows[0] ?? (await repository(tx).vectorPublication([job.publication_id, job.profile_id])).rows[0],
        );
      await repository(tx).insertSearchVectors([
        publication.id,
        job.publication_id,
        job.profile_id,
        JSON.stringify(chunks),
      ]);
      await repository(tx).publishVectors([job.document_id, job.revision_id, job.publication_id, publication.id]);
      await repository(tx).completeWork([job.revision_id]);
    }
    await repository(tx).completeJob([job.id]);
  }
  async function prepareQuery(
    workspaceId: string,
    userId: string,
    value: unknown,
    search?: { filters: KnowledgeSearchFilters; deadlineAt: number; retrySemantic: boolean; taskFlowId: string | null },
  ) {
    knowledgeEgressPolicy.deny();
    const input = embeddingQuerySchema.parse(value);
    return transaction(
      workspaceId,
      async tx => {
        const actor = await member(tx, userId);
        if (search) await recover(tx);
        const previous = jobSchema
          .optional()
          .parse((await repository(tx).readQueryJob([actor.membershipId, input.commandId])).rows[0]);
        if (previous) {
          await authorized(tx, previous, actor);
          if (previous.purpose !== 'query' || previous.query_fingerprint !== fingerprint(input.query))
            throw new KnowledgeError('conflict');
          if (search) {
            const existing = await repository(tx).queryBinding([previous.id, search.filters, search.taskFlowId]);
            if (!existing.rowCount) throw new KnowledgeError('conflict');
          }
          return queryDto(tx, previous);
        }
        const count = z
          .object({ count: z.number() })
          .parse((await repository(tx).queryCount([actor.membershipId])).rows[0]);
        if (count.count >= 10000) throw new KnowledgeError('quota');
        await installProfile(tx);
        const id = randomUUID();
        await repository(tx).insertQueryJob([
          id,
          actor.membershipId,
          userId,
          profile.id,
          input.commandId,
          fingerprint(input.query),
        ]);
        if (search)
          await repository(tx).insertQuery([id, search.filters, new Date(search.deadlineAt), search.taskFlowId]);
        await insertItems(tx, id, [input.query]);
        const job = await queryJob(tx, actor, input.commandId);
        if (search?.retrySemantic && (await state(tx, job)).canRetry)
          await retry(tx, actor, job, { commandId: input.commandId, expectedGeneration: job.generation });
        return queryDto(tx, await queryJob(tx, actor, input.commandId));
      },
      search?.deadlineAt,
    );
  }
  async function prepareSearchQuery(
    workspaceId: string,
    userId: string,
    value: {
      commandId: string;
      query: string;
      filters: KnowledgeSearchFilters;
      deadlineAt: number;
      retrySemantic: boolean;
      taskFlowId?: string | undefined;
    },
  ) {
    const filters = knowledgeSearchFiltersSchema.parse(value.filters);
    return prepareQuery(
      workspaceId,
      userId,
      { commandId: value.commandId, query: value.query },
      {
        filters,
        deadlineAt: value.deadlineAt,
        retrySemantic: value.retrySemantic,
        taskFlowId: value.taskFlowId ?? null,
      },
    );
  }
  async function cancelSearchQuery(workspaceId: string, userId: string, commandId: string) {
    return transaction(
      workspaceId,
      async tx => {
        const job = await queryJob(tx, await member(tx, userId), commandId);
        await repository(tx).cancelQuery([job.id]);
      },
      clock.now() + 500,
    );
  }
  async function queryStatus(workspaceId: string, userId: string, commandId: string, deadlineAt?: number) {
    commandId = uuidSchema.parse(commandId);
    return transaction(
      workspaceId,
      async tx => queryDto(tx, await queryJob(tx, await member(tx, userId), commandId)),
      deadlineAt,
    );
  }
  async function retry(tx: Transaction, actor: HumanActor, job: Job, input: z.infer<typeof embeddingRetrySchema>) {
    const previous = z
      .object({ job_id: uuidSchema, expected_generation: z.number() })
      .optional()
      .parse((await repository(tx).readRetry([actor.membershipId, input.commandId])).rows[0]);
    if (previous) {
      if (previous.job_id !== job.id || previous.expected_generation !== input.expectedGeneration)
        throw new KnowledgeError('conflict');
      return;
    }
    const status = await state(tx, job);
    if (!status.canRetry || job.generation !== input.expectedGeneration) throw new KnowledgeError('conflict');
    const current = await currentIncarnation(tx, job, actor);
    await repository(tx).resetRetryCache([job.id]);
    await repository(tx).retryJob([job.id, current.purpose === 'ingestion' ? current.access_epoch : null]);
    await copyPublicationInputs(tx, job);
    await repository(tx).insertRetry([actor.membershipId, input.commandId, job.id, input.expectedGeneration]);
  }
  async function retryQuery(workspaceId: string, userId: string, queryCommandId: string, value: unknown) {
    knowledgeEgressPolicy.deny();
    queryCommandId = uuidSchema.parse(queryCommandId);
    const input = embeddingRetrySchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await member(tx, userId);
      const job = await queryJob(tx, actor, queryCommandId);
      await retry(tx, actor, job, input);
      return queryDto(tx, await queryJob(tx, actor, queryCommandId));
    });
  }
  async function discover(tx: Transaction, documentId?: string) {
    await installProfile(tx);
    const pending = await repository(tx).hasUndiscovered([profile.id, documentId ?? null]);
    if (!pending.rowCount) return;
    const candidate = z
      .object({
        document_id: uuidSchema,
        revision_id: uuidSchema,
        publication_id: uuidSchema,
        owner_membership_id: uuidSchema,
        owner_user_id: z.string(),
        access_epoch: z.number().int(),
        chunk_count: z.number().int(),
      })
      .optional()
      .parse(await embeddingDiscoveryCandidate(tx, profile.id, documentId, selection(tx)));
    if (!candidate) return;
    const id = randomUUID();
    await repository(tx).insertIngestionJob([
      id,
      candidate.owner_membership_id,
      candidate.owner_user_id,
      profile.id,
      candidate.document_id,
      candidate.revision_id,
      candidate.publication_id,
      candidate.access_epoch,
      candidate.chunk_count,
    ]);
    const job = await readJob(tx, id);
    try {
      await authorized(tx, job);
    } catch (error) {
      if (!(error instanceof AccessDenied) && !(error instanceof KnowledgeError)) throw error;
      await repository(tx).failJob([id]);
      return;
    }
    await copyPublicationInputs(tx, job);
  }
  async function recover(tx: Transaction) {
    const expired = z
      .array(
        z.object({
          profile_id: z.string(),
          input_hash: z.string(),
          attempt_id: uuidSchema.nullable(),
          state: z.enum(['claimed', 'dispatched']),
        }),
      )
      .parse((await repository(tx).expiredClaims()).rows);
    for (const row of expired) {
      if (row.state === 'dispatched' && row.attempt_id)
        await usageMeter.outcome(tx, { kind: 'unknown', attemptId: row.attempt_id });
      await repository(tx).recoverClaim([
        row.profile_id,
        row.input_hash,
        row.state === 'claimed' ? 'queued' : 'unknown',
      ]);
    }
  }
  async function due(workspaceId: string): Promise<EmbeddingWork[]> {
    const held = gate ? await gate(workspaceId) : [];
    return transaction(workspaceId, async tx => {
      await recover(tx);
      if (conversationEnabled(tx)) {
        const changed = z
          .array(z.object({ job: jobSchema, membership_id: uuidSchema, user_id: z.string() }))
          .parse(await changedConversationEmbeddingOwners(tx));
        for (const row of changed) {
          const rebound = { ...row.job, owner_membership_id: row.membership_id, owner_user_id: row.user_id };
          try {
            await authorized(tx, rebound);
          } catch (error) {
            if (error instanceof AccessDenied || error instanceof KnowledgeError) continue;
            throw error;
          }
          await repository(tx).rebindOwner([row.job.id, row.membership_id, row.user_id]);
        }
      }
      await discover(tx);
      await rebindGoogleJobs(tx);
      const jobs = z.array(jobSchema).parse((await repository(tx).dueJobs([profile.id, held])).rows);
      const work: EmbeddingWork[] = [];
      for (const job of jobs) {
        try {
          await authorized(tx, job, undefined, true);
        } catch (error) {
          if (!(error instanceof AccessDenied) && !(error instanceof KnowledgeError)) throw error;
          await repository(tx).failJob([job.id]);
          continue;
        }
        const status = await state(tx, job);
        if (status.state === 'ready') await publish(tx, job);
        else if (status.state === 'queued' || status.state === 'capacity-blocked')
          work.push({ workspaceId, jobId: job.id, generation: job.generation });
        else if (status.state === 'busy') await repository(tx).deferJob([job.id]);
        else await repository(tx).setJobState([job.id, status.state]);
      }
      return work;
    });
  }
  async function documentJob(tx: Transaction, actor: HumanActor, documentId: string) {
    const doc = await store.document(tx, documentId);
    const job = jobSchema
      .optional()
      .parse(
        (await repository(tx).documentJob([doc.id, doc.observed_revision_id, doc.lexical_publication_id, profile.id]))
          .rows[0],
      );
    if (!job || job.purpose !== 'ingestion') {
      await store.source(tx, actor, doc.source_id);
      throw new KnowledgeError('incomplete');
    }
    await currentIncarnation(tx, job, actor);
    return job;
  }
  async function documentStatus(workspaceId: string, userId: string, documentId: string) {
    documentId = uuidSchema.parse(documentId);
    return transaction(workspaceId, async tx => {
      const job = await documentJob(tx, await member(tx, userId), documentId);
      return embeddingDocumentStatusSchema.parse({
        ...(await state(tx, job)),
        documentId,
        revisionId: job.revision_id,
        publicationId: job.publication_id,
      });
    });
  }
  async function retryDocument(workspaceId: string, userId: string, documentId: string, value: unknown) {
    knowledgeEgressPolicy.deny();
    documentId = uuidSchema.parse(documentId);
    const input = embeddingDocumentRetrySchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await member(tx, userId);
      const job = await documentJob(tx, actor, documentId);
      if (job.id !== input.expectedJobId) throw new KnowledgeError('conflict');
      await retry(tx, actor, job, input);
      const current = await documentJob(tx, actor, documentId);
      return embeddingDocumentStatusSchema.parse({
        ...(await state(tx, current)),
        documentId,
        revisionId: current.revision_id,
        publicationId: current.publication_id,
      });
    });
  }
  async function documentResult(workspaceId: string, userId: string, documentId: string) {
    documentId = uuidSchema.parse(documentId);
    return transaction(workspaceId, async tx => {
      const job = await documentJob(tx, await member(tx, userId), documentId);
      if ((await state(tx, job)).state !== 'ready') throw new KnowledgeError('incomplete');
      const chunks = z
        .array(z.object({ ordinal: z.number().int(), inputHash: z.string(), vector: vectorSchema }))
        .parse((await repository(tx).documentVectors([job.id])).rows);
      return {
        documentId,
        revisionId: job.revision_id,
        publicationId: job.publication_id,
        profileId: job.profile_id,
        chunks,
      };
    });
  }
  async function resumeDocument(workspaceId: string, userId: string, documentId: string, commandId: string) {
    knowledgeEgressPolicy.deny();
    documentId = uuidSchema.parse(documentId);
    commandId = uuidSchema.parse(commandId);
    return transaction(workspaceId, async tx => {
      const actor = await member(tx, userId);
      await discover(tx, documentId);
      let job = await documentJob(tx, actor, documentId);
      const replay = z
        .object({ job_id: uuidSchema })
        .optional()
        .parse((await repository(tx).retryJobId([actor.membershipId, commandId])).rows[0]);
      if (replay && replay.job_id !== job.id) throw new KnowledgeError('conflict');
      if (!replay && (await state(tx, job)).canRetry) {
        await retry(tx, actor, job, { commandId, expectedGeneration: job.generation });
        job = await documentJob(tx, actor, documentId);
      }
      return embeddingDocumentStatusSchema.parse({
        ...(await state(tx, job)),
        documentId,
        revisionId: job.revision_id,
        publicationId: job.publication_id,
      });
    });
  }
  async function persistOutcome(
    workspaceId: string,
    claim: { job: Job; item: z.infer<typeof itemSchema>; attemptId: string },
    result: KnowledgeEmbeddingResult,
  ) {
    const known = result.dispatch === 'dispatched' && result.usage.kind === 'known' ? result.usage.inputTokens : null;
    const providerPicoUsd =
      known === null
        ? null
        : usageMeter.cost({ inputTokens: known, date: new Date(clock.now()).toISOString().slice(0, 10) })
            .providerPicoUsd;
    const valid =
      result.result.kind === 'success' &&
      result.result.model === profile.model &&
      result.result.vectors.length === 1 &&
      known !== null &&
      known <= claim.item.tokens
        ? vectorSchema.safeParse(result.result.vectors[0])
        : null;
    for (let attempt = 0; ; attempt++) {
      try {
        await transaction(workspaceId, async tx => {
          if (result.dispatch === 'undispatched')
            await usageMeter.outcome(tx, { kind: 'marked-undispatched', attemptId: claim.attemptId });
          else if (providerPicoUsd === null)
            await usageMeter.outcome(tx, { kind: 'unknown', attemptId: claim.attemptId });
          else
            await usageMeter.outcome(tx, {
              kind: 'known',
              attemptId: claim.attemptId,
              providerPicoUsd,
              inputTokens: String(known),
              providerRequestId: result.requestId,
            });
          if (valid?.success)
            await repository(tx).insertVector([
              claim.job.profile_id,
              claim.item.input_hash,
              JSON.stringify(valid.data),
              claim.attemptId,
            ]);
          await repository(tx).settleClaim([
            claim.job.profile_id,
            claim.item.input_hash,
            claim.attemptId,
            result.dispatch === 'undispatched' ? 'failed' : known === null ? 'unknown' : 'failed',
          ]);
        });
        if (result.dispatch !== 'undispatched' && known !== null && providerPicoUsd !== null)
          void usageMeter.record({
            workspaceId,
            flowId: claim.job.id,
            modelId: profile.model,
            agentId: null,
            activity: `knowledge-${claim.job.purpose}`,
            inputTokens: known,
            providerPicoUsd,
            at: new Date(clock.now()),
          });
        return;
      } catch (error) {
        const transient = storageErrors.transient(error);
        if (!transient || attempt >= 2) throw error;
        await clock.sleep(50 * (attempt + 1));
      }
    }
  }
  async function queryTaskFlow(tx: Transaction, jobId: string) {
    return (
      z
        .object({ task_flow_id: z.string().nullable() })
        .optional()
        .parse((await repository(tx).queryTaskFlow([jobId])).rows[0])?.task_flow_id ?? null
    );
  }
  async function process(
    value: EmbeddingWork,
    deadlineAt?: number,
    signal?: AbortSignal,
  ): Promise<{ disposition: EmbeddingState | 'stale' | 'retry' }> {
    knowledgeEgressPolicy.deny();
    const work = embeddingWorkSchema.parse(value);
    signal?.throwIfAborted();
    const held = gate ? await gate(work.workspaceId) : [];
    const claim = await transaction(
      work.workspaceId,
      async tx => {
        await recover(tx);
        const job = await readJob(tx, work.jobId);
        if (work.generation !== undefined && job.generation !== work.generation) return 'stale';
        // Held work stays queued without claiming, reserving credits or calling the provider.
        if (
          job.purpose === 'ingestion' &&
          held.length &&
          (await repository(tx).heldDocument([job.document_id, held])).rowCount
        ) {
          await repository(tx).deferJob([job.id]);
          return 'stale';
        }
        let effectiveDeadlineAt = deadlineAt;
        try {
          const persistedDeadlineAt = await authorized(tx, job, undefined, true);
          if (persistedDeadlineAt !== undefined)
            effectiveDeadlineAt = Math.min(deadlineAt ?? persistedDeadlineAt, persistedDeadlineAt);
        } catch (error) {
          if (error instanceof AccessDenied || error instanceof KnowledgeError) return 'stale';
          throw error;
        }
        const status = await state(tx, await copyPublicationInputs(tx, job));
        if (status.state === 'ready') {
          await publish(tx, job);
          return 'ready';
        }
        if (!['queued', 'capacity-blocked'].includes(status.state)) return status.state;
        const item = itemSchema.optional().parse((await repository(tx).nextItem([job.id])).rows[0]);
        if (!item) return 'failed';
        const cache = cacheSchema.parse((await repository(tx).lockCache([job.profile_id, item.input_hash])).rows[0]);
        if (cache.state !== 'queued' || cache.attempts >= 8) return 'failed';
        if (signal?.aborted || (effectiveDeadlineAt !== undefined && clock.now() >= effectiveDeadlineAt))
          return 'stale';
        const attemptId = randomUUID();
        await repository(tx).claim([
          job.profile_id,
          item.input_hash,
          attemptId,
          effectiveDeadlineAt === undefined ? null : new Date(effectiveDeadlineAt),
        ]);
        return { job, item, attemptId, deadlineAt: effectiveDeadlineAt };
      },
      deadlineAt,
    );
    if (typeof claim === 'string') return { disposition: claim };
    deadlineAt = claim.deadlineAt;
    let admitted = false;
    try {
      admitted = await capacity({
        workspaceId: work.workspaceId,
        purpose: claim.job.purpose,
        tokens: claim.item.tokens,
        attemptId: claim.attemptId,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      });
    } catch {
      admitted = false;
    }
    const dispatch = await transaction(
      work.workspaceId,
      async tx => {
        const owned = await repository(tx).ownsClaim([claim.job.profile_id, claim.item.input_hash, claim.attemptId]);
        if (!owned.rowCount) return 'stale';
        const job = await readJob(tx, claim.job.id);
        let reserved = false;
        let refusal: 'stale' | 'capacity-blocked' | 'credits-blocked' | undefined = admitted
          ? undefined
          : 'capacity-blocked';
        if (signal?.aborted) refusal = 'stale';
        try {
          await authorized(tx, job, undefined, true);
        } catch (error) {
          if (!(error instanceof AccessDenied) && !(error instanceof KnowledgeError)) throw error;
          refusal = 'stale';
        }
        if (job.generation !== claim.job.generation) refusal = 'stale';
        if (refusal !== 'stale' && (await repository(tx).hasVector([job.profile_id, claim.item.input_hash])).rowCount) {
          await repository(tx).completeCache([job.profile_id, claim.item.input_hash]);
          const complete = (await state(tx, job)).state === 'ready';
          await repository(tx).dispatchJobState([job.id, complete ? 'ready' : 'queued']);
          if (complete) await publish(tx, job);
          return complete ? 'ready' : 'retry';
        }
        if (!refusal) {
          try {
            const cost = usageMeter.cost({
              inputTokens: claim.item.tokens,
              date: new Date(clock.now()).toISOString().slice(0, 10),
            });
            await usageMeter.reserve(tx, {
              id: claim.attemptId,
              operationId: job.id,
              modelId: profile.model,
              profileId: job.profile_id,
              pricingRevision: cost.pricingRevision,
              purpose: job.purpose,
              attribution:
                job.purpose === 'query'
                  ? { kind: 'member', id: job.owner_membership_id }
                  : { kind: 'source', id: (await store.document(tx, job.document_id)).source_id },
              taskFlowId: job.purpose === 'query' ? await queryTaskFlow(tx, job.id) : null,
              upperProviderPicoUsd: cost.providerPicoUsd,
            });
            reserved = true;
          } catch (error) {
            if (!(error instanceof CreditsExhausted)) throw error;
            refusal = 'credits-blocked';
          }
        }
        if (signal?.aborted || (deadlineAt !== undefined && clock.now() >= deadlineAt)) refusal = 'stale';
        if (refusal) {
          if (reserved) await usageMeter.outcome(tx, { kind: 'undispatched', attemptId: claim.attemptId });
          await repository(tx).releaseClaim([job.profile_id, claim.item.input_hash]);
          await repository(tx).deferJobState([job.id, refusal === 'stale' ? 'failed' : refusal]);
          return refusal;
        }
        if (!(await usageMeter.markDispatched(tx, claim.attemptId))) throw new KnowledgeError('conflict');
        await repository(tx).dispatchClaim([job.profile_id, claim.item.input_hash]);
        await repository(tx).queueJob([job.id]);
        return 'dispatch';
      },
      deadlineAt,
    );
    if (dispatch !== 'dispatch') return { disposition: dispatch };
    if (signal?.aborted || (deadlineAt !== undefined && clock.now() >= deadlineAt)) {
      await persistOutcome(work.workspaceId, claim, {
        dispatch: 'undispatched',
        inputTokensUpperBound: claim.item.tokens,
        requestId: null,
        usage: { kind: 'unknown', reason: 'undispatched' },
        result: { kind: 'error', code: 'cancelled' },
      });
      return { disposition: 'stale' };
    }
    let result: KnowledgeEmbeddingResult;
    try {
      result = await provider({ inputs: [claim.item.input_text] });
    } catch {
      result = {
        dispatch: 'dispatched',
        inputTokensUpperBound: claim.item.tokens,
        requestId: null,
        usage: { kind: 'unknown', reason: 'transport' },
        result: { kind: 'error', code: 'transport' },
      };
    }
    await persistOutcome(work.workspaceId, claim, result);
    return transaction(work.workspaceId, async tx => {
      const job = await readJob(tx, work.jobId);
      try {
        await authorized(tx, job);
      } catch (error) {
        if (error instanceof AccessDenied || error instanceof KnowledgeError) return { disposition: 'stale' };
        throw error;
      }
      const status = await state(tx, job);
      if (status.state === 'ready') await publish(tx, job);
      return { disposition: status.state === 'queued' ? 'retry' : status.state };
    });
  }
  return {
    prepareQuery,
    prepareSearchQuery,
    cancelSearchQuery,
    queryStatus,
    retryQuery,
    due,
    process,
    documentStatus,
    documentResult,
    retryDocument,
    resumeDocument,
  };
}
