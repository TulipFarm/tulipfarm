import type { AvatarState } from '@tulipfarm/conversations/avatar';
import type { ConversationMessage } from './conversation-api';
import type { ConversationStreamSnapshot } from './conversation-stream';

export function budState(
  messages: ConversationMessage[] | undefined,
  pending: boolean,
  stream: ConversationStreamSnapshot,
): AvatarState {
  if (pending) return 'Thinking';
  const turn = messages?.filter(message => message.turn).at(-1)?.turn;
  if (!turn) return 'Idle';
  if (turn.status === 'failed' || turn.status === 'blocked') return 'Confused';
  if (turn.status === 'cancelled') return 'Idle';
  if (turn.status === 'waiting' || turn.status === 'reconciling') return 'Listening';
  const update = stream.avatars?.get(turn.id);
  const progress = stream.progress.get(turn.id);
  if (
    stream.status === 'open' &&
    update?.generation === turn.generation &&
    (!progress || update.epoch >= progress.epoch)
  )
    return update.avatar.state;
  return turn.status === 'queued' || turn.status === 'processing' ? 'Thinking' : 'Idle';
}

export function emptyChatIntro(draft: boolean, sharedChat: boolean) {
  if (!draft) return 'Turn a business task into a clear next step.';
  return sharedChat
    ? 'New shared chat. Your first message starts it; earlier chats stay separate.'
    : 'New personal chat. Your first message starts it; earlier chats stay separate.';
}
