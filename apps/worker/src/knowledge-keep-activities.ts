import { ApplicationFailure } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import { z } from 'zod';
import { knowledgeKeepFailures } from './knowledge-keep-failures.ts';
import { KnowledgeKeepUnavailable, type KnowledgeKeepFeed, type KnowledgeKeepFailureKind } from '@tulipfarm/knowledge';

const workspaceId = z.uuid();
const documentId = z.uuid();

function activityContext() {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
}

export function createKnowledgeKeepActivities(feed: Pick<KnowledgeKeepFeed, 'due' | 'sync' | 'recordFailure'>) {
  return {
    async dueKnowledgeKeep(workspace: string, after: string | null, limit: number) {
      return feed.due(workspaceId.parse(workspace), after === null ? null : documentId.parse(after), limit);
    },
    /**
     * Syncs one document, heartbeating before each Keep call so a large document can take as long as its batches need
     * while a stalled attempt is noticed within the heartbeat timeout. Keep failures are not retried here: the feed
     * backs the document off, and the workflow waits out an outage of Keep itself.
     */
    async syncKnowledgeKeep(workspace: string, document: string) {
      const context = activityContext();
      try {
        return await feed.sync(
          workspaceId.parse(workspace),
          documentId.parse(document),
          context ? { signal: context.cancellationSignal, progress: () => context.heartbeat() } : {},
        );
      } catch (error) {
        if (error instanceof KnowledgeKeepUnavailable)
          throw ApplicationFailure.nonRetryable(error.message, knowledgeKeepFailures[error.scope]);
        if (context?.cancellationSignal.aborted) throw error;
        throw ApplicationFailure.nonRetryable(
          error instanceof Error ? error.message : 'Knowledge Keep delivery failed',
          knowledgeKeepFailures.permanent,
        );
      }
    },
    async recordKnowledgeKeepFailure(
      workspace: string,
      document: string,
      error: string,
      kind: KnowledgeKeepFailureKind,
    ) {
      await feed.recordFailure(workspaceId.parse(workspace), documentId.parse(document), error, kind);
    },
  };
}
