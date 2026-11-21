import type { HumanActor } from '@tulipfarm/access';
import { savePersonalMemorySchema } from '@tulipfarm/memory-core/personal-memory-contracts';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { PersonalMemoryTransaction } from './keep-personal-memory.ts';

/** The common migration that adds the learning record. Before it, background learning does nothing. */
export const memoryLearningVersion = 98;

export type MemoryEdit =
  | { readonly kind: 'add'; readonly before: null; readonly after: string }
  | { readonly kind: 'change'; readonly before: string; readonly after: string }
  | { readonly kind: 'remove'; readonly before: string; readonly after: null };

export async function memoryLearningInstalled(tx: PersonalMemoryTransaction) {
  if (tx.commonVersion !== undefined) return tx.commonVersion >= memoryLearningVersion;
  return Boolean(
    (
      await tx.client.query<{ installed: boolean }>('SELECT to_regclass($1) IS NOT NULL AS installed', [
        qualified(tx.schema, 'tf_memory_learning'),
      ])
    ).rows[0]?.installed,
  );
}

function occurrences(text: string, part: string) {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count++;
  return count;
}

/** A list marker or blank line left behind once its text is removed. */
const bareLine = /^\s*(?:[-*+]|\d+[.)])?\s*$/;

/**
 * The memory after one edit, or undefined when the edit does not fit it: the text to change or remove must appear
 * exactly once, and an addition must not be there already.
 */
export function applyMemoryEdit(text: string, edit: MemoryEdit): string | undefined {
  let next: string;
  if (edit.kind === 'add') {
    if (text.includes(edit.after.trim())) return undefined;
    const kept = text.replace(/\s+$/, '');
    next = kept ? `${kept}\n${edit.after.trim()}` : edit.after.trim();
  } else {
    if (occurrences(text, edit.before) !== 1) return undefined;
    const at = text.indexOf(edit.before);
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const lineEnd = text.indexOf('\n', at + edit.before.length);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(lineStart, at) + (edit.after ?? '') + text.slice(at + edit.before.length, end);
    const removed = edit.kind === 'remove' && bareLine.test(line);
    next = removed
      ? text.slice(0, lineStart) + text.slice(lineEnd === -1 ? end : end + 1)
      : text.slice(0, lineStart) + line + text.slice(end);
    next = next.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  }
  if (next === text || !savePersonalMemorySchema.safeParse({ content: next, expectedRevision: 0 }).success)
    return undefined;
  return next;
}

const table = (tx: PersonalMemoryTransaction, name: string) => qualified(tx.schema, name);

/**
 * Serializes a member's memory changes with background learning until the transaction ends. Take it before calling
 * Keep, so learning never writes edits read from memory that a concurrent change replaced or forgot.
 */
export async function lockMemoryLearning(tx: PersonalMemoryTransaction, actor: HumanActor) {
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 761041))', [
    `${tx.schema}:${actor.membershipId}`,
  ]);
}

/** Marks a change the member made themselves; learning then reads only their messages after it. */
export async function recordDirectMemoryChange(tx: PersonalMemoryTransaction, actor: HumanActor) {
  if (!(await memoryLearningInstalled(tx))) return;
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_memory_learning')} (membership_id,manual_at) VALUES ($1,clock_timestamp())
    ON CONFLICT (membership_id) DO UPDATE SET manual_at=EXCLUDED.manual_at`,
    [actor.membershipId],
  );
}

export async function lastDirectMemoryChange(tx: PersonalMemoryTransaction, actor: HumanActor) {
  const result = await tx.client.query<{ manual_at: string }>(
    `SELECT manual_at::text AS manual_at FROM ${table(tx, 'tf_memory_learning')} WHERE membership_id=$1`,
    [actor.membershipId],
  );
  return result.rows[0]?.manual_at ?? null;
}
