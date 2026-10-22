import { createConversationExecutor, type ConversationRuntime, type ReplyWork } from './runtime.ts';
import { observeChatStage, recordChatDispatch, type ChatDispatchSource } from '@tulipfarm/observability';

/**
 * The send route and the sweep share this path: the same due gates, the same deterministic start,
 * and the same outbox acknowledgement, so a race between them starts at most one reply per turn.
 */
export function createConversationDispatch(options: {
  runtime: ConversationRuntime;
  start: (work: ReplyWork, source: ChatDispatchSource) => Promise<void>;
}) {
  const executor = createConversationExecutor(options.runtime);
  return async (workspaceId: string, scope: { conversationId?: string; source?: ChatDispatchSource } = {}) => {
    const source = scope.source ?? 'sweep';
    const failures: unknown[] = [];
    for (const work of await executor.due(workspaceId, scope.conversationId)) {
      try {
        await observeChatStage('dispatch', () => options.start(work, source));
        await executor.acknowledge(work);
        recordChatDispatch(source, 'success');
      } catch (error) {
        recordChatDispatch(source, 'error');
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures.slice(0, 8), 'conversation-dispatch-incomplete');
  };
}
