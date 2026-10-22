import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { agentRecordSchema as recordSchema } from './record-contracts.ts';
import { taskMutationSchema } from './contracts.ts';

export { taskMutationSchema } from './contracts.ts';
export const proposeTaskSchema = z.strictObject({
  requestId: uuidSchema,
  generation: z.number().int().nonnegative(),
  calls: z.array(taskMutationSchema).min(1).max(50),
});
export const taskDecisionSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
});
export const taskActionSchema = z.object({
  id: uuidSchema,
  call: taskMutationSchema,
  recordId: uuidSchema,
  token: uuidSchema.nullable(),
  before: recordSchema.nullable(),
  after: recordSchema.nullable(),
  tableName: z.string(),
  fields: z.array(
    z.object({
      id: uuidSchema,
      label: z.string(),
      options: z.array(z.object({ id: uuidSchema, label: z.string() })).optional(),
    }),
  ),
});
export const taskProposalSchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema,
  generation: z.number().int().nonnegative(),
  runId: uuidSchema,
  digest: z.string(),
  actions: z.array(taskActionSchema),
});
export const taskBatchStatusSchema = z.object({
  id: uuidSchema,
  decision: z.enum(['approve', 'reject']).nullable(),
  superseded: z.boolean(),
  actions: z.array(z.object({ id: uuidSchema, status: z.enum(['completed', 'failed', 'unattempted']) })),
});
export const taskProposalViewSchema = taskProposalSchema.extend({ status: taskBatchStatusSchema });
export const taskGenerationSchema = z.strictObject({ generation: z.number().int().nonnegative() });
export const recoverTaskSchema = taskGenerationSchema.extend({
  requestId: uuidSchema,
  calls: z.array(taskMutationSchema).min(1).max(50).optional(),
});
export const executeTaskActionSchema = z.strictObject({ actionId: uuidSchema });
export class TaskApprovalError extends Error {
  readonly code:
    | 'approval-required'
    | 'proposal-conflict'
    | 'stale-proposal'
    | 'task-read-unsupported'
    | 'recovery-empty'
    | 'task-run-conflict'
    | 'record-conflict';
  constructor(code: TaskApprovalError['code']) {
    super(code);
    this.code = code;
  }
}
/** An update or delete whose expectedToken no longer matches its row. `calls` are indexes into the proposed calls. */
export class TaskRecordConflict extends TaskApprovalError {
  readonly calls: number[];
  constructor(calls: number[]) {
    super('record-conflict');
    this.calls = calls;
  }
}
