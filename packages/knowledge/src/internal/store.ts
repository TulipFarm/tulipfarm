import { z } from 'zod';
import {
  invalidateRecommendationSource,
  recordRecommendationChange,
} from '@tulipfarm/workspace-storage/recommendations';
import { createPostgresKnowledgeRepository } from '@tulipfarm/memory-postgres';
import { createDocumentStore } from '@tulipfarm/memory-core/documents/store';
import type { ExternalSource, KnowledgeDocument } from '@tulipfarm/memory-core/documents/records';
import {
  sourceDependenciesSchema,
  type AuthorizationTransaction,
  type HumanActor,
  type SourceDependency,
} from '../authorization/contracts.ts';
import { knowledgeEgressPolicy } from '../authorization/authorizer.ts';
import {
  knowledgeTenantRuntime,
  knowledgeAuthorization,
  knowledgeAccessErrors,
  transactionRepository,
  type KnowledgeRuntime as Runtime,
  type KnowledgeTransaction,
} from '../storage-ports.ts';
import { proofInput, revisionInput } from './contracts.ts';
export { requireTaskRun } from '../authorization/authorizer.ts';
export type { ExternalSource, KnowledgeDocument };
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
  return createDocumentStore<KnowledgeTransaction, SourceDependency>({
    runtime: knowledgeTenantRuntime(runtime),
    repository: transactionRepository(tx =>
      createPostgresKnowledgeRepository(tx.client, { schema: tx.schema, tablePrefix: 'tf_knowledge_' }),
    ),
    authorization: knowledgeAuthorization({
      ...(requireExternalSource ? { requireExternalSource } : {}),
      ...(requireExternalProof ? { requireExternalProof } : {}),
    }),
    errors: knowledgeAccessErrors,
    tenantId: tx => tx.workspaceId,
    sourceDependenciesSchema,
    revisionInput,
    egressPolicy: knowledgeEgressPolicy,
    invalidateRecommendationSource,
    recordRecommendationChange,
    ...(refreshExternalProof ? { refreshExternalProof } : {}),
  });
}
export function createKnowledge(options: KnowledgeOptions) {
  return createKnowledgeStore(options).api;
}
