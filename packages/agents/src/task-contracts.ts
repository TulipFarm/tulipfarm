import { z } from 'zod';
import { activityReceiptSchema } from '@tulipfarm/conversations/tool-activity';
import { uuidSchema } from '@tulipfarm/access/contracts';
import {
  fileReadReceiptSchema,
  sourceDependencySchema,
  taskGoogleFileSourceSchema,
} from '@tulipfarm/access/source-dependencies';
import { definitionRevisionSchema, scopeSchema, taskLimitsSchema } from './contracts.ts';
import { procedureSelectionsSchema } from './workspace-skill-contracts.ts';

export { taskLimitsSchema };
const attachmentSource = z.strictObject({
  kind: z.literal('attachment'),
  conversationId: uuidSchema,
  attachmentId: uuidSchema,
});
const taskHistorySource = z.strictObject({
  kind: z.literal('task'),
  taskId: uuidSchema,
  throughSequence: z.number().int().nonnegative(),
});
/** A TulipFarm file the owner chose as input. */
const ownerFileSource = z.strictObject({ kind: z.literal('file'), fileId: uuidSchema });
/**
 * A Google Drive file the owner chose as input. The server binds it to the owner's current Google integration and stores it as
 * `google-drive-file`. Named apart from the chat `google-file` part, which carries its own integration binding.
 */
const ownerGoogleFileSource = z.strictObject({
  kind: z.literal('drive-file'),
  fileId: taskGoogleFileSourceSchema.shape.fileId,
});
export const taskSourceSchema = z.discriminatedUnion('kind', [
  ...sourceDependencySchema.options,
  attachmentSource,
  taskHistorySource,
  /** Only the runtime writes `read`, the receipt of the content an agent step was given. */
  ownerFileSource.extend({ read: fileReadReceiptSchema.optional() }),
  taskGoogleFileSourceSchema,
]);
export const taskSourcesSchema = z.array(taskSourceSchema).max(1000);
/** Sources that carry a `read` receipt record content a chat turn or step was given, so a person cannot supply one. */
type ReceiptBearing = { shape: { read: unknown } };
type Without<T extends readonly unknown[], X> = T extends readonly [infer Head, ...infer Rest]
  ? Head extends X
    ? Without<Rest, X>
    : [Head, ...Without<Rest, X>]
  : [];
const bearsReceipt = (option: object) =>
  'shape' in option && typeof option.shape === 'object' && option.shape !== null && 'read' in option.shape;
// The type and the runtime filter test the same `read` key, so a new receipt-bearing kind is excluded by both.
const ownerDependencies = sourceDependencySchema.options.filter(option => !bearsReceipt(option)) as Without<
  typeof sourceDependencySchema.options,
  ReceiptBearing
>;
const ownerTaskSourceSchema = z.discriminatedUnion('kind', [
  ...ownerDependencies,
  attachmentSource,
  taskHistorySource,
  ownerFileSource,
  ownerGoogleFileSource,
]);
export type OwnerTaskSource = z.infer<typeof ownerTaskSourceSchema>;
const messageInput = {
  text: z.string().trim().min(1).max(8000),
  sources: z.array(ownerTaskSourceSchema).max(20).default([]),
};
export const startTaskSchema = z.strictObject({
  requestId: uuidSchema,
  agentId: uuidSchema,
  activationId: uuidSchema.optional(),
  mcpSelection: z.strictObject({ selectionId: uuidSchema, version: z.number().int().positive() }).optional(),
  scope: scopeSchema.default([]),
  limits: taskLimitsSchema.default({ toolCalls: 100, activeMilliseconds: 300000, credits: 100 }),
  ...messageInput,
});
export const delegatedTaskInputSchema = z.strictObject({
  agentId: uuidSchema,
  activationId: uuidSchema.optional(),
  scope: scopeSchema.optional(),
  limits: taskLimitsSchema.default({ toolCalls: 100, activeMilliseconds: 300000, credits: 100 }),
  text: z.string().trim().min(1).max(8000),
});
export const reopenTaskSchema = z.strictObject({
  requestId: uuidSchema,
  expectedGeneration: z.number().int().nonnegative(),
  ...messageInput,
});
export const continueTaskSchema = z.strictObject({
  requestId: uuidSchema,
  expectedGeneration: z.number().int().nonnegative(),
  expectedSequence: z.number().int().nonnegative(),
  limits: taskLimitsSchema.optional(),
  ...messageInput,
});
export const taskReceiptSchema = z.object({
  id: uuidSchema,
  generation: z.number().int().nonnegative(),
  status: z.enum(['pending', 'completed', 'waiting-clarification', 'waiting-approval', 'paused', 'failed']),
});
export const taskPauseReasonSchema = z.enum([
  'user',
  'limit.toolCalls',
  'limit.activeTime',
  'limit.credits',
  'limit.steps',
  'limit.workspaceCredits',
  'model',
  'context',
  'file',
  'plan',
  'approval',
]);
export type TaskPauseReason = z.infer<typeof taskPauseReasonSchema>;
export const taskSummarySchema = taskReceiptSchema.extend({
  pauseReason: taskPauseReasonSchema.nullish(),
  agentId: uuidSchema,
  activationId: uuidSchema,
  definitionRevision: definitionRevisionSchema,
  parentTaskId: uuidSchema.nullable(),
  delegationDepth: z.number().int().min(0).max(3),
  skills: procedureSelectionsSchema,
  scope: scopeSchema,
  limits: taskLimitsSchema,
  flowId: uuidSchema,
  activeMilliseconds: z.string().regex(/^\d+$/),
  toolCalls: z.number().int().nonnegative(),
  createdAt: z.string(),
  cost: z.object({ chargedCreditUnits: z.string().regex(/^\d+$/), heldCreditUnits: z.string().regex(/^\d+$/) }),
  activity: z.array(activityReceiptSchema).default([]),
});
export const taskMessageSchema = z.object({
  sequence: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  role: z.enum(['owner', 'agent']),
  text: z.string(),
  sources: taskSourcesSchema,
  createdAt: z.string(),
});
export const taskListQuerySchema = z.strictObject({
  after: uuidSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).default(''),
  state: z.literal('active').optional(),
});
export const taskHistoryQuerySchema = z.strictObject({
  after: z.number().int().min(-1).default(-1),
  limit: z.number().int().min(1).max(100).default(25),
});
/** The runtime reads at most this many messages from each referenced task. */
export const taskReferenceMessageLimit = 100;

export class AgentTaskError extends Error {
  readonly code:
    | 'idempotency-conflict'
    | 'generation-conflict'
    | 'task-not-completed'
    | 'activation-selection-required'
    | 'context-limit'
    | 'task-limit'
    | 'continuation-conflict'
    | 'google-integration-required'
    | 'delegation-depth'
    | 'delegation-limit';
  constructor(code: AgentTaskError['code']) {
    super(code);
    this.code = code;
  }
}
