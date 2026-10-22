import { createHash } from 'node:crypto';
import { z } from 'zod';
import { qualified, type SqlClient } from './runtime.ts';

export const knowledgeRootSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chat'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('task'), id: z.uuid(), sequence: z.number().int().nonnegative() }),
]);
export type KnowledgeRoot = z.infer<typeof knowledgeRootSchema>;
export const knowledgeEpisodeCitationLimit = 8 * 32 + 2 * 3 * 4 * 32;
const operationSchema = z.strictObject({
  id: z.string().max(128),
  hash: z.string().length(64),
  phase: z.enum(['initial', 'deep', 'gap']),
  branches: z.number().int().min(1).max(3),
  grouped: z.boolean(),
  status: z.enum(['running', 'completed', 'failed']),
});
export const knowledgeBudgetSchema = z.strictObject({
  version: z.literal(1),
  operations: z.array(operationSchema).max(7),
  completeCitationIds: z.array(z.string().max(48)).max(knowledgeEpisodeCitationLimit).default([]),
});
export type KnowledgeBudget = z.infer<typeof knowledgeBudgetSchema>;
export class KnowledgeBudgetError extends Error {
  readonly code:
    | 'knowledge-budget-exhausted'
    | 'knowledge-round-pending'
    | 'knowledge-operation-spent'
    | 'knowledge-operation-conflict'
    | 'knowledge-recovery-required';
  constructor(code: KnowledgeBudgetError['code']) {
    super(code);
    this.code = code;
  }
}

export function reserveKnowledgeOperation(
  state: KnowledgeBudget,
  id: string,
  input: unknown,
  branches: number,
  grouped: boolean,
  initial: boolean,
) {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const sameId = state.operations.find(operation => operation.id === id);
  if (sameId && sameId.hash !== hash) throw new KnowledgeBudgetError('knowledge-operation-conflict');
  if (sameId || state.operations.some(operation => operation.hash === hash))
    throw new KnowledgeBudgetError('knowledge-operation-spent');
  if (!Number.isInteger(branches) || branches < 1 || branches > 3)
    throw new KnowledgeBudgetError('knowledge-budget-exhausted');
  if (state.operations.some(operation => operation.status === 'running'))
    throw new KnowledgeBudgetError('knowledge-round-pending');
  const deep = state.operations.filter(operation => operation.phase === 'deep');
  const gap = state.operations.filter(operation => operation.phase === 'gap');
  const filled = (operations: typeof deep) =>
    operations.some(operation => operation.grouped) ||
    operations.reduce((sum, operation) => sum + operation.branches, 0) >= 3;
  const phase = state.operations.length === 0 ? 'initial' : !filled(deep) ? 'deep' : 'gap';
  if (
    (phase === 'initial' && (!initial || branches !== 1)) ||
    (phase !== 'initial' && initial && grouped) ||
    (phase === 'gap' && filled(gap)) ||
    state.operations.length >= 7
  )
    throw new KnowledgeBudgetError('knowledge-budget-exhausted');
  const current = phase === 'deep' ? deep : gap;
  if (
    phase !== 'initial' &&
    ((grouped && current.length > 0) || current.reduce((sum, operation) => sum + operation.branches, 0) + branches > 3)
  )
    throw new KnowledgeBudgetError('knowledge-budget-exhausted');
  return knowledgeBudgetSchema.parse({
    ...state,
    operations: [...state.operations, { id, hash, phase, branches, grouped, status: 'running' }],
  });
}

export function knowledgeBudgetMetadata(state: KnowledgeBudget) {
  const remaining = (phase: 'deep' | 'gap') => {
    const operations = state.operations.filter(operation => operation.phase === phase);
    return operations.some(operation => operation.grouped)
      ? 0
      : 3 - operations.reduce((sum, operation) => sum + operation.branches, 0);
  };
  return {
    initialRemaining: state.operations.length ? 0 : 1,
    deepRemaining: remaining('deep'),
    gapRemaining: remaining('gap'),
    stop: state.operations.length > 0 && remaining('deep') === 0 && remaining('gap') === 0,
  };
}

type Transaction = { client: SqlClient; schema: string };
export async function readKnowledgeBudget(tx: Transaction, root: KnowledgeRoot) {
  const table = qualified(tx.schema, root.kind === 'chat' ? 'tf_conversation_turns' : 'tf_agent_task_messages');
  const predicate = root.kind === 'chat' ? 'id=$1' : 'task_id=$1 AND sequence=$2';
  const values = root.kind === 'chat' ? [root.id] : [root.id, root.sequence];
  const row = (await tx.client.query(`SELECT knowledge_budget FROM ${table} WHERE ${predicate} FOR UPDATE`, values))
    .rows[0];
  if (!row?.knowledge_budget) throw new KnowledgeBudgetError('knowledge-recovery-required');
  return knowledgeBudgetSchema.parse(row.knowledge_budget);
}
export async function writeKnowledgeBudget(tx: Transaction, root: KnowledgeRoot, state: KnowledgeBudget) {
  const table = qualified(tx.schema, root.kind === 'chat' ? 'tf_conversation_turns' : 'tf_agent_task_messages');
  const serialized = JSON.stringify(knowledgeBudgetSchema.parse(state));
  await tx.client.query(
    root.kind === 'chat'
      ? `UPDATE ${table} SET knowledge_budget=$2 WHERE id=$1`
      : `UPDATE ${table} SET knowledge_budget=$2 WHERE task_id=$1 AND sequence=$3`,
    root.kind === 'chat' ? [root.id, serialized] : [root.id, serialized, root.sequence],
  );
}
