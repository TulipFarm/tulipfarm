import { createConversationMaintenance, type ConversationRecapPublisher } from '@tulipfarm/conversations/maintenance';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { ConversationCompactor } from '@tulipfarm/conversations/compaction';
import { withFileSources } from '@tulipfarm/conversations/file-references';
import {
  createConversationKnowledge,
  createKnowledgeEmbeddings,
  withKnowledgeSourceAuthorization,
} from '@tulipfarm/knowledge';
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
  return { processConversationMaintenance: (work: unknown) => maintenance.process(work, compactor, publish) };
}
