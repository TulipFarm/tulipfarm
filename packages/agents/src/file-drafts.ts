import { z } from 'zod';
import type { HumanActor } from '@tulipfarm/access';
import { createFiles, FileError, requireFileManager } from '@tulipfarm/files';
import { AgentError } from './saved-contracts.ts';
import type { DraftOutcome, FilesProposal } from './draft-contracts.ts';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';

const unavailable = () => Promise.reject(new Error('File bytes are not used to rename, move or trash'));

export function createFileDrafts(storage: AgentStorage, workspaceId: string) {
  async function writable(tx: AgentTransaction, actor: HumanActor, proposal: FilesProposal) {
    for (const item of proposal.input.items) await requireFileManager(tx, actor, item.id);
  }

  /** Stale once any listed item was renamed, moved, trashed, restored or deleted since the card was drafted. */
  async function stale(tx: AgentTransaction, proposal: FilesProposal) {
    const rows = z
      .array(z.object({ id: z.uuid(), name: z.string(), parent_id: z.uuid().nullable(), trashed: z.boolean() }))
      .parse(
        (
          await tx.client.query(
            `SELECT id,name,parent_id,trashed_at IS NOT NULL AS trashed FROM ${relation(tx, 'tf_files')} WHERE id=ANY($1::uuid[]) AND ready AND deleting_at IS NULL`,
            [proposal.input.items.map(item => item.id)],
          )
        ).rows,
      );
    return proposal.input.items.some(item => {
      const row = rows.find(candidate => candidate.id === item.id);
      return !row || row.name !== item.name || row.parent_id !== item.parentId || row.trashed !== item.trashed;
    });
  }

  async function apply(actor: HumanActor, proposal: FilesProposal): Promise<DraftOutcome> {
    const files = createFiles(storage, { putIfAbsent: unavailable, read: unavailable, remove: unavailable });
    const { change, items } = proposal.input;
    try {
      for (const item of items) {
        if (change.kind === 'rename') await files.rename(workspaceId, actor.userId, item.id, change.name);
        else if (change.kind === 'move')
          await files.move(workspaceId, actor.userId, item.id, change.parentId, item.fingerprint!);
        else await files.trash(workspaceId, actor.userId, item.id, change.kind === 'trash');
      }
    } catch (error) {
      if (error instanceof FileError && (error.code === 'conflict' || error.code === 'invalid-move'))
        throw new AgentError('draft-stale');
      if (error instanceof FileError && error.code === 'restore-destination')
        throw new AgentError('file-restore-destination');
      throw error;
    }
    return { kind: 'files', change: change.kind, fileIds: items.map(item => item.id) };
  }

  return { writable, stale, apply };
}
