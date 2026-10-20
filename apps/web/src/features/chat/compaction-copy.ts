import type { CompactionDetail, CompactionPart } from './conversation-api';

export const compactCommandName = 'compact';
export const compactPromptLimit = 2000;

/** Reads a whole-message `/compact [handoff instructions]` command. Any other text, including a later `/compact`, is a message. */
export function compactCommand(text: string): { prompt?: string } | null {
  const match = /^\s*\/compact(?:\s+([\s\S]*))?$/u.exec(text);
  if (!match) return null;
  const prompt = match[1]?.trim();
  return prompt ? { prompt } : {};
}

export function compactCommandError(text: string) {
  const command = compactCommand(text);
  return command?.prompt && command.prompt.length > compactPromptLimit
    ? `Keep handoff instructions under ${compactPromptLimit.toLocaleString()} characters.`
    : null;
}

/** Whether a picker query should offer the compact command, such as `/com` or `/compact keep totals`. */
export function offersCompact(query: string) {
  const value = query.trimStart().toLowerCase();
  return (
    value.length > 0 && (compactCommandName.startsWith(value.trimEnd()) || value.startsWith(`${compactCommandName} `))
  );
}

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const tokenCount = (tokens: number) => compactNumber.format(tokens);
const share = (tokens: number, window: number) => `${Math.min(100, Math.round((tokens / window) * 100))}%`;

/** One line describing how much context the compaction freed. */
export function compactionUsage(part: Pick<CompactionPart, 'beforeTokens' | 'afterTokens' | 'windowTokens'>) {
  const { beforeTokens: before, afterTokens: after, windowTokens: window } = part;
  if (before === null) return null;
  if (after === null || !window) return `About ${tokenCount(before)} tokens of context`;
  return `About ${tokenCount(before)} → ${tokenCount(after)} tokens, ${share(before, window)} → ${share(after, window)} of the model context`;
}

const failures: Record<string, string> = {
  'compaction-model-unavailable':
    'No approved summary model is available. A workspace admin can choose one in Models settings.',
  'compaction-model-failed': 'The summary model could not finish. Your conversation is unchanged.',
  'compaction-ineffective': 'Summarizing did not free enough context. Start a new chat for unrelated work.',
  'compaction-invalid-summary': 'The summary model returned an unusable summary. Your conversation is unchanged.',
  'compaction-unmeasured':
    'The selected chat model has no known context size, so compaction could not measure this conversation.',
};
export const compactionFailure = (code: string | null) =>
  (code && failures[code]) ?? 'Compaction could not finish. Your conversation is unchanged.';

export function compactionTitle(part: Pick<CompactionPart, 'state' | 'trigger'>) {
  switch (part.state) {
    case 'compacted':
      return part.trigger === 'inactivity'
        ? 'Automatic chat recap'
        : part.trigger === 'automatic'
          ? 'Earlier messages summarized automatically'
          : 'Conversation compacted';
    case 'cleaned':
      return 'Older file contents unloaded';
    case 'unchanged':
      return 'Nothing to compact yet';
    case 'failed':
      return part.trigger === 'inactivity'
        ? 'Automatic recap needs attention'
        : part.trigger === 'automatic'
          ? 'Automatic compaction failed'
          : 'Compaction failed';
    default: {
      const exhaustive: never = part.state;
      return exhaustive;
    }
  }
}

export function compactionNote(part: Pick<CompactionPart, 'state' | 'errorCode'>) {
  switch (part.state) {
    case 'compacted':
      return 'The model now reads a summary of earlier messages. Your full conversation stays here.';
    case 'cleaned':
      return 'Earlier file contents were removed from model context. The files are unchanged and can be read again.';
    case 'unchanged':
      return 'Only the latest exchange is in this chat, so there is nothing earlier to summarize.';
    case 'failed':
      return compactionFailure(part.errorCode);
    default: {
      const exhaustive: never = part.state;
      return exhaustive;
    }
  }
}

export function handoffLabel(handoff: CompactionDetail['handoff']) {
  if (!handoff) return null;
  return handoff.status === 'completed'
    ? 'Handoff ready'
    : handoff.status === 'pending'
      ? 'Writing handoff…'
      : 'Handoff failed';
}

const contextFailures: Record<string, string> = {
  'context-limit':
    'This conversation no longer fits the model context. Compact and retry summarizes earlier messages first. Your full conversation stays in this chat.',
  'compaction-paused':
    'Automatic compaction is paused after repeated failures, and this conversation no longer fits. Compact and retry tries once more.',
  'compaction-failed':
    'Compaction could not make this conversation fit the model context. Compact and retry tries again, or start a new chat for unrelated work.',
  'model-context-overflow':
    'This conversation exceeded the model context limit. Compact and retry summarizes earlier messages first.',
  'compaction-unavailable':
    'Compaction is not available in this chat. Start a new chat to continue with a shorter history.',
  'compaction-not-found': 'That compaction is no longer in this chat, so its handoff could not be written again.',
};
export const contextFailure = (code: string | null | undefined) => (code ? (contextFailures[code] ?? null) : null);
export const compactsOnRetry = (code: string | null | undefined) =>
  !!code && ['context-limit', 'compaction-paused', 'compaction-failed', 'model-context-overflow'].includes(code);
