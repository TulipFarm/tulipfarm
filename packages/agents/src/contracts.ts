import { z } from 'zod';
import { skillIdSchema, skillResourceSchema } from './skill-ids.ts';
import { publicWebResultSchema } from '@tulipfarm/conversations/public-web';
import { generateImagesCallSchema } from '@tulipfarm/conversations/image-contracts';
import { assetPermissionSchema, uuidSchema } from '@tulipfarm/access/contracts';
import { issueResultSchema } from '@tulipfarm/integrations/contracts';
import { recordQuerySchema, revisionSchema } from '@tulipfarm/tables/definition';
import { queryLimits, tableRowsQuerySchema, tableSummaryQuerySchema } from '@tulipfarm/tables/query';
import {
  agentRecordValueSchema,
  agentRecordSchema as recordSchema,
  agentRecordListSchema as recordListSchema,
  agentTableStatusSchema as tableStatusSchema,
  agentTableInspectSchema,
  agentQueryRecordListSchema,
  agentQuerySummarySchema,
  agentReferenceChoicesSchema,
  agentQueryErrorSchema,
  agentStaleRevisionSchema,
} from './record-contracts.ts';
import { modelFamilyIdSchema } from './model-policy-contracts.ts';
import { procedureSelectionsSchema } from './workspace-skill-contracts.ts';
import { googleToolCallSchema, googleToolResultSchema } from './google-tool-contracts.ts';
import { slackActionSchema, slackActionViewSchema } from '@tulipfarm/slack/action-contracts';
import { mcpPermissionSlotsSchema } from '@tulipfarm/workspaces/agent-document';
import { mcpCallSchema, mcpExecutionResultSchema } from './mcp-contracts.ts';
import { githubTaskCallSchema, githubTaskResultSchema } from './github-task-contracts.ts';
import { knowledgeToolCallSchema, knowledgeToolResultSchema } from './knowledge-tool-contracts.ts';
import { toolNameSchema } from './tool-capabilities.ts';
import {
  skillExecutionCallSchema,
  skillExecutionResultSchema,
  skillFileCallSchema,
  skillFileResultSchema,
} from './skill-execution-contracts.ts';
import { skillPackageSchema } from './skill-package-contracts.ts';

export const scopeSchema = z
  .array(
    z.strictObject({
      assetId: uuidSchema,
      permissions: z.array(assetPermissionSchema).min(1).max(14),
    }),
  )
  .max(100);
