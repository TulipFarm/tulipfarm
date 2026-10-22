import { useEffect, useState } from 'react';
import type { ChatDocument } from '@tulipfarm/conversations/rich-content';
import type { SpinnerActivity } from '@tulipfarm/sprout/spinner';
import type { ConversationMessage, SkillReference } from './conversation-api';
import type { useConversationCommand } from './conversation-state';
import type { ConversationStreamSnapshot } from './conversation-stream';
import type { FileReference } from './draft-files';

export type OutgoingMessage = {
  id: string;
  content: ChatDocument;
  references: FileReference[];
  skill: SkillReference | null;
  at: number;
};
type ReplyInput = {
  messages: ConversationMessage[] | undefined;
  outgoing: OutgoingMessage | null;
  command: ReturnType<typeof useConversationCommand>['state']['kind'];
  stream: ConversationStreamSnapshot;
};

/** Saved turns decide which stream generation belongs to the current reply. */
export function currentReply({ messages, outgoing, command, stream }: ReplyInput) {
  const pending =
    outgoing &&
    (command === 'sending' || (command === 'accepted' && !messages?.some(message => message.id === outgoing.id)))
      ? outgoing
      : null;
  const replying = messages
    ?.filter(message => message.turn && ['queued', 'processing'].includes(message.turn.status))
    .at(-1);
  const turn = replying?.turn;
  const tools = replying?.tools ?? [];
  const preview = turn && stream.previews.get(turn.id);
  const previewText = preview && preview.identity.generation === turn?.generation ? preview.text : '';
  const progressUpdate = turn && stream.progress.get(turn.id);
  const progress = progressUpdate && progressUpdate.generation === turn?.generation ? progressUpdate : undefined;
  const running = tools.find(tool => (tool.activityStatus ?? tool.status) === 'running');
  // A step ending in tool calls narrates work; only the final step's text is the answer.
  const narration =
    previewText && (running || (progress && preview && preview.identity.step < progress.step)) ? previewText : '';
  const answerText = narration ? '' : previewText;
  const activity = thinkingOf(running, tools.length > 0, progress);
  const queuedKey = turn?.status === 'queued' ? `${turn.id}:${turn.generation}` : null;
  const processingKey =
    turn?.status === 'processing'
      ? [
          turn.id,
          turn.generation,
          progress?.step,
          tools.map(tool => tool.activityStatus ?? tool.status).join(','),
          previewText.length,
        ].join(':')
      : null;
  return {
    pending,
    turn,
    thinking: !!pending || !!replying,
    since: replying?.createdAt ?? pending?.at,
    narration,
    answerText,
    activity,
    queuedKey,
    processingKey,
  };
}

function thinkingOf(
  running: ConversationMessage['tools'][number] | undefined,
  hasTools: boolean,
  progress?: { round: number },
) {
  const state: { activity: SpinnerActivity; label: string } = !running
    ? { activity: 'working', label: hasTools || (progress?.round ?? 1) > 1 ? 'Planning next step' : 'Thinking' }
    : /\.(draft|propose)$/.test(running.tool)
      ? { activity: 'shaping', label: 'Drafting' }
      : /\.(execute|send|reply|add|create|update|delete|save)$/.test(running.tool)
        ? { activity: 'connecting', label: 'Working' }
        : { activity: 'searching', label: 'Searching' };
  return progress && progress.round > 1 ? { ...state, label: `${state.label} · Step ${progress.round}` } : state;
}

export function useCurrentReply(input: ReplyInput) {
  const { queuedKey, processingKey, ...reply } = currentReply(input);
  const [stalledKey, setStalledKey] = useState<string | null>(null);
  useEffect(() => {
    if (!queuedKey) return;
    const timer = setTimeout(() => setStalledKey(queuedKey), 60_000);
    return () => {
      clearTimeout(timer);
      setStalledKey(null);
    };
  }, [queuedKey]);
  const [slowKey, setSlowKey] = useState<string | null>(null);
  useEffect(() => {
    if (!processingKey) return;
    const timer = setTimeout(() => setSlowKey(processingKey), 20_000);
    return () => clearTimeout(timer);
  }, [processingKey]);
  return {
    ...reply,
    stalledTurn: queuedKey && stalledKey === queuedKey ? reply.turn : null,
    slowTurn: processingKey && slowKey === processingKey && !reply.answerText ? reply.turn : null,
  };
}
