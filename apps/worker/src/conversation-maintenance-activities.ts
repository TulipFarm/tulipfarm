import { createConversationMaintenance, type ConversationRecapPublisher } from '@tulipfarm/conversations/maintenance';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { ConversationCompactor } from '@tulipfarm/conversations/compaction';
import { withFileSources } from '@tulipfarm/conversations/file-references';
import { createFiles } from '@tulipfarm/files';
import {
  createConversationKnowledge,
  createKnowledgeEmbeddings,
  createLearnedKnowledge,
  KnowledgeError,
  withKnowledgeSourceAuthorization,
} from '@tulipfarm/knowledge';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { parseKnowledgeEmbeddingsConfig } from '@tulipfarm/config';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { conversationCompactor } from './conversation-compactor.ts';
import { conversationModel } from './conversation-model.ts';

export function createConversationMaintenanceActivities(
  storage: ConversationRuntime,
  options: {
    compactor?: ConversationCompactor;
    publish?: ConversationRecapPublisher;
    embeddings?: () => ReturnType<typeof createKnowledgeEmbeddings> | undefined;
  } = {},
) {
  const runtime = withFileSources(withKnowledgeSourceAuthorization(withGitHubSourceAuthorization(storage)));
  const maintenance = createConversationMaintenance(runtime);
  const compactor = options.compactor ?? conversationCompactor(runtime, family => conversationModel(family));
  const embeddings = createKnowledgeEmbeddings({ runtime, config: parseKnowledgeEmbeddingsConfig(process.env) });
  const publish: ConversationRecapPublisher =
    options.publish ??
    (input =>
      createConversationKnowledge({ runtime, embeddings: options.embeddings?.() ?? embeddings }).publish(input));
  const learned = learnedKnowledge(runtime);
  return {
    processConversationMaintenance: (work: unknown) => maintenance.process(work, compactor, publish, learned),
  };
}

/** Learned entries are plain notes, so the writer never reads or stores file bytes. */
export function learnedKnowledge(runtime: Parameters<typeof createLearnedKnowledge>[0]['runtime']) {
  const unavailable = async (): Promise<never> => {
    throw new KnowledgeError('adapter-required');
  };
  return createLearnedKnowledge({
    runtime,
    files: createFiles(runtime, { read: unavailable, putIfAbsent: unavailable, remove: unavailable }),
    enabled: workspaceId => isFeatureEnabled('learned-knowledge', null, { id: workspaceId }).catch(() => false),
  });
}
