import { ApplicationFailure } from '@temporalio/common';
import { z } from 'zod';
import { KnowledgeKeepUnavailable, type KnowledgeKeepFeed } from '@tulipfarm/knowledge';

const workspaceId = z.uuid();
const documentId = z.uuid();

export function createKnowledgeKeepActivities(feed: Pick<KnowledgeKeepFeed, 'due' | 'sync' | 'recordFailure'>) {
  return {
    async dueKnowledgeKeep(workspace: string, after: string | null, limit: number) {
      return feed.due(workspaceId.parse(workspace), after === null ? null : documentId.parse(after), limit);
    },
    async syncKnowledgeKeep(workspace: string, document: string) {
      try {
        return await feed.sync(workspaceId.parse(workspace), documentId.parse(document));
      } catch (error) {
        // Keep not answering is retried by Temporal; anything else is a bug that a retry will not fix.
        if (error instanceof KnowledgeKeepUnavailable) throw error;
        throw ApplicationFailure.nonRetryable(
          error instanceof Error ? error.message : 'Knowledge Keep delivery failed',
          'KnowledgeKeepFailed',
        );
      }
    },
    async recordKnowledgeKeepFailure(workspace: string, document: string, error: string, permanent: boolean) {
      await feed.recordFailure(workspaceId.parse(workspace), documentId.parse(document), error, permanent);
    },
  };
}
