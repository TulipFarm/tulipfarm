import { createConversationExecutor, type ConversationRuntime, type ReplyWork } from './runtime.ts';
import { observeChatStage, recordChatDispatch, type ChatDispatchSource } from '@tulipfarm/observability';

/** Default time a started reply may stay unclaimed before the sweep starts it again. */
export const defaultDispatchGraceMs = 5_000;

/**
 * The send route and the sweep share this path: the same due gates, the same deterministic start, and the same
 * outbox lease and acknowledgement. Each turn is leased for `graceMs` before its start, so a sweep that runs while a
 * send is starting skips that turn instead of starting it again; the deterministic workflow id stays the second guard.
 */
export function createConversationDispatch(options: {
  runtime: ConversationRuntime;
  start: (work: ReplyWork, source: ChatDispatchSource) => Promise<void>;
  graceMs?: number;
}) {
  const executor = createConversationExecutor(options.runtime);
  const graceMs = options.graceMs ?? defaultDispatchGraceMs;
  return async (workspaceId: string, scope: { conversationId?: string; source?: ChatDispatchSource } = {}) => {
    const source = scope.source ?? 'sweep';
    const failures: unknown[] = [];
    for (const { work, reason } of await executor.lease(workspaceId, scope.conversationId, graceMs)) {
      let started = false;
      try {
        await observeChatStage('dispatch', () => options.start(work, source));
        started = true;
        await executor.acknowledge(work, graceMs);
        recordChatDispatch(source, 'success', reason);
      } catch (error) {
        recordChatDispatch(source, 'error', reason);
        failures.push(error);
        // A failed start goes straight back to the sweep; a started reply keeps its lease, so the sweep only re-checks it.
        if (!started) await executor.release(work).catch(() => undefined);
      }
    }
    if (failures.length) throw new AggregateError(failures.slice(0, 8), 'conversation-dispatch-incomplete');
  };
}
