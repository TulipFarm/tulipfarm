import type { ConversationMessage } from './conversation-api';
import type { StreamTool } from '@tulipfarm/conversations/events';

type Tool = ConversationMessage['tools'][number];
// A live `completed` update says the tool returned, not that it worked: a result with an error also completes. Until the
// saved receipt arrives with the outcome, such a tool shows its activity but no card that reads its result.
const unsavedOutcomes = new WeakSet<Tool>();

/** Whether the tool's saved receipt shows a completed call whose result was not an error. */
export function succeeded(tool: Tool) {
  return tool.status === 'completed' && tool.activityStatus !== 'failed' && !unsavedOutcomes.has(tool);
}

export function reconcileLiveTools(
  messages: ConversationMessage[],
  updates?: ReadonlyMap<string, StreamTool>,
): ConversationMessage[] {
  if (!updates?.size) return messages;
  return messages.map(message => {
    if (!message.turn || !['processing', 'queued'].includes(message.turn.status)) return message;
    const tools = new Map(message.tools.map(tool => [tool.id, tool]));
    for (const update of [...updates.values()].sort((a, b) => a.sequence - b.sequence)) {
      if (
        update.turnId !== message.turn.id ||
        update.generation !== message.turn.generation ||
        (message.turn.epoch !== undefined && update.epoch < message.turn.epoch)
      )
        continue;
      const saved = tools.get(update.id);
      if (saved && saved.status !== 'running') continue;
      const live: Tool = {
        ...saved,
        id: update.id,
        tool: update.tool,
        status: update.status,
        ...(saved?.presentation ? {} : { presentation: update.presentation }),
        activityStatus: update.status,
      };
      if (update.status === 'completed') unsavedOutcomes.add(live);
      tools.set(update.id, live);
    }
    return { ...message, tools: [...tools.values()] };
  });
}

export function unclaimedTools(
  messages: ConversationMessage[],
  updates?: ReadonlyMap<string, StreamTool>,
): StreamTool[] {
  const knownTurns = new Set(messages.flatMap(message => (message.turn ? [message.turn.id] : [])));
  return [...(updates?.values() ?? [])]
    .filter(update => !knownTurns.has(update.turnId))
    .sort((a, b) => a.sequence - b.sequence);
}

export function unclaimedToolTurns(messages: ConversationMessage[], updates?: ReadonlyMap<string, StreamTool>) {
  const turns = new Map<string, StreamTool[]>();
  for (const tool of unclaimedTools(messages, updates)) {
    const tools = turns.get(tool.turnId) ?? [];
    tools.push(tool);
    turns.set(tool.turnId, tools);
  }
  return [...turns].map(([id, tools]) => ({ id, tools }));
}

export function newestTools(
  messages: ConversationMessage[],
  updates?: ReadonlyMap<string, StreamTool>,
): ConversationMessage['tools'] {
  const incoming = unclaimedTools(messages, updates).reverse();
  return [
    ...incoming,
    ...[...messages].sort((a, b) => b.sequence - a.sequence).flatMap(message => [...message.tools].reverse()),
  ];
}
