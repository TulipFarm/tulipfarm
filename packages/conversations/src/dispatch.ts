import { createConversationExecutor, type ConversationRuntime, type ReplyWork } from './runtime.ts';
import { observeChatStage } from '@tulipfarm/observability';

export function createConversationDispatch(options: {
  runtime: ConversationRuntime;
  start: (work: ReplyWork) => Promise<void>;
}) {
  const executor = createConversationExecutor(options.runtime);
  return async (workspaceId: string) => {
    let failed = false;
    for (const work of await executor.due(workspaceId)) {
      try {
        await observeChatStage('dispatch', () => options.start(work));
        await executor.acknowledge(work);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('conversation-dispatch-incomplete');
  };
}
