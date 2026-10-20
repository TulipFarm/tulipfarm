import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, uuidSchema, type HumanActor } from '../authorization/contracts.ts';
import { requireAccess } from '@tulipfarm/memory-core/ports/authorizer';
import {
  createKnowledgeAuthorizer,
  knowledgeEgressPolicy,
  lockKnowledgeAuthorization,
  resolveKnowledgeMember,
} from '../authorization/authorizer.ts';
import {
  embeddingDiscoveryCandidate,
  changedConversationEmbeddingOwners,
} from '../authorization/embedding-candidates.ts';
import type { Clock, UsageMeter } from '@tulipfarm/memory-core/ports/runtime';
import {
  knowledgeHostPolicy,
  knowledgeUsageMeter,
  systemClock,
  type KnowledgeEmbeddingsConfig,
} from '../host-ports.ts';
import { qualified, StorageUnavailableError, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { CreditsExhausted } from '@tulipfarm/workspace-storage/credits';
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
} from '../embeddings.ts';
import { KnowledgeError } from './contracts.ts';
import { createKnowledgeStore, type KnowledgeOptions } from './store.ts';
import {
  createKnowledgeEmbeddingProvider,
  prepareKnowledgeEmbeddingInputs,
  type KnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingResult,
} from './embedding-provider.ts';
import { knowledgeSearchFiltersSchema, type KnowledgeSearchFilters } from '../contracts.ts';
import type { GoogleKnowledge } from './google.ts';
import type { SlackKnowledge } from './slack.ts';
import type { GitHubKnowledge } from './github.ts';
import { type AtlassianKnowledge } from './atlassian.ts';
import { externalAuthority } from './external-authority.ts';
import type { KnowledgeSourceGate } from './rolling.ts';

