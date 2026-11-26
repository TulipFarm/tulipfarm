import { createConversationMaintenance, type ConversationRecapPublisher } from '@tulipfarm/conversations/maintenance';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { ConversationCompactor } from '@tulipfarm/conversations/compaction';
import { withFileSources } from '@tulipfarm/conversations/file-references';
import { createFiles } from '@tulipfarm/files';
import {
  createConversationKnowledge,
  createLearnedKnowledge,
  KnowledgeError,
  withKnowledgeSourceAuthorization,
} from '@tulipfarm/knowledge';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { worthLearning } from '@tulipfarm/agents/decisions';
import { conversationCompactor } from './conversation-compactor.ts';
import { conversationModel } from './conversation-model.ts';

export function createConversationMaintenanceActivities(
  storage: ConversationRuntime,
  options: {
    compactor?: ConversationCompactor;
    publish?: ConversationRecapPublisher;
  } = {},
) {
  const runtime = withFileSources(withKnowledgeSourceAuthorization(withGitHubSourceAuthorization(storage)));
  const maintenance = createConversationMaintenance(runtime);
  const compactor = options.compactor ?? conversationCompactor(runtime, family => conversationModel(family));
  const publish: ConversationRecapPublisher =
    options.publish ?? (input => createConversationKnowledge({ runtime }).publish(input));
  const learned = learnedKnowledge(runtime);
  const learningGate = {
    memory: (workspaceId: string, transcript: string) => worthLearning(workspaceId, 'memory', transcript),
    knowledge: (workspaceId: string, content: string) => worthLearning(workspaceId, 'knowledge', content),
  };
  return {
    processConversationMaintenance: (work: unknown) =>
      maintenance.process(work, compactor, publish, learned, learningGate),
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
  });
}