export const taskLimitsSchema = z.strictObject({
  toolCalls: z.number().int().min(1).max(1000).default(100),
  activeMilliseconds: z.number().int().min(1000).max(3600000).default(300000),
  credits: z.number().int().min(1).max(10000).default(100),
});
export const maximumTaskLimits = { toolCalls: 1000, activeMilliseconds: 3600000, credits: 10000 };
export const executionPolicySchema = z.strictObject({
  version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  teamIds: z.array(uuidSchema).max(100),
  limits: scopeSchema,
  taskLimits: taskLimitsSchema.default(maximumTaskLimits),
  slackSender: z.enum(['user', 'app']).optional(),
});
export {
  agentRuntimeToolNames,
  agentToolRuntimeDescription,
  supportedAgentToolRuntimes,
  toolNameSchema,
} from './tool-capabilities.ts';
export const agentDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  instructions: z.string().min(1).max(32000),
  tools: z.array(toolNameSchema).max(20),
  modelFamilyId: modelFamilyIdSchema.optional(),
  skills: procedureSelectionsSchema.optional(),
  responseRule: z.enum(['tag', 'every-message']).optional(),
  mcp: mcpPermissionSlotsSchema.optional(),
});
export const definitionRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const resource = { tableId: uuidSchema };
const recordWrite = {
  ...resource,
  expectedAppliedRevision: revisionSchema,
  values: z
    .record(uuidSchema, agentRecordValueSchema)
    .refine(value => Object.keys(value).length <= 64)
    .describe('Field-ID keyed values. Use typed objects matching the inspected field kind, or null.'),
};
export const createRecordBatchSchema = z.strictObject({
  tool: z.literal('rows.create.batch'),
  ...resource,
  expectedAppliedRevision: revisionSchema,
  rows: z
    .array(z.strictObject({ values: recordWrite.values }))
    .min(1)
    .max(100),
});
export type CreateRecordBatch = z.infer<typeof createRecordBatchSchema>;
// Optional so calls persisted before read tokens existed still parse. Direct writes and task proposals treat a missing token as a conflict.
const readToken = {
  expectedToken: uuidSchema
    .optional()
    .describe(
      'The token from your latest rows.get or rows.list result for this row. Required for direct writes and task proposals.',
    ),
};
export const taskMutationSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('rows.create'), ...recordWrite }),
  z.strictObject({ tool: z.literal('rows.update'), ...recordWrite, recordId: uuidSchema, ...readToken }),
  z.strictObject({
    tool: z.literal('rows.delete'),
    ...resource,
    expectedAppliedRevision: revisionSchema,
    recordId: uuidSchema,
    ...readToken,
  }),
]);
/** Version 2 queries name their version. Optional rsql text replaces query.where, so a call never carries two filters. */
const rsql = { rsql: z.string().max(queryLimits.rsqlCharacters).optional() };
function oneFilter(value: { query: object; rsql?: string | undefined }, context: z.RefinementCtx) {
  if (value.rsql === undefined) return;
  if (!('version' in value.query))
    context.addIssue({ code: 'custom', path: ['rsql'], message: 'rsql requires a version 2 query.' });
  else if ('where' in value.query && value.query.where !== null)
    context.addIssue({ code: 'custom', path: ['rsql'], message: 'Filter with rsql or query.where, not both.' });
}
const rowsListFields = { tool: z.literal('rows.list'), ...resource, expectedAppliedRevision: revisionSchema, ...rsql };
// Saved workflows may still carry the legacy query shape, so execution accepts it.
const rowsListSchema = z
  .strictObject({ ...rowsListFields, query: z.union([recordQuerySchema, tableRowsQuerySchema]) })
  .superRefine(oneFilter);
/** The model only sees the version 2 request shape. */
export const rowsListModelSchema = z
  .strictObject({ ...rowsListFields, query: tableRowsQuerySchema })
  .superRefine(oneFilter);
const rowsSummarizeSchema = z
  .strictObject({
    tool: z.literal('rows.summarize'),
    ...resource,
    expectedAppliedRevision: revisionSchema,
    query: tableSummaryQuerySchema,
    ...rsql,
  })
  .superRefine(oneFilter);