export type KnowledgeEmbeddingCapacity = (input: {
  workspaceId: string;
  purpose: 'query' | 'ingestion';
  tokens: number;
  attemptId: string;
  deadlineAt?: number;
}) => Promise<boolean>;
export type KnowledgeEmbeddingsOptions = {
  runtime: KnowledgeOptions['runtime'];
  config: KnowledgeEmbeddingsConfig;
  provider?: KnowledgeEmbeddingProvider;
  clock?: Clock;
  usageMeter?: UsageMeter<Transaction>;
  capacity?: KnowledgeEmbeddingCapacity;
  google?: GoogleKnowledge;
  slack?: SlackKnowledge;
  github?: GitHubKnowledge;
  atlassian?: AtlassianKnowledge;
  /** Holds paid ingestion for automatic sources whose owner cannot use the feature now. */
  gate?: KnowledgeSourceGate;
};
type Transaction = Parameters<ReturnType<typeof createKnowledgeStore>['bind']>[0];
const profile = knowledgeHostPolicy.embeddingProfile;
const table = (tx: Transaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
const vectorSchema = z.array(z.number().finite()).length(profile.dimensions);
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

export function createKnowledgeEmbeddings({
  runtime,
  config,
  provider = createKnowledgeEmbeddingProvider(config),
  clock = systemClock,
  usageMeter = knowledgeUsageMeter,
  capacity = async () => false,
  google,
  slack,
  github,
  atlassian,
  gate,
}: KnowledgeEmbeddingsOptions) {
  const store = createKnowledgeStore({
    runtime,
    ...externalAuthority({
      ...(google ? { google } : {}),
      ...(slack ? { slack } : {}),
      ...(github ? { github } : {}),
      ...(atlassian ? { confluence: atlassian, jira: atlassian } : {}),
    }),
  });
  const externalProviders = () => [
    ...(google ? ['google'] : []),
    ...(slack ? ['slack'] : []),
    ...(github ? ['github'] : []),
    ...(atlassian ? ['confluence', 'jira'] : []),
  ];
  async function transaction<T>(workspaceId: string, operation: (tx: Transaction) => Promise<T>, deadlineAt?: number) {
    return runtime.transaction(
      uuidSchema.parse(workspaceId),
      { ...commonCompatibility, ...(deadlineAt === undefined ? {} : { deadlineAt }) },
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
          selection: {
            google: !!google,
            slack: !!slack,
            github: !!github,
            atlassian: !!atlassian,
            conversation: tx.commonVersion >= 1,
          },
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
        workspaceId: tx.workspaceId,
        sourceId: origin.id,
        documentId: job.document_id,
        revisionId: job.revision_id,
        publicationId: job.publication_id,
        accessEpoch: job.access_epoch,
      });
    }
  }
  async function installProfile(tx: Transaction) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'embedding_profiles')} (id,profile) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [profile.id, profile],
    );
    const stored = z
      .object({ matches: z.boolean() })
      .parse(
        (
          await tx.client.query(
            `SELECT profile=$2::jsonb AS matches FROM ${table(tx, 'embedding_profiles')} WHERE id=$1`,
            [profile.id, profile],
          )
        ).rows[0],
      );
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
    const jobs = z.array(jobSchema).parse(
      (
        await tx.client.query(
          `SELECT j.* FROM ${table(tx, 'embedding_jobs')} j
      JOIN ${table(tx, 'documents')} d ON d.id=j.document_id AND d.observed_revision_id=j.revision_id AND d.lexical_publication_id=j.publication_id
      JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
      WHERE s.provider=ANY($1::text[]) AND s.state='active' AND d.tombstoned_at IS NULL AND s.access_epoch<>j.access_epoch
        AND j.state IN ('queued','capacity-blocked','failed','ready')
        AND (SELECT count(*) FROM ${table(tx, 'embedding_items')} i JOIN ${table(tx, 'embedding_cache')} c USING(profile_id,input_hash)
          WHERE i.job_id=j.id AND c.state IN ('queued','ready'))=j.total_chunks
      ORDER BY j.id LIMIT 100 FOR UPDATE OF j`,
          [providers],
        )
      ).rows,
    );
    for (const job of jobs) {
      let current;
      try {
        current = await currentIncarnation(tx, job);
      } catch (error) {
        if (error instanceof AccessDenied || error instanceof KnowledgeError) continue;
        throw error;
      }
      if (current.purpose !== 'ingestion') continue;
      await tx.client.query(
        `UPDATE ${table(tx, 'embedding_jobs')} SET access_epoch=$2,generation=generation+1,state='queued',dispatch_after=clock_timestamp() WHERE id=$1`,
        [job.id, current.access_epoch],
      );
    }
  }
  async function readJob(tx: Transaction, id: string) {
    const job = jobSchema
      .optional()
      .parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'embedding_jobs')} WHERE id=$1 FOR UPDATE`, [id])).rows[0],
      );
    if (!job) throw new AccessDenied();
    return job;
  }
  async function queryJob(tx: Transaction, actor: HumanActor, commandId: string) {
    const job = jobSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${table(tx, 'embedding_jobs')} WHERE owner_membership_id=$1 AND command_id=$2 FOR UPDATE`,
            [actor.membershipId, commandId],
          )
        ).rows[0],
      );
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
      await tx.client.query(`UPDATE ${table(tx, 'embedding_jobs')} SET state='invalid-input' WHERE id=$1`, [jobId]);
      return;
    }
    const payload = JSON.stringify(items);
    await tx.client.query(
      `INSERT INTO ${table(tx, 'embedding_cache')} (profile_id,input_hash)
      SELECT DISTINCT $1,input_hash FROM jsonb_to_recordset($2::jsonb) AS i(input_hash text) ON CONFLICT DO NOTHING`,
      [profile.id, payload],
    );
    await tx.client.query(
      `INSERT INTO ${table(tx, 'embedding_items')} (job_id,ordinal,profile_id,input_hash,input_text,tokens)
      SELECT $1,ordinal,$2,input_hash,input_text,tokens FROM jsonb_to_recordset($3::jsonb) AS i(ordinal integer,input_hash text,input_text text,tokens integer)`,
      [jobId, profile.id, payload],
    );
  }
  async function copyPublicationInputs(tx: Transaction, job: Job) {
    if (
      job.purpose !== 'ingestion' ||
      (await tx.client.query(`SELECT 1 FROM ${table(tx, 'embedding_items')} WHERE job_id=$1 LIMIT 1`, [job.id]))
        .rowCount
    )
      return job;
    const chunks = z
      .array(z.object({ passage: z.string() }))
      .parse(
        (
          await tx.client.query(`SELECT passage FROM ${table(tx, 'chunks')} WHERE publication_id=$1 ORDER BY ordinal`, [
            job.publication_id,
          ])
        ).rows,
      );
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
      .parse(
        (
          await tx.client.query(
            `SELECT count(*)::int AS total,
      count(v.input_hash)::int AS completed, COALESCE(bool_or(c.state IN ('claimed','dispatched')) FILTER (WHERE v.input_hash IS NULL),false) AS busy,
      COALESCE(bool_or(c.state='unknown') FILTER (WHERE v.input_hash IS NULL),false) AS unknown,
      COALESCE(bool_or(c.state='failed') FILTER (WHERE v.input_hash IS NULL),false) AS failed,
      COALESCE(bool_or(c.attempts>=8 AND c.state<>'ready') FILTER (WHERE v.input_hash IS NULL),false) AS exhausted
      FROM ${table(tx, 'embedding_items')} i JOIN ${table(tx, 'embedding_cache')} c USING (profile_id,input_hash)
      LEFT JOIN ${table(tx, 'embedding_vectors')} v USING (profile_id,input_hash) WHERE i.job_id=$1`,
            [job.id],
          )
        ).rows[0],
      );
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
                : config.kind === 'disabled'
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
    const row =
      status.state === 'ready'
        ? (
            await tx.client.query(
              `SELECT v.vector FROM ${table(tx, 'embedding_items')} i JOIN ${table(tx, 'embedding_vectors')} v USING (profile_id,input_hash) WHERE i.job_id=$1 AND i.ordinal=0`,
              [job.id],
            )
          ).rows[0]
        : undefined;
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
          (
            await tx.client.query(
              `SELECT i.ordinal,i.input_hash,v.vector
        FROM ${table(tx, 'embedding_items')} i
        JOIN ${table(tx, 'publications')} p ON p.id=$2 AND p.chunk_count=$4
        JOIN ${table(tx, 'chunks')} k ON k.publication_id=p.id AND k.ordinal=i.ordinal AND k.passage=i.input_text
        JOIN ${table(tx, 'embedding_vectors')} v ON v.profile_id=i.profile_id AND v.input_hash=i.input_hash
        WHERE i.job_id=$1 AND i.profile_id=$3 ORDER BY i.ordinal`,
              [job.id, job.publication_id, job.profile_id, job.total_chunks],
            )
          ).rows,
        );
      if (chunks.length !== job.total_chunks || chunks.some((chunk, ordinal) => chunk.ordinal !== ordinal))
        throw new KnowledgeError('incomplete');
      const publication = z.object({ id: uuidSchema }).parse(
        (
          await tx.client.query(
            `INSERT INTO ${table(tx, 'vector_publications')}
        (id,document_id,revision_id,lexical_publication_id,profile,profile_id)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (lexical_publication_id,profile_id) DO NOTHING RETURNING id`,
            [randomUUID(), job.document_id, job.revision_id, job.publication_id, profile, job.profile_id],
          )
        ).rows[0] ??
          (
            await tx.client.query(
              `SELECT id FROM ${table(tx, 'vector_publications')} WHERE lexical_publication_id=$1 AND profile_id=$2`,
              [job.publication_id, job.profile_id],
            )
          ).rows[0],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'search_vectors')} (vector_publication_id,lexical_publication_id,ordinal,profile_id,input_hash,embedding)
        SELECT $1,$2,i.ordinal,$3,i.input_hash,i.vector::text::extensions.vector(1536)
        FROM jsonb_to_recordset($4::jsonb) AS i(ordinal integer,input_hash text,vector jsonb)
        ON CONFLICT DO NOTHING`,
        [publication.id, job.publication_id, job.profile_id, JSON.stringify(chunks)],
      );
      await tx.client.query(
        `UPDATE ${table(tx, 'documents')} SET vector_publication_id=$4
        WHERE id=$1 AND observed_revision_id=$2 AND lexical_publication_id=$3 AND tombstoned_at IS NULL`,
        [job.document_id, job.revision_id, job.publication_id, publication.id],
      );
      await tx.client.query(`UPDATE ${table(tx, 'work')} SET embedding='ready' WHERE revision_id=$1`, [
        job.revision_id,
      ]);
    }
    await tx.client.query(`UPDATE ${table(tx, 'embedding_jobs')} SET state='ready' WHERE id=$1`, [job.id]);
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
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${table(tx, 'embedding_jobs')} WHERE owner_membership_id=$1 AND command_id=$2`,
                [actor.membershipId, input.commandId],
              )
            ).rows[0],
          );
        if (previous) {
          await authorized(tx, previous, actor);
          if (previous.purpose !== 'query' || previous.query_fingerprint !== fingerprint(input.query))
            throw new KnowledgeError('conflict');
          if (search) {
            const existing = await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'search_queries')} WHERE job_id=$1 AND filters=$2::jsonb AND task_flow_id IS NOT DISTINCT FROM $3`,
              [previous.id, search.filters, search.taskFlowId],
            );
            if (!existing.rowCount) throw new KnowledgeError('conflict');
          }
          return queryDto(tx, previous);
        }
        const count = z
          .object({ count: z.number() })
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::int AS count FROM ${table(tx, 'embedding_jobs')} WHERE owner_membership_id=$1 AND purpose='query'`,
                [actor.membershipId],
              )
            ).rows[0],
          );
        if (count.count >= 10000) throw new KnowledgeError('quota');
        await installProfile(tx);
        const id = randomUUID();
        await tx.client.query(
          `INSERT INTO ${table(tx, 'embedding_jobs')} (id,purpose,owner_membership_id,owner_user_id,profile_id,command_id,query_fingerprint,total_chunks) VALUES ($1,'query',$2,$3,$4,$5,$6,1)`,
          [id, actor.membershipId, userId, profile.id, input.commandId, fingerprint(input.query)],
        );
        if (search)
          await tx.client.query(
            `INSERT INTO ${table(tx, 'search_queries')} (job_id,filters,expires_at,task_flow_id) VALUES ($1,$2,$3,$4)`,
            [id, search.filters, new Date(search.deadlineAt), search.taskFlowId],
          );
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
        await tx.client.query(`UPDATE ${table(tx, 'search_queries')} SET cancelled=true WHERE job_id=$1`, [job.id]);
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
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${table(tx, 'embedding_retries')} WHERE membership_id=$1 AND command_id=$2`,
            [actor.membershipId, input.commandId],
          )
        ).rows[0],
      );
    if (previous) {
      if (previous.job_id !== job.id || previous.expected_generation !== input.expectedGeneration)
        throw new KnowledgeError('conflict');
      return;
    }
    const status = await state(tx, job);
    if (!status.canRetry || job.generation !== input.expectedGeneration) throw new KnowledgeError('conflict');
    const current = await currentIncarnation(tx, job, actor);
    await tx.client.query(
      `UPDATE ${table(tx, 'embedding_cache')} c SET state='queued',attempt_id=NULL,lease_until=NULL FROM ${table(tx, 'embedding_items')} i
      WHERE i.job_id=$1 AND c.profile_id=i.profile_id AND c.input_hash=i.input_hash AND c.state IN ('failed','unknown') AND c.attempts<8`,
      [job.id],
    );
    await tx.client.query(
      `UPDATE ${table(tx, 'embedding_jobs')} SET generation=generation+1,retry_count=retry_count+1,access_epoch=$2,state='queued',dispatch_after=clock_timestamp() WHERE id=$1`,
      [job.id, current.purpose === 'ingestion' ? current.access_epoch : null],
    );
    await copyPublicationInputs(tx, job);
    await tx.client.query(
      `INSERT INTO ${table(tx, 'embedding_retries')} (membership_id,command_id,job_id,expected_generation) VALUES ($1,$2,$3,$4)`,
      [actor.membershipId, input.commandId, job.id, input.expectedGeneration],
    );
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
    const pending = await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'documents')} d
      WHERE d.tombstoned_at IS NULL AND d.lexical_publication_id IS NOT NULL
        AND ($2::uuid IS NULL OR d.id=$2)
        AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'embedding_jobs')} j WHERE j.publication_id=d.lexical_publication_id AND j.profile_id=$1)
      LIMIT 1`,
      [profile.id, documentId ?? null],
    );
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
      .parse(
        await embeddingDiscoveryCandidate(tx, profile.id, documentId, {
          google: !!google,
          slack: !!slack,
          github: !!github,
          atlassian: !!atlassian,
          conversation: tx.commonVersion >= 1,
        }),
      );
    if (!candidate) return;
    const id = randomUUID();
    await tx.client.query(
      `INSERT INTO ${table(tx, 'embedding_jobs')} (id,purpose,owner_membership_id,owner_user_id,profile_id,document_id,revision_id,publication_id,access_epoch,total_chunks)
      VALUES ($1,'ingestion',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        candidate.owner_membership_id,
        candidate.owner_user_id,
        profile.id,
        candidate.document_id,
        candidate.revision_id,
        candidate.publication_id,
        candidate.access_epoch,
        candidate.chunk_count,
      ],
    );
    const job = await readJob(tx, id);
    try {
      await authorized(tx, job);
    } catch (error) {
      if (!(error instanceof AccessDenied) && !(error instanceof KnowledgeError)) throw error;
      await tx.client.query(`UPDATE ${table(tx, 'embedding_jobs')} SET state='failed' WHERE id=$1`, [id]);
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
      .parse(
        (
          await tx.client.query(
            `SELECT profile_id,input_hash,attempt_id,state FROM ${table(tx, 'embedding_cache')} WHERE state IN ('claimed','dispatched') AND lease_until<=clock_timestamp() ORDER BY profile_id,input_hash LIMIT 100 FOR UPDATE`,
          )
        ).rows,
      );
    for (const row of expired) {
      if (row.state === 'dispatched' && row.attempt_id)
        await usageMeter.outcome(tx, { kind: 'unknown', attemptId: row.attempt_id });
      await tx.client.query(
        `UPDATE ${table(tx, 'embedding_cache')} SET state=$3,lease_until=NULL WHERE profile_id=$1 AND input_hash=$2`,
        [row.profile_id, row.input_hash, row.state === 'claimed' ? 'queued' : 'unknown'],
      );
    }
  }
  async function due(workspaceId: string): Promise<EmbeddingWork[]> {
    const held = gate ? await gate(workspaceId) : [];
    return transaction(workspaceId, async tx => {
      await recover(tx);
      if (tx.commonVersion >= 1) {
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
          await tx.client.query(
            `UPDATE ${table(tx, 'embedding_jobs')} SET owner_membership_id=$2,owner_user_id=$3,generation=generation+1,
            state=CASE WHEN state='ready' THEN 'ready' ELSE 'queued' END,dispatch_after=clock_timestamp() WHERE id=$1`,
            [row.job.id, row.membership_id, row.user_id],
          );
        }
      }
      await discover(tx);
      await rebindGoogleJobs(tx);
      const jobs = z.array(jobSchema).parse(
        (
          await tx.client.query(
            `SELECT j.* FROM ${table(tx, 'embedding_jobs')} j
        WHERE ((j.state IN ('queued','capacity-blocked') AND j.dispatch_after<=clock_timestamp())
          OR (j.purpose='ingestion' AND j.profile_id=$1
            AND EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
              WHERE d.id=j.document_id AND d.observed_revision_id=j.revision_id AND d.lexical_publication_id=j.publication_id
                AND d.tombstoned_at IS NULL AND s.state='active' AND s.access_epoch=j.access_epoch
                AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'vector_publications')} p WHERE p.id=d.vector_publication_id AND p.profile_id=j.profile_id))
            AND (SELECT count(*) FROM ${table(tx, 'embedding_items')} i JOIN ${table(tx, 'embedding_vectors')} v USING (profile_id,input_hash)
              WHERE i.job_id=j.id)=j.total_chunks))
          AND NOT (j.purpose='ingestion' AND EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.id=j.document_id AND d.source_id=ANY($2::uuid[])))
        ORDER BY j.dispatch_after,j.id LIMIT 100`,
            [profile.id, held],
          )
        ).rows,
      );
      const work: EmbeddingWork[] = [];
      for (const job of jobs) {
        try {
          await authorized(tx, job, undefined, true);
        } catch (error) {
          if (!(error instanceof AccessDenied) && !(error instanceof KnowledgeError)) throw error;
          await tx.client.query(`UPDATE ${table(tx, 'embedding_jobs')} SET state='failed' WHERE id=$1`, [job.id]);
          continue;
        }
        const status = await state(tx, job);
        if (status.state === 'ready') await publish(tx, job);
        else if (status.state === 'queued' || status.state === 'capacity-blocked')
          work.push({ workspaceId, jobId: job.id, generation: job.generation });
        else if (status.state === 'busy')
          await tx.client.query(
            `UPDATE ${table(tx, 'embedding_jobs')} SET dispatch_after=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
            [job.id],
          );
        else
          await tx.client.query(`UPDATE ${table(tx, 'embedding_jobs')} SET state=$2 WHERE id=$1`, [
            job.id,
            status.state,
          ]);
      }
      return work;
    });
  }
  async function documentJob(tx: Transaction, actor: HumanActor, documentId: string) {
    const doc = await store.document(tx, documentId);
    const job = jobSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${table(tx, 'embedding_jobs')} WHERE document_id=$1 AND revision_id=$2 AND publication_id=$3 AND profile_id=$4`,
            [doc.id, doc.observed_revision_id, doc.lexical_publication_id, profile.id],
          )
        ).rows[0],
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
        .parse(
          (
            await tx.client.query(
              `SELECT i.ordinal,i.input_hash AS "inputHash",v.vector FROM ${table(tx, 'embedding_items')} i JOIN ${table(tx, 'embedding_vectors')} v USING (profile_id,input_hash) WHERE i.job_id=$1 ORDER BY i.ordinal`,
              [job.id],
            )
          ).rows,
        );
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
        .parse(
          (
            await tx.client.query(
              `SELECT job_id FROM ${table(tx, 'embedding_retries')} WHERE membership_id=$1 AND command_id=$2`,
              [actor.membershipId, commandId],
            )
          ).rows[0],
        );
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
            await tx.client.query(
              `INSERT INTO ${table(tx, 'embedding_vectors')} (profile_id,input_hash,vector,attempt_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [claim.job.profile_id, claim.item.input_hash, JSON.stringify(valid.data), claim.attemptId],
            );
          await tx.client.query(
            `UPDATE ${table(tx, 'embedding_cache')} c SET state=CASE
            WHEN EXISTS (SELECT 1 FROM ${table(tx, 'embedding_vectors')} v WHERE v.profile_id=c.profile_id AND v.input_hash=c.input_hash) THEN 'ready' ELSE $4 END,
            lease_until=NULL WHERE profile_id=$1 AND input_hash=$2 AND attempt_id=$3`,
            [
              claim.job.profile_id,
              claim.item.input_hash,
              claim.attemptId,
              result.dispatch === 'undispatched' ? 'failed' : known === null ? 'unknown' : 'failed',
            ],
          );
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
        const code = z.object({ code: z.string() }).safeParse(error);
        const transient =
          error instanceof StorageUnavailableError
            ? ['queue_full', 'wait_timeout', 'pool_capacity', 'stale_credential'].includes(error.code)
            : code.success &&
              [
                '40001',
                '40P01',
                '55P03',
                '57014',
                '08000',
                '08001',
                '08003',
                '08006',
                '08007',
                '57P01',
                '57P02',
                '57P03',
                'ECONNRESET',
                'ECONNREFUSED',
                'ETIMEDOUT',
                'EPIPE',
              ].includes(code.data.code);
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
        .parse(
          (await tx.client.query(`SELECT task_flow_id FROM ${table(tx, 'search_queries')} WHERE job_id=$1`, [jobId]))
            .rows[0],
        )?.task_flow_id ?? null
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
          (
            await tx.client.query(`SELECT 1 FROM ${table(tx, 'documents')} WHERE id=$1 AND source_id=ANY($2::uuid[])`, [
              job.document_id,
              held,
            ])
          ).rowCount
        ) {
          await tx.client.query(
            `UPDATE ${table(tx, 'embedding_jobs')} SET dispatch_after=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
            [job.id],
          );
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
        const item = itemSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT i.* FROM ${table(tx, 'embedding_items')} i LEFT JOIN ${table(tx, 'embedding_vectors')} v USING (profile_id,input_hash) WHERE i.job_id=$1 AND v.input_hash IS NULL ORDER BY i.ordinal LIMIT 1`,
                [job.id],
              )
            ).rows[0],
          );
        if (!item) return 'failed';
        const cache = cacheSchema.parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table(tx, 'embedding_cache')} WHERE profile_id=$1 AND input_hash=$2 FOR UPDATE`,
              [job.profile_id, item.input_hash],
            )
          ).rows[0],
        );
        if (cache.state !== 'queued' || cache.attempts >= 8) return 'failed';
        if (signal?.aborted || (effectiveDeadlineAt !== undefined && clock.now() >= effectiveDeadlineAt))
          return 'stale';
        const attemptId = randomUUID();
        await tx.client.query(
          `UPDATE ${table(tx, 'embedding_cache')} SET state='claimed',attempt_id=$3,lease_until=least(clock_timestamp()+interval '2 minutes',COALESCE($4::timestamptz,'infinity')) WHERE profile_id=$1 AND input_hash=$2`,
          [
            job.profile_id,
            item.input_hash,
            attemptId,
            effectiveDeadlineAt === undefined ? null : new Date(effectiveDeadlineAt),
          ],
        );
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
        const owned = await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'embedding_cache')} WHERE profile_id=$1 AND input_hash=$2 AND attempt_id=$3 AND state='claimed' AND lease_until>clock_timestamp() FOR UPDATE`,
          [claim.job.profile_id, claim.item.input_hash, claim.attemptId],
        );
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
        if (
          refusal !== 'stale' &&
          (
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'embedding_vectors')} WHERE profile_id=$1 AND input_hash=$2`,
              [job.profile_id, claim.item.input_hash],
            )
          ).rowCount
        ) {
          await tx.client.query(
            `UPDATE ${table(tx, 'embedding_cache')} SET state='ready',lease_until=NULL WHERE profile_id=$1 AND input_hash=$2`,
            [job.profile_id, claim.item.input_hash],
          );
          const complete = (await state(tx, job)).state === 'ready';
          await tx.client.query(
            `UPDATE ${table(tx, 'embedding_jobs')} SET state=$2,dispatch_after=clock_timestamp() WHERE id=$1`,
            [job.id, complete ? 'ready' : 'queued'],
          );
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
          await tx.client.query(
            `UPDATE ${table(tx, 'embedding_cache')} SET state='queued',attempt_id=NULL,lease_until=NULL WHERE profile_id=$1 AND input_hash=$2`,
            [job.profile_id, claim.item.input_hash],
          );
          await tx.client.query(
            `UPDATE ${table(tx, 'embedding_jobs')} SET state=$2,dispatch_after=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
            [job.id, refusal === 'stale' ? 'failed' : refusal],
          );
          return refusal;
        }
        if (!(await usageMeter.markDispatched(tx, claim.attemptId))) throw new KnowledgeError('conflict');
        await tx.client.query(
          `UPDATE ${table(tx, 'embedding_cache')} SET state='dispatched',attempts=attempts+1,lease_until=clock_timestamp()+interval '5 minutes' WHERE profile_id=$1 AND input_hash=$2`,
          [job.profile_id, claim.item.input_hash],
        );
        await tx.client.query(`UPDATE ${table(tx, 'embedding_jobs')} SET state='queued' WHERE id=$1`, [job.id]);
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
