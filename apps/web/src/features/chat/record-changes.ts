import type { RowChange } from '@tulipfarm/conversations/row-view';

/** Rows one reply wrote to one table. A row created and then updated in the same reply counts as created. */
export type RecordChanges = { id: string; tableId: string; revision: string; created: string[]; updated: string[] };

export function recordChangesForTools(
  messageId: string,
  tools: readonly { status: string; rowChange?: RowChange | undefined }[],
): RecordChanges[] {
  const tables = new Map<string, RecordChanges>();
  for (const tool of tools) {
    const change = tool.status === 'completed' ? tool.rowChange : undefined;
    if (!change) continue;
    const key = `${change.tableId}:${change.revision}`;
    const entry = tables.get(key) ?? {
      id: `record-changes:${messageId}:${key}`,
      tableId: change.tableId,
      revision: change.revision,
      created: [],
      updated: [],
    };
    tables.set(key, entry);
    for (const id of change.recordIds) {
      if (entry.created.includes(id) || entry.updated.includes(id)) continue;
      entry[change.kind].push(id);
    }
  }
  return [...tables.values()];
}

const rows = (count: number) => `${count} ${count === 1 ? 'row' : 'rows'}`;

export function recordChangesSummary(change: Pick<RecordChanges, 'created' | 'updated'>) {
  return [
    change.created.length ? `${rows(change.created.length)} added` : '',
    change.updated.length ? `${rows(change.updated.length)} updated` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
