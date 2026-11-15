import { useEffect, useState } from 'react';
import type { ChatDocument } from '@tulipfarm/conversations/rich-content';
import type { StreamProgress } from '@tulipfarm/conversations/events';
import type { SpinnerActivity } from '@tulipfarm/sprout/spinner';
import type { ConversationMessage, SkillReference } from './conversation-api';
import type { CommandState } from './conversation-state';
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
  command: CommandState;
  stream: ConversationStreamSnapshot;
};

/** Saved turns decide which stream generation belongs to the current reply. */
export function currentReply({ messages, outgoing, command, stream }: ReplyInput) {
  // Only the send that created this message shows it; retries and other commands reuse saved turns.
  const sending =
    (['sending', 'checking', 'uncertain'].includes(command.kind) &&
      'command' in command &&
      command.command.kind === 'send' &&
      command.command.messageId === outgoing?.id) ||
    (command.kind === 'accepted' && command.operation === 'send');
  const pending = outgoing && sending && !messages?.some(message => message.id === outgoing.id) ? outgoing : null;
  const unconfirmed = command.kind === 'checking' || command.kind === 'uncertain';
  // A message queued while the workspace updates shows as sent, labelled, without a reply indicator.
  const waiting = !!pending && command.kind === 'sending' && !!command.waiting;
  const first = messages?.find(
    message => message.turn && ['queued', 'processing', 'waiting', 'reconciling'].includes(message.turn.status),
  );
  const replying = first?.turn && ['queued', 'processing'].includes(first.turn.status) ? first : undefined;
  const queuedMessages =
    messages?.filter(message => message.turn?.status === 'queued' && first && message.sequence > first.sequence) ?? [];
  const pendingQueued = !!pending && !!first && !unconfirmed;
  const queueLabel =
    first?.turn && ['waiting', 'reconciling'].includes(first.turn.status)
      ? 'Waiting for your answer above. This message will be answered next.'
      : 'This message will be answered after the reply above.';
  const turn = replying?.turn;
  const tools = replying?.tools ?? [];
  const preview = turn && stream.previews.get(turn.id);
  const previewText = preview && preview.identity.generation === turn?.generation ? preview.text : '';
  const progressUpdate = turn && stream.progress.get(turn.id);
  const progress = progressUpdate && progressUpdate.generation === turn?.generation ? progressUpdate : undefined;
  const running = tools.find(tool => (tool.activityStatus ?? tool.status) === 'running');
  // A step ending in tool calls narrates work; only the final step's text is the answer.
  const stepText =
    previewText && (running || (progress && preview && preview.identity.step < progress.step)) ? previewText : '';
  // A saved tool row shows the same text in the activity list, so the live note steps aside.
  const narration = tools.some(tool => tool.narration?.includes(stepText.trim())) ? '' : stepText;
  const layoutState = turn && stream.layouts?.get(turn.id);
  // A layout from an earlier step than the latest text was given up for a text answer.
  const layoutJson =
    layoutState &&
    layoutState.identity.generation === turn?.generation &&
    (!preview || layoutState.identity.step >= preview.identity.step)
      ? layoutState.text
      : '';
  const answerText = stepText || layoutJson ? '' : previewText;
  const activity = thinkingOf(running, tools.length > 0, progress);
  const queuedKey = turn?.status === 'queued' ? `${turn.id}:${turn.generation}` : null;
  const processingKey =
    turn?.status === 'processing'
      ? [
          turn.id,
          turn.generation,
          progress?.step,
          progress?.status,
          progress?.toolRounds,
          tools.map(tool => tool.activityStatus ?? tool.status).join(','),
          previewText.length,
          layoutJson.length,
        ].join(':')
      : null;
  return {
    pending,
    /** The composer hides its submitted draft until the send settles, even after saved history shows the message. */
    draftSent: (!!pending && !unconfirmed) || (command.kind === 'sending' && command.command.kind === 'send'),
    turn,
    thinking: (!!pending && !waiting && !pendingQueued && !unconfirmed) || !!replying,
    waiting,
    pendingQueued,
    queuedMessages,
    queueLabel,
    unconfirmed,
    since: replying?.createdAt ?? pending?.at,
    narration,
    answerText,
    /** The streaming `reply.render` arguments of the current reply, drawn as a layout preview. */
    layoutJson,
    activity,
    /** The worker's reported status. Without one, labels fall back to rounds and saved tools. */
    status: progress?.status,
    queuedKey,
    processingKey,
  };
}

type Activity = { activity: SpinnerActivity; label: string };

function runningActivity(tool: string): Activity {
  return /\.(draft|propose)$/.test(tool)
    ? { activity: 'shaping', label: 'Drafting' }
    : /\.(execute|send|reply|add|create|update|delete|save)$/.test(tool)
      ? { activity: 'connecting', label: 'Working' }
      : { activity: 'searching', label: 'Searching' };
}

function thinkingOf(
  running: ConversationMessage['tools'][number] | undefined,
  hasTools: boolean,
  progress?: Pick<StreamProgress, 'round' | 'status' | 'tool' | 'toolRounds'>,
): Activity {
  if (progress?.status) {
    const rounds = progress.toolRounds ?? 0;
    const step = rounds > 0 ? ` · Step ${rounds + 1}` : '';
    switch (progress.status) {
      case 'thinking':
        return { activity: 'working', label: rounds > 0 ? `Planning next step${step}` : 'Thinking' };
      case 'tool':
        return {
          activity: running ? runningActivity(running.tool).activity : 'working',
          label: `Using ${progress.tool ?? 'a tool'}…${step}`,
        };
      default:
        return { activity: 'working', label: 'Finishing up' };
    }
  }
  const state: Activity = running
    ? runningActivity(running.tool)
    : { activity: 'working', label: hasTools || (progress?.round ?? 1) > 1 ? 'Planning next step' : 'Thinking' };
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
    slowTurn: processingKey && slowKey === processingKey && !reply.answerText && !reply.layoutJson ? reply.turn : null,
  };
}
