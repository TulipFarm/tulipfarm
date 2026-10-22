import { z } from 'zod';
import {
  AccessDenied,
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
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { requireAccess, type AccessDecision, type Authorizer } from '@tulipfarm/memory-core/ports/authorizer';
import type { Clock } from '@tulipfarm/memory-core/ports/runtime';
import { knowledgeSearchFiltersSchema } from '../contracts.ts';
import { createKnowledgeEligibilityFilter, type KnowledgeEligibilitySelection } from './eligibility.ts';
import { KnowledgeError, originalSchema } from '../internal/contracts.ts';
import type { ExternalSource, KnowledgeDocument, KnowledgeOptions } from '../internal/store.ts';
import { requireConversationReader, requireConversationRevision } from './conversation.ts';

type Transaction = AuthorizationTransaction & { workspaceId: string; commonVersion: number };
type Dependency = Extract<SourceDependency, { kind: 'knowledge-document' }>;
type ExternalAuthority = Pick<KnowledgeOptions, 'requireExternalSource' | 'requireExternalProof'>;
type Checks = {
  source: { input: { value: ExternalSource | undefined; writing: boolean }; value: ExternalSource };
  dependencies: {
    input: { original: z.infer<typeof originalSchema>; sources: SourceDependency[] };
    value: SourceDependency[];
  };
  observation: { input: { sources: SourceDependency[]; conversation: boolean; documentId: string }; value: void };
  protectedSource: { input: SourceDependency; value: void };
  file: { input: string; value: Awaited<ReturnType<typeof requireReadableFile>> };
  member: { input: undefined; value: Awaited<ReturnType<typeof currentMember>> };
  task: { input: string; value: void };
  conversation: { input: { revisionId: string; writing: boolean }; value: void };
  proof: { input: { document: KnowledgeDocument; source: ExternalSource }; value: void };
  tenant: { input: string; value: void };
  binding: { input: { document: KnowledgeDocument; source: ExternalSource; dependency: Dependency }; value: void };
  embeddingOwner: { input: { owner_membership_id: string; owner_user_id: string }; value: void };
  embeddingProvider: { input: { source: ExternalSource; providers: string[] }; value: void };
  queryDispatch: {
    input: { jobId: string; selection: KnowledgeEligibilitySelection; clock: Clock };
    value: number | undefined;
  };
};

async function decision<Value>(operation: () => Value | Promise<Value>): Promise<AccessDecision<Value>> {
  try {
    return { kind: 'allowed', value: await operation() };
  } catch (error) {
    if (error instanceof AccessDenied || error instanceof KnowledgeError) return { kind: 'denied', error };
    throw error;
  }
}

export const knowledgeEgressPolicy = { deny: denyMcpEgress };

export function authorizeKnowledgeDocument(value: KnowledgeDocument | undefined) {
  return decision(() => {
    if (!value || value.tombstoned_at) throw new AccessDenied();
    return value;
  });
}

export function lockKnowledgeAuthorization(tx: AuthorizationTransaction, mode: 'read' | 'write') {
  return decision(() => lockAuthorization(tx, mode));
}

export function resolveKnowledgeMember(tx: AuthorizationTransaction, userId: string) {
  return decision(async () => {
    const actor = await resolveHuman(tx, userId);
    await currentMember(tx, actor);
    return actor;
  });
}

export function admitKnowledgePrincipal(
  tx: AuthorizationTransaction,
  actorInput: Actor | string,
  mode: 'read' | 'write',
) {
  return decision(async () => {
    await lockAuthorization(tx, mode);
    const actor = typeof actorInput === 'string' ? await resolveHuman(tx, actorInput) : actorSchema.parse(actorInput);
    if (actor.kind !== 'human') throw new AccessDenied();
    await currentMember(tx, actor);
    return actor;
  });
}

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

export function createKnowledgeAuthorizer(
  tx: Transaction,
  actor: HumanActor,
  external: ExternalAuthority = {},
): Authorizer<Checks> {
  const { requireExternalSource, requireExternalProof } = external;
  const handlers: { [Check in keyof Checks]: (input: Checks[Check]['input']) => Promise<Checks[Check]['value']> } = {
    async source({ value, writing }) {
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
    },
    async dependencies(revision) {
      if (revision.original.kind === 'file') {
        const file = await requireReadableFile(tx, actor, revision.original.fileId);
        if (file.sha256 !== revision.original.sha256 || file.size !== revision.original.bytes) throw new AccessDenied();
      }
      return protectedSourceClosure(tx, revision.sources);
    },
    async observation({ sources, conversation, documentId }) {
      await requireNoMcpDerived(tx, sources);
      const closure = await protectedSourceClosure(tx, sources);
      if (
        !conversation &&
        closure.some(item =>
          ['github-personal', 'private-task', 'private-conversation', 'knowledge-document'].includes(item.kind),
        )
      )
        throw new AccessDenied();
      if (conversation && closure.some(item => item.kind === 'knowledge-document' && item.documentId === documentId))
        throw new AccessDenied();
    },
    protectedSource: source => requireProtectedSource(tx, actor, source),
    file: fileId => requireReadableFile(tx, actor, fileId),
    member: () => currentMember(tx, actor),
    task: runId => requireTaskRun(tx, actor, runId),
    conversation: ({ revisionId, writing }) => requireConversationRevision(tx, actor, revisionId, writing),
    async proof({ document: doc, source: origin }) {
      if (origin.provider === 'note' || origin.provider === 'file') return;
      if (origin.provider === 'conversation') {
        if (!doc.observed_revision_id) throw new AccessDenied();
        await requireConversationRevision(tx, actor, doc.observed_revision_id);
        return;
      }
      if (requireExternalProof) await requireExternalProof(tx, actor, doc.id);
      const proof = await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, 'tf_knowledge_access_proofs')}
      WHERE document_id=$1 AND membership_id=$2 AND access_epoch=$3
        AND acl_checked_at<=clock_timestamp() AND membership_checked_at<=clock_timestamp()
        AND expires_at>clock_timestamp()`,
        [doc.id, actor.membershipId, origin.access_epoch],
      );
      if (!proof.rowCount) throw new KnowledgeError('permission-expired');
    },
    async tenant(tenantId) {
      if (tenantId !== tx.workspaceId) throw new AccessDenied();
    },
    async binding({ document: doc, source: origin, dependency }) {
      if (origin.id !== dependency.sourceId || origin.access_epoch !== dependency.accessEpoch) throw new AccessDenied();
      if (doc.observed_revision_id !== dependency.revisionId || doc.lexical_publication_id !== dependency.publicationId)
        throw new KnowledgeError('superseded');
    },
    async embeddingOwner(job) {
      if (job.owner_membership_id !== actor.membershipId || job.owner_user_id !== actor.userId)
        throw new AccessDenied();
    },
    async embeddingProvider({ source: origin, providers }) {
      if (
        origin.provider !== 'note' &&
        origin.provider !== 'file' &&
        origin.provider !== 'conversation' &&
        !providers.includes(origin.provider)
      )
        throw new AccessDenied();
    },
    async queryDispatch({ jobId, selection, clock }) {
      const scope = z
        .object({
          filters: knowledgeSearchFiltersSchema,
          expires_at: z.date(),
          cancelled: z.boolean(),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT filters,expires_at,cancelled FROM ${qualified(tx.schema, 'tf_knowledge_search_queries')} WHERE job_id=$1`,
              [jobId],
            )
          ).rows[0],
        );
      if (scope) {
        if (scope.cancelled || scope.expires_at.getTime() <= clock.now()) throw new AccessDenied();
        const { kinds, sourceIds, documentIds } = scope.filters;
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM (${createKnowledgeEligibilityFilter(tx.schema).predicate(selection)}) eligible WHERE vector_publication_id IS NOT NULL LIMIT 1`,
              [actor.membershipId, actor.userId, kinds, sourceIds, documentIds],
            )
          ).rowCount
        )
          throw new AccessDenied();
        return scope.expires_at.getTime();
      }
    },
  };
  return {
    decide: (check, input) => decision(() => handlers[check](input)),
  };
}

export function bindKnowledgeAuthorization<X extends Transaction>(
  tx: X,
  eligible: (tx: Transaction, actor: HumanActor, dependency: Dependency) => Promise<unknown>,
): X {
  const bound: X = { ...tx };
  bound.knowledgeSourceDependencies = async dependency => {
    if (dependency.workspaceId !== tx.workspaceId) throw new AccessDenied();
    const table = (name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
    const row = (
      await tx.client.query(
        `SELECT r.sources FROM ${table('revisions')} r
        JOIN ${table('documents')} d ON d.id=r.document_id
        JOIN ${table('publications')} p ON p.document_id=d.id AND p.revision_id=r.id
        WHERE r.id=$1 AND d.id=$2 AND d.source_id=$3 AND p.id=$4`,
        [dependency.revisionId, dependency.documentId, dependency.sourceId, dependency.publicationId],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    return sourceDependenciesSchema.parse(row.sources);
  };
  // A task retains its requester's authority only while bound to the current task.
  bound.requireKnowledgeSource = async (actor, dependency, context) => {
    const authorizer = createKnowledgeAuthorizer(bound, actor);
    requireAccess(await authorizer.decide('member', undefined));
    if (context.runId) requireAccess(await authorizer.decide('task', context.runId));
    try {
      await eligible(bound, actor, dependency);
    } catch (error) {
      if (error instanceof KnowledgeError) throw new AccessDenied();
      throw error;
    }
  };
  return bound;
}

export async function selectedKnowledgeReaders(
  tx: Transaction,
  actor: HumanActor,
  providers: { slack: boolean; github: boolean; atlassian: boolean },
) {
  const table = (name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
  const slack =
    providers.slack &&
    !!(
      await tx.client.query(`SELECT 1 FROM ${table('slack_members')} WHERE membership_id=$1 LIMIT 1`, [
        actor.membershipId,
      ])
    ).rowCount;
  const github =
    providers.github &&
    !!(
      await tx.client.query(`SELECT 1 FROM ${table('github_members')} WHERE membership_id=$1 LIMIT 1`, [
        actor.membershipId,
      ])
    ).rowCount;
  const atlassian =
    providers.atlassian &&
    !!(
      await tx.client.query(`SELECT 1 FROM ${table('atlassian_members')} WHERE membership_id=$1 LIMIT 1`, [
        actor.membershipId,
      ])
    ).rowCount;
  return { slack, github, atlassian };
}