export const referenceLookupLimit = 20;
const rowsResolveReferenceSchema = z.strictObject({
  tool: z.literal('rows.resolveReference'),
  ...resource,
  expectedAppliedRevision: revisionSchema,
  fieldId: uuidSchema,
  search: z.string().trim().min(1).max(255),
  limit: z.int().min(1).max(referenceLookupLimit).default(10),
});
export const publicWebCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('web.fetch'), url: z.url().max(2048) }),
  z.strictObject({
    tool: z.literal('web.search'),
    query: z.string().trim().min(1).max(500),
    window: z.enum(['day', 'week', 'any']).default('any'),
    limit: z.int().min(1).max(10).default(5),
  }),
]);
export const toolCallSchema = z.discriminatedUnion('tool', [
  generateImagesCallSchema,
  skillExecutionCallSchema,
  skillFileCallSchema,
  ...githubTaskCallSchema.options,
  ...mcpCallSchema.options,
  ...slackActionSchema.options,
  ...googleToolCallSchema.options,
  ...knowledgeToolCallSchema.options,
  z.strictObject({
    tool: z.literal('tables.list'),
    after: z.uuid().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  z.strictObject({
    tool: z.literal('rows.get'),
    ...resource,
    expectedAppliedRevision: revisionSchema,
    recordId: uuidSchema,
  }),
  z.strictObject({ tool: z.literal('skills.list') }),
  z.strictObject({
    tool: z.literal('skills.read'),
    skillId: z.union([skillIdSchema, uuidSchema]),
    revision: z.string().optional(),
    resource: skillResourceSchema.optional(),
  }),
  ...publicWebCallSchema.options,
  z.strictObject({
    tool: z.literal('github.issue.read'),
    integrationId: uuidSchema,
    sourceId: uuidSchema,
    issueNumber: z.number().int().positive().max(2147483647),
    importSelection: z
      .string()
      .max(16384)
      .optional()
      .describe('Explicit JSON integration import selection. Omit for ordinary reads.'),
  }),
  z.strictObject({ tool: z.literal('schema.inspect'), ...resource }),
  z.strictObject({ tool: z.literal('schema.status'), ...resource }),
  rowsListSchema,
  rowsSummarizeSchema,
  rowsResolveReferenceSchema,
  z.strictObject({
    tool: z.literal('rows.reverse'),
    ...resource,
    recordId: uuidSchema,
    fieldId: uuidSchema,
    after: uuidSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
  }),
  ...taskMutationSchema.options,
  z.strictObject({
    tool: z.literal('agents.task.start'),
    agentId: uuidSchema,
    activationId: uuidSchema.optional(),
    scope: scopeSchema.optional(),
    limits: taskLimitsSchema.default({ toolCalls: 100, activeMilliseconds: 300000, credits: 100 }),
    text: z.string().trim().min(1).max(8000),
  }),
  z.strictObject({ tool: z.literal('agents.task.read'), taskId: uuidSchema }),
]);
export const runStatusSchema = z.enum(['ready', 'running', 'waiting', 'completed', 'blocked', 'cancelled']);
export const executionIdsSchema = z.strictObject({ workspaceId: uuidSchema, runId: uuidSchema, callId: uuidSchema });
export const executionStatusSchema = z.enum(['completed', 'waiting', 'blocked', 'failed']);
export const recordConflict = {
  error: 'record-conflict',
  instruction:
    'The row changed after your last read or no read token was supplied. Read it again with rows.get, then retry with the new token.',
} as const;
const recordConflictSchema = z.strictObject({ error: z.literal(recordConflict.error), instruction: z.string() });
export const toolResultSchema = z.union([
  z.strictObject({
    taskId: uuidSchema,
    status: z.enum(['pending', 'completed', 'waiting-clarification', 'waiting-approval', 'paused', 'failed']),
    result: z.string().optional(),
  }),
  skillExecutionResultSchema,
  skillFileResultSchema,
  knowledgeToolResultSchema,
  githubTaskResultSchema,
  publicWebResultSchema,
  mcpExecutionResultSchema,
  slackActionViewSchema,
  googleToolResultSchema,
  z.strictObject({ tables: z.array(tableStatusSchema), total: z.number(), nextCursor: uuidSchema.nullable() }),
  z.strictObject({
    skills: z.array(
      z.strictObject({
        id: z.string(),
        revision: z.string().optional(),
        name: z.string(),
        description: z.string().optional(),
      }),
    ),
    source: z.literal('bundled'),
  }),
  z.strictObject({
    id: z.string(),
    revision: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    instructions: z.string(),
    package: skillPackageSchema.optional(),
    resources: z.array(z.strictObject({ path: skillResourceSchema, digest: z.string() })).optional(),
    resource: z.strictObject({ path: skillResourceSchema, text: z.string() }).optional(),
  }),
  z.strictObject({ url: z.string(), text: z.string(), untrusted: z.literal(true) }),
  issueResultSchema,
  agentTableInspectSchema,
  tableStatusSchema,
  agentQueryRecordListSchema,
  agentQuerySummarySchema,
  agentReferenceChoicesSchema,
  agentQueryErrorSchema,
  agentStaleRevisionSchema,
  recordSchema,
  recordListSchema,
  z.strictObject({
    kind: z.literal('relationship'),
    tableId: uuidSchema,
    cardinality: z.enum(['one', 'many']),
    recordIds: z.array(uuidSchema),
    nextCursor: uuidSchema.nullable(),
  }),
  z.boolean(),
  z.strictObject({ commandId: uuidSchema, status: z.enum(['preparing', 'conflict', 'failed']) }),
  z.strictObject({ code: z.enum(['access-denied', 'tool-failed']) }),
  recordConflictSchema,
  z.null(),
]);
export type Scope = z.infer<typeof scopeSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ExecutionIds = z.infer<typeof executionIdsSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
