import { AccessDenied, type HumanActor } from '@tulipfarm/access';
import { createFiles, FileError, type FileBytes } from '@tulipfarm/files';
import { createLocalKnowledge, KnowledgeError } from '@tulipfarm/knowledge';
import { AgentError } from './saved-contracts.ts';
import type { DraftOutcome, KnowledgeProposal } from './draft-contracts.ts';
import type { AgentStorage } from './store.ts';

const unavailableBytes = () => Promise.reject(new AgentError('knowledge-file-unavailable', 503));
const noBytes: FileBytes = { putIfAbsent: unavailableBytes, read: unavailableBytes, remove: unavailableBytes };

/** Errors meaning the entry or file changed or went away since the card was drafted. */
function staleError(error: unknown) {
  return (
    error instanceof AccessDenied ||
    (error instanceof FileError && (error.code === 'conflict' || error.code === 'integrity')) ||
    (error instanceof KnowledgeError && ['conflict', 'superseded', 'integrity'].includes(error.code))
  );
}

/**
 * Personal Knowledge (notes and Files the person added) for chat review cards. `bytes` reads file originals; only
 * approving a card that adds or updates a Files entry needs them.
 */
export function createKnowledgeDrafts(storage: AgentStorage, workspaceId: string, bytes: FileBytes = noBytes) {
  const files = createFiles(storage, bytes);
  const knowledge = createLocalKnowledge({ runtime: storage, files });

  async function readableFile(actor: HumanActor, fileId: string) {
    const { item } = await files.details(workspaceId, actor.userId, fileId);
    if (item.kind !== 'file') throw new AccessDenied();
    return item;
  }

  /** The person's own entry, or undefined once it is removed or no longer theirs. */
  async function entry(actor: HumanActor, documentId: string) {
    try {
      return await knowledge.get(workspaceId, actor.userId, documentId);
    } catch (error) {
      if (staleError(error)) return undefined;
      throw error;
    }
  }

  async function writable(actor: HumanActor, proposal: KnowledgeProposal) {
    const { input } = proposal;
    if (input.operation !== 'remove' && input.content.kind === 'file') await readableFile(actor, input.content.fileId);
  }

  async function stale(actor: HumanActor, proposal: KnowledgeProposal) {
    const { input } = proposal;
    if (input.operation !== 'remove' && input.content.kind === 'file') {
      try {
        await readableFile(actor, input.content.fileId);
      } catch (error) {
        if (staleError(error)) return true;
        throw error;
      }
    }
    const current = await entry(actor, proposal.targetId);
    if (input.operation === 'add') return current !== undefined;
    if (!current || current.revisionId !== input.expectedRevisionId) return true;
    return input.operation === 'update' && input.content.kind === 'file'
      ? current.kind !== 'file' || current.fileId !== input.content.fileId
      : current.kind !== (input.operation === 'update' ? input.content.kind : input.entry);
  }

  /** The draft's ID is the Knowledge command, so approving the same card twice changes Knowledge once. */
  async function apply(actor: HumanActor, draftId: string, proposal: KnowledgeProposal): Promise<DraftOutcome> {
    const { input } = proposal;
    try {
      if (input.operation === 'remove') {
        await knowledge.remove(workspaceId, actor.userId, {
          commandId: draftId,
          documentId: proposal.targetId,
          expectedRevisionId: input.expectedRevisionId,
        });
        return { kind: 'knowledge', operation: 'remove', documentId: proposal.targetId };
      }
      const saved = await knowledge.save(workspaceId, actor.userId, {
        commandId: draftId,
        documentId: proposal.targetId,
        expectedRevisionId: input.operation === 'add' ? null : input.expectedRevisionId,
        title: input.title,
        input:
          input.content.kind === 'note'
            ? { kind: 'note', text: input.content.text }
            : { kind: 'file', fileId: input.content.fileId },
      });
      // Adding a file already in Knowledge returns that entry rather than a second one.
      return { kind: 'knowledge', operation: input.operation, documentId: saved.documentId };
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === 'quota') throw new AgentError('knowledge-quota', 400);
      if (staleError(error)) throw new AgentError('draft-stale');
      throw error;
    }
  }

  return { list: knowledge.list, get: knowledge.get, readableFile, writable, stale, apply };
}
