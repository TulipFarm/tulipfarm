import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { saveAgentSchema, agentCommandStatusSchema } from './saved-contracts.ts';
import { saveWorkspaceSkillSchema, workspaceSkillReceiptSchema } from './workspace-skill-contracts.ts';
import { agentDefinitionSchema, taskMutationSchema } from './contracts.ts';
import { agentRecordValueSchema } from './record-contracts.ts';
import { authoredDefinitionSchema, definitionSchema } from '@tulipfarm/workflows/contracts';
import { agentSetupConsentSchema, agentSetupDetailsSchema, agentSetupReceiptSchema } from './setup-contracts.ts';

export const agentDraftInputSchema = saveAgentSchema.omit({ requestId: true }).extend({
  setup: agentSetupDetailsSchema.optional(),
  expectedPolicyVersion: z.number().int().nonnegative().optional(),
  expectedActivationIds: z.array(uuidSchema).optional(),
});
export const authoringProposalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent'), targetId: uuidSchema, input: agentDraftInputSchema }),
  z.strictObject({
    kind: z.literal('skill'),
    targetId: uuidSchema,
    input: saveWorkspaceSkillSchema.omit({ requestId: true }),
  }),
  z.strictObject({
    kind: z.literal('workflow'),
    targetId: uuidSchema,
    input: z.strictObject({
      expectedRevision: uuidSchema.nullable(),
      definition: authoredDefinitionSchema,
      activate: z.boolean(),
    }),
  }),
  z.strictObject({
    kind: z.literal('workflow-activation'),
    targetId: uuidSchema,
    input: z.strictObject({ revision: uuidSchema, enabled: z.boolean(), definition: definitionSchema }),
  }),
  z.strictObject({ kind: z.literal('row'), input: taskMutationSchema }),
]);
export const draftDecisionSchema = z.strictObject({
  commandId: uuidSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['save', 'activate', 'dismiss']),
  consent: agentSetupConsentSchema.optional(),
});
export const workflowActivationOutcomeSchema = z.enum([
  'not-requested',
  'activated',
  'disabled',
  'sponsor-required',
  'audience-required',
]);
export const draftOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dismissed') }),
  z.object({
    kind: z.literal('agent'),
    receipt: agentCommandStatusSchema,
    setupReceipt: agentSetupReceiptSchema.optional(),
  }),
  z.object({ kind: z.literal('skill'), receipt: workspaceSkillReceiptSchema }),
  z.object({
    kind: z.literal('workflow'),
    workflowId: z.uuid(),
    revision: z.uuid(),
    enabled: z.boolean(),
    nextRunAt: z.string().nullable(),
    activation: workflowActivationOutcomeSchema,
  }),
  z.object({ kind: z.literal('row'), operation: z.enum(['create', 'update', 'delete']), recordId: z.uuid() }),
]);
export const agentDraftChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }),
  z.object({
    kind: z.literal('update'),
    agentId: z.uuid(),
    current: z.object({ name: z.string(), changedFields: z.array(agentDefinitionSchema.keyof()) }).nullable(),
  }),
]);
export const rowDraftTableSchema = z.object({
  name: z.string(),
  fields: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    }),
  ),
});
const filterLabelsSchema = z.object({
  field: z.string(),
  match: z.enum(['is', 'is-not', 'lt', 'lte', 'gt', 'gte', 'is-empty', 'is-not-empty']),
  value: z.string().nullable(),
});
export const draftViewSchema = z.object({
  id: z.uuid(),
  digest: draftDecisionSchema.shape.digest,
  proposal: authoringProposalSchema,
  status: z.enum(['pending', 'stale', 'preparing', 'saved', 'failed', 'dismissed']),
  outcome: draftOutcomeSchema.nullable(),
  agentChange: agentDraftChangeSchema.nullable().default(null),
  workflowNextRunAt: z.string().nullable().default(null),
  workflowRecordSource: z
    .object({ table: z.string(), field: z.string(), filter: filterLabelsSchema.nullable() })
    .nullable()
    .default(null),
  workflowRowSource: z
    .object({ table: z.string(), fields: z.array(z.string()), filter: filterLabelsSchema.nullable() })
    .nullable()
    .default(null),
  workflowTableStepSources: z
    .array(z.object({ id: z.string(), table: z.string(), fields: z.record(z.string(), z.string()) }))
    .default([]),
  rowTable: rowDraftTableSchema.nullable().default(null),
  rowCurrent: z.record(z.string(), agentRecordValueSchema).nullable().default(null),
});
export type AuthoringProposal = z.infer<typeof authoringProposalSchema>;
export type RowProposal = Extract<AuthoringProposal, { kind: 'row' }>;
export type WorkflowProposal = Extract<AuthoringProposal, { kind: 'workflow' | 'workflow-activation' }>;
export type DraftOutcome = z.infer<typeof draftOutcomeSchema>;
export type DraftView = z.infer<typeof draftViewSchema>;
export type AgentDraftChange = z.infer<typeof agentDraftChangeSchema>;
export type AgentDefinitionField = keyof z.infer<typeof agentDefinitionSchema>;
