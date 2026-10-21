import type { Clock, UsageMeter } from '@tulipfarm/memory-core/ports/runtime';
import { createEmbeddingEngine } from '@tulipfarm/memory-core/embeddings';
import { createPostgresEmbeddingRepository } from '@tulipfarm/memory-postgres';
import { CreditsExhausted } from '@tulipfarm/workspace-storage/credits';
import {
  knowledgeHostPolicy,
  knowledgeUsageMeter,
  systemClock,
  type KnowledgeEmbeddingsConfig,
} from '../host-ports.ts';
import {
  knowledgeTenantRuntime,
  knowledgeAuthorization,
  knowledgeAccessErrors,
  knowledgeStorageErrors,
  transactionRepository,
} from '../storage-ports.ts';
import {
  knowledgeEgressPolicy,
  lockKnowledgeAuthorization,
  resolveKnowledgeMember,
} from '../authorization/authorizer.ts';
import {
  embeddingDiscoveryCandidate,
  changedConversationEmbeddingOwners,
} from '../authorization/embedding-candidates.ts';
import { createKnowledgeStore, type KnowledgeOptions } from './store.ts';
import {
  createKnowledgeEmbeddingProvider,
  prepareKnowledgeEmbeddingInputs,
  type KnowledgeEmbeddingProvider,
} from './embedding-provider.ts';
import type { GoogleKnowledge } from './google.ts';
import type { SlackKnowledge } from './slack.ts';
import type { GitHubKnowledge } from './github.ts';
import type { AtlassianKnowledge } from './atlassian.ts';
import { externalAuthority } from './external-authority.ts';
import type { KnowledgeSourceGate } from './rolling.ts';
import type { SourceDependency } from '../authorization/contracts.ts';
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

  return createEmbeddingEngine<Transaction, SourceDependency>({
    runtime: knowledgeTenantRuntime(runtime),
    store,
    repository: transactionRepository(tx =>
      createPostgresEmbeddingRepository(tx.client, { schema: tx.schema, tablePrefix: 'tf_knowledge_' }),
    ),
    authorization: knowledgeAuthorization(),
    lock: lockKnowledgeAuthorization,
    resolveMember: resolveKnowledgeMember,
    discoveryCandidate: embeddingDiscoveryCandidate,
    changedOwners: changedConversationEmbeddingOwners,
    selection: tx => ({
      google: !!google,
      slack: !!slack,
      github: !!github,
      atlassian: !!atlassian,
      conversation: tx.commonVersion >= 1,
    }),
    conversationEnabled: tx => tx.commonVersion >= 1,
    tenantId: tx => tx.workspaceId,
    externalProviders,
    egressPolicy: knowledgeEgressPolicy,
    errors: { AccessDenied: knowledgeAccessErrors.AccessDenied, CreditsExhausted },
    storageErrors: knowledgeStorageErrors,
    profile: knowledgeHostPolicy.embeddingProfile,
    enabled: () => config.kind !== 'disabled',
    provider,
    prepareInputs: prepareKnowledgeEmbeddingInputs,
    clock,
    usageMeter,
    capacity,
    ...(gate ? { gate } : {}),
  });
}
