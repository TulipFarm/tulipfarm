import type { HumanActor } from '@tulipfarm/access';
import {
  PersonalMemoryConflict,
  readPersonalMemory,
  replaceOwnPersonalMemory,
} from '@tulipfarm/conversations/personal-memory';
import { AgentError } from './saved-contracts.ts';
import type { DraftOutcome, MemoryProposal } from './draft-contracts.ts';
import { relation, type AgentTransaction } from './store.ts';

/** A line holding nothing, or only a list or quote marker. */
const emptyLine = /^\s*(?:[-*+>]|\d+[.)])?\s*$/;

/**
 * Removes every exact occurrence of `text`. A line the removal leaves empty or holding only a list marker goes too;
 * blank lines that were already there stay. Undefined when the text does not occur.
 */
export function forgetMemoryText(content: string, text: string) {
  if (!text || !content.includes(text)) return undefined;
  let next = content;
  for (let at = next.indexOf(text); at !== -1; at = next.indexOf(text, at)) {
    const start = next.lastIndexOf('\n', at - 1) + 1;
    const newline = next.indexOf('\n', at + text.length);
    const end = newline === -1 ? next.length : newline;
    if (emptyLine.test(next.slice(start, at) + next.slice(at + text.length, end))) {
      next = newline === -1 ? next.slice(0, Math.max(0, start - 1)) : next.slice(0, start) + next.slice(end + 1);
      at = Math.max(0, start - 1);
    } else next = next.slice(0, at) + next.slice(at + text.length);
  }
  return next;
}

/**
 * Personal memory joins only the requester's own private chats outside projects and Slack. Callers check the chat is
 * the requester's first, so a refusal here means only that this chat leaves memory out.
 */
export async function requireMemoryChat(tx: AgentTransaction, actor: HumanActor, chatId: string) {
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_conversations')} c WHERE c.id=$1 AND c.kind='private' AND c.owner_user_id=$2 AND c.owner_membership_id=$3 AND c.project_id IS NULL AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_slack_dm_roots')} WHERE conversation_id=c.id) AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_slack_default_turns')} WHERE conversation_id=c.id)`,
        [chatId, actor.userId, actor.membershipId],
      )
    ).rowCount
  )
    throw new AgentError('memory-unavailable', 409);
}

export async function memoryStale(tx: AgentTransaction, actor: HumanActor, proposal: MemoryProposal) {
  return (await readPersonalMemory(tx, actor)).revision !== proposal.input.expectedRevision;
}

export async function applyMemory(
  tx: AgentTransaction,
  actor: HumanActor,
  proposal: MemoryProposal,
): Promise<DraftOutcome> {
  try {
    const saved = await replaceOwnPersonalMemory(tx, actor, proposal.input.content, proposal.input.expectedRevision);
    return { kind: 'memory', operation: proposal.input.operation, revision: saved.revision };
  } catch (error) {
    if (error instanceof PersonalMemoryConflict) throw new AgentError('draft-stale');
    throw error;
  }
}
