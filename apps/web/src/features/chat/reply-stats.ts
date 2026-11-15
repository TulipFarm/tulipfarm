import type { MessageActionsStats } from '@tulipfarm/sprout/message-actions';
import type { ConversationMessage } from './conversation-api.ts';
import { replyModel } from './reply-failure-copy.ts';
import { modelName } from '../models/model-name.ts';

/** Stats for the reply at `index`: they live on the turn of the person's message that asked for it. */
export function replyStats(
  messages: readonly ConversationMessage[],
  index: number,
  families: readonly { id: string; displayName: string }[],
): MessageActionsStats | undefined {
  if (messages[index]?.author !== 'assistant') return undefined;
  let at = index - 1;
  while (at >= 0 && messages[at]!.author !== 'human') at -= 1;
  const turn = messages[at]?.turn;
  if (!turn?.stats) return undefined;
  const { model, firstTextMs, durationMs, traceId } = turn.stats;
  const family = replyModel(model, turn.errorCode);
  return {
    model: family && modelName(families, family),
    firstTokenMs: firstTextMs,
    durationMs,
    traceId,
  };
}
