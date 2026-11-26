import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  type Actor,
  type AuthorizationTransaction,
  type HumanActor,
  type SourceDependency,
} from './authorization/contracts.ts';
import {
  admitKnowledgePrincipal,
  authorizeKnowledgeDocument,
  bindKnowledgeAuthorization,
  createKnowledgeAuthorizer,
} from './authorization/authorizer.ts';
import {
  commonCompatibility,
  StorageUnavailableError,
  transientStorageError,
  type createWorkspaceRuntime,
} from '@tulipfarm/workspace-storage/runtime';
import type { TenantRuntime } from '@tulipfarm/memory-core/ports/tenant-runtime';
import type { KnowledgeAuthorization } from '@tulipfarm/memory-core/ports/knowledge-authorization';
import type { ExternalSource } from '@tulipfarm/memory-core/documents/records';

export type KnowledgeTransaction = AuthorizationTransaction & { workspaceId: string; commonVersion: number };
/** The common migration that keeps Knowledge quota usage in `tf_knowledge_usage`. Before it, usage is summed. */
export const knowledgeUsageVersion = 99;
export const tracksKnowledgeUsage = (tx: { commonVersion?: number }) =>
  (tx.commonVersion ?? 0) >= knowledgeUsageVersion;
/** The common migration that deletes a synced document's superseded revisions. */
export const knowledgePruningVersion = 121;
export const prunesKnowledgeRevisions = (tx: { commonVersion?: number }) =>
  (tx.commonVersion ?? 0) >= knowledgePruningVersion;
export type KnowledgeRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export const knowledgeAccessErrors = { AccessDenied, SourceAuthorizationUnavailable };
export const knowledgeStorageErrors = {
  timeout: () => new StorageUnavailableError('wait_timeout'),
  deadline(error: unknown) {
    return (
      (error instanceof StorageUnavailableError &&
        ['wait_timeout', 'queue_full', 'pool_capacity'].includes(error.code)) ||
      (error instanceof Error && 'code' in error && (error.code === '57014' || error.code === '55P03'))
    );
  },
  transient: transientStorageError,
};

export function knowledgeTenantRuntime(runtime: KnowledgeRuntime): TenantRuntime<KnowledgeTransaction> {
  return {
    transaction: (tenantId, options, operation) =>
      runtime.transaction(tenantId, { ...commonCompatibility, ...options }, operation),
  };
}

export function knowledgeAuthorization(
  external: {
    requireExternalSource?: (tx: AuthorizationTransaction, actor: HumanActor, source: ExternalSource) => Promise<void>;
    requireExternalProof?: (tx: AuthorizationTransaction, actor: HumanActor, documentId: string) => Promise<void>;
  } = {},
): KnowledgeAuthorization<KnowledgeTransaction, SourceDependency> {
  return {
    authority: (tx, actor) => createKnowledgeAuthorizer(tx, actor, external),
    admit: (tx, actor: Actor | string, mode) => admitKnowledgePrincipal(tx, actor, mode),
    document: authorizeKnowledgeDocument,
    bind: bindKnowledgeAuthorization,
    knowledgeDependency: dependency => (dependency.kind === 'knowledge-document' ? dependency : undefined),
  };
}

export function transactionRepository<Value>(create: (tx: KnowledgeTransaction) => Value) {
  const repositories = new WeakMap<KnowledgeTransaction, Value>();
  return (tx: KnowledgeTransaction): Value => {
    const existing = repositories.get(tx);
    if (existing !== undefined) return existing;
    const repository = create(tx);
    repositories.set(tx, repository);
    return repository;
  };
}
