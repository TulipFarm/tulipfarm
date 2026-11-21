import type { ConversationMessage } from './conversation-api';

type MemoryChange = NonNullable<ConversationMessage['tools'][number]['memoryChange']>;

export function memoryChangeLabel(change: MemoryChange) {
  if (change.store === 'memory')
    return change.operation === 'forget'
      ? { verb: 'Updated memory', object: 'Forgot a preference' }
      : { verb: 'Updated memory', object: 'Preferences' };
  const verb =
    change.operation === 'add'
      ? 'Added to Knowledge'
      : change.operation === 'remove'
        ? 'Removed from Knowledge'
        : 'Updated Knowledge';
  return { verb, object: change.title || 'An entry' };
}

/** One quiet line per memory or Knowledge change a reply made, shown above the reply text. */
export function MemoryChanges({ tools }: { tools: ConversationMessage['tools'] }) {
  const changes = tools.flatMap(tool =>
    tool.status === 'completed' && tool.memoryChange ? [{ id: tool.id, ...memoryChangeLabel(tool.memoryChange) }] : [],
  );
  if (!changes.length) return null;
  return (
    <ul aria-label="Changes" className="space-y-1">
      {changes.map(change => (
        <li key={change.id} className="text-sm">
          <span className="text-muted-foreground">{change.verb}</span>{' '}
          <span className="text-foreground">{change.object}</span>
        </li>
      ))}
    </ul>
  );
}
