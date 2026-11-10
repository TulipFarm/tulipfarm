import { z } from 'zod';
import { savePersonalMemorySchema } from '@tulipfarm/conversations/personal-memory-contracts';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { saveAgentSchema, agentCommandStatusSchema } from './saved-contracts.ts';
import { saveWorkspaceSkillSchema, workspaceSkillReceiptSchema } from './workspace-skill-contracts.ts';
import { agentDefinitionSchema, createRecordBatchSchema, taskMutationSchema } from './contracts.ts';
import { agentRecordValueSchema } from './record-contracts.ts';
import { fileNameSchema, moveFingerprintSchema, shareFingerprintSchema } from '@tulipfarm/files/contracts';
import { authoredDefinitionSchema, definitionSchema } from '@tulipfarm/workflows/contracts';
import { agentSetupConsentSchema, agentSetupDetailsSchema, agentSetupReceiptSchema } from './setup-contracts.ts';

export const agentDraftInputSchema = saveAgentSchema.omit({ requestId: true }).extend({
  setup: agentSetupDetailsSchema.optional(),
  expectedPolicyVersion: z.number().int().nonnegative().optional(),
  expectedActivationIds: z.array(uuidSchema).optional(),
  /** The agent's linked Workflow as reviewed: null when it has none, absent on drafts from before that binding. */
  expectedWorkflowRevision: uuidSchema.nullable().optional(),
  expectedWorkflowGeneration: z.number().int().positive().nullable().optional(),
});
const workflowLifecycleInput = z.strictObject({
  workflows: z
    .array(z.strictObject({ id: uuidSchema, revision: uuidSchema, name: z.string() }))
    .min(1)
    .max(20)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Workflows must be distinct'),
});
const distinct = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
const agentLifecycleInput = z.strictObject({
  agents: z
    .array(z.strictObject({ id: uuidSchema, name: z.string() }))
    .min(1)
    .max(20)
    .refine(distinct, 'Agents must be distinct'),
});
const skillLifecycleInput = z.strictObject({
  skills: z
    .array(z.strictObject({ id: uuidSchema, version: z.number().int().positive(), name: z.string() }))
    .min(1)
    .max(20)
    .refine(distinct, 'Skills must be distinct'),
});
const projectSettings = z.strictObject({
  name: z.string().trim().min(1).max(160),
  instructions: z.string().refine(value => Buffer.byteLength(value) <= 65536, 'Instructions exceed 64 KiB'),
  archived: z.boolean(),
});
const projectDraftInput = z.strictObject({
  expectedRevision: z.number().int().nonnegative().nullable(),
  settings: projectSettings,
  current: projectSettings.nullable(),
});
const fileDraftItem = z.strictObject({
  id: uuidSchema,
  kind: z.enum(['file', 'folder']),
  name: z.string(),
  parentId: uuidSchema.nullable(),
  /** The folder's name when the reader can open it; null for the top level or a folder they cannot see. */
  parentName: z.string().nullable(),
  trashed: z.boolean(),
  /** A move's preview fingerprint: the move is refused if who can open the item would change differently. */
  fingerprint: moveFingerprintSchema.optional(),
  /** Whether moving changes who can open the item or anything inside it. */
  accessChanges: z.boolean().optional(),
});
const fileDraftInput = z
  .strictObject({
    change: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('rename'), name: fileNameSchema }),
      z.strictObject({ kind: z.literal('move'), parentId: uuidSchema.nullable(), parentName: z.string().nullable() }),
      z.strictObject({ kind: z.literal('trash') }),
      z.strictObject({ kind: z.literal('restore') }),
    ]),
    items: z.array(fileDraftItem).min(1).max(20).refine(distinct, 'Files must be distinct'),
  })
  .refine(input => input.change.kind !== 'rename' || input.items.length === 1, 'Rename one item at a time')
  .refine(
    input => input.change.kind !== 'move' || input.items.every(item => item.fingerprint),
    'A move needs the access check for each item',
  );
const knowledgeTitle = z.string().trim().min(1).max(512);
const knowledgeContent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('note'), text: z.string().min(1).max(100_000) }),
  z.strictObject({ kind: z.literal('file'), fileId: uuidSchema, fileName: z.string() }),
]);
const knowledgeDraftInput = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('add'), title: knowledgeTitle, content: knowledgeContent }),
  z.strictObject({
    operation: z.literal('update'),
    expectedRevisionId: uuidSchema,
    previousTitle: z.string(),
    title: knowledgeTitle,
    content: knowledgeContent,
  }),
  z.strictObject({
    operation: z.literal('remove'),
    expectedRevisionId: uuidSchema,
    title: z.string(),
    entry: z.enum(['note', 'file']),
  }),
]);
const memoryContent = savePersonalMemorySchema.shape.content;
const memoryRevision = savePersonalMemorySchema.shape.expectedRevision;
/** The requester's own personal memory. A restore card undoes a chat forget: `forgotten` is the text it removed. */
const memoryDraftInput = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('edit'),
    expectedRevision: memoryRevision,
    previousContent: z.string(),
    content: memoryContent,
  }),
  z.strictObject({
    operation: z.literal('restore'),
    expectedRevision: memoryRevision,
    previousContent: z.string(),
    content: memoryContent,
    forgotten: z.string(),
  }),
]);
const shareSubject = { kind: z.enum(['individual', 'team']), id: uuidSchema, name: z.string() };
/** Names shown for one side of who can open the item, capped so a large audience stays readable. */
const shareAudience = z.strictObject({ names: z.array(z.string()).max(100), count: z.number().int().nonnegative() });
const fileShareDraftInput = z.strictObject({
  file: z.strictObject({ id: uuidSchema, name: z.string(), kind: z.enum(['file', 'folder']) }),
  /** The plan whose document this file is; its sources decide who may be shared with. */
  planId: uuidSchema.nullable(),
  role: z.enum(['viewer', 'editor']),
  /** Who gets the grant, with the direct role each has now. */
  subjects: z
    .array(z.strictObject({ ...shareSubject, current: z.enum(['viewer', 'editor', 'manager']).nullable() }))
    .min(1)
    .max(20)
    .refine(distinct, 'People and teams must be distinct'),
  /** Who was left off because they cannot read every source of the plan. */
  excluded: z.array(z.strictObject(shareSubject)).max(20),
  before: shareAudience,
  /** People who can open the item only once the grants are added. */
  added: shareAudience,
  /** The share is refused if the item's sharing changed since this preview. */
  fingerprint: shareFingerprintSchema,
});
/** The most rows one chat reply may write without an approval card. */
export const directChatRowLimit = 5;
/** Why a trusted chat row write still needs approval: see chat-row-guard.ts. */
export const rowReviewReasonSchema = z.enum(['table-change-pending', 'table-not-named', 'too-many-rows']);
/**
 * Rows the same reply had already written directly before this card was made. They stay written; the card holds
 * only the rest. `rows` lists the ones added to the card's table, `count` every row the reply changed.
 */
export const rowsAlreadyWrittenSchema = z.strictObject({
  count: z.int().min(1).max(directChatRowLimit),
  rows: z
    .array(z.strictObject({ recordId: uuidSchema, values: createRecordBatchSchema.shape.rows.element.shape.values }))
    .max(directChatRowLimit),
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
  z.strictObject({ kind: z.literal('workflow-archive'), targetId: uuidSchema, input: workflowLifecycleInput }),
  z.strictObject({ kind: z.literal('workflow-restore'), targetId: uuidSchema, input: workflowLifecycleInput }),
  z.strictObject({ kind: z.literal('agent-archive'), targetId: uuidSchema, input: agentLifecycleInput }),
  z.strictObject({ kind: z.literal('agent-restore'), targetId: uuidSchema, input: agentLifecycleInput }),
  z.strictObject({ kind: z.literal('skill-archive'), targetId: uuidSchema, input: skillLifecycleInput }),
  z.strictObject({ kind: z.literal('skill-restore'), targetId: uuidSchema, input: skillLifecycleInput }),
  z.strictObject({ kind: z.literal('project'), targetId: uuidSchema, input: projectDraftInput }),
  z.strictObject({ kind: z.literal('files'), targetId: uuidSchema, input: fileDraftInput }),
  z.strictObject({ kind: z.literal('file-share'), targetId: uuidSchema, input: fileShareDraftInput }),
  /** targetId is the Knowledge document: a new ID when adding. */
  z.strictObject({ kind: z.literal('knowledge'), targetId: uuidSchema, input: knowledgeDraftInput }),
  z.strictObject({ kind: z.literal('memory'), input: memoryDraftInput }),
  z.strictObject({
    kind: z.literal('row'),
    input: z.discriminatedUnion('tool', [...taskMutationSchema.options, createRecordBatchSchema]),
    /** Why chat could not write directly. Absent on drafts made because the chat used untrusted content. */
    reason: rowReviewReasonSchema.optional(),
    written: rowsAlreadyWrittenSchema.optional(),
  }),
]);
export const draftDecisionSchema = z.strictObject({
  commandId: uuidSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  /** `continue` records that the requester saved this agent setup draft in the agent builder instead. */
  decision: z.enum(['save', 'activate', 'dismiss', 'continue']),
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
  z.object({ kind: z.literal('unavailable') }),
  z.object({
    kind: z.literal('agent'),
    receipt: agentCommandStatusSchema,
    setupReceipt: agentSetupReceiptSchema.optional(),
  }),
  /** Continued in the agent builder; `setupReceipt` is its latest save or activation since then. */
  z.object({ kind: z.literal('builder'), agentId: z.uuid(), setupReceipt: agentSetupReceiptSchema.optional() }),
  z.object({ kind: z.literal('skill'), receipt: workspaceSkillReceiptSchema }),
  z.object({
    kind: z.literal('workflow'),
    workflowId: z.uuid(),
    revision: z.uuid(),
    enabled: z.boolean(),
    nextRunAt: z.string().nullable(),
    activation: workflowActivationOutcomeSchema,
  }),
  z.object({
    kind: z.literal('row'),
    operation: z.enum(['create', 'update', 'delete']),
    recordId: z.uuid(),
    /** Every row an approved batch created; recordId is the first. */
    recordIds: z.array(z.uuid()).optional(),
  }),
  z.object({ kind: z.literal('workflow-archive'), workflowIds: z.array(z.uuid()) }),
  z.object({ kind: z.literal('workflow-restore'), workflowIds: z.array(z.uuid()) }),
  z.object({ kind: z.literal('agent-archive'), agentIds: z.array(z.uuid()) }),
  z.object({ kind: z.literal('agent-restore'), agentIds: z.array(z.uuid()) }),
  z.object({ kind: z.literal('skill-archive'), skillIds: z.array(z.uuid()) }),
  z.object({ kind: z.literal('skill-restore'), skillIds: z.array(z.uuid()) }),
  z.object({ kind: z.literal('project'), projectId: z.uuid(), revision: z.number().int() }),
  z.object({
    kind: z.literal('files'),
    change: z.enum(['rename', 'move', 'trash', 'restore']),
    fileIds: z.array(z.uuid()),
  }),
  z.object({
    kind: z.literal('file-share'),
    fileId: z.uuid(),
    role: z.enum(['viewer', 'editor']),
    subjects: z.array(z.object({ kind: z.enum(['individual', 'team']), id: z.uuid() })),
  }),
  z.object({
    kind: z.literal('knowledge'),
    operation: z.enum(['add', 'update', 'remove']),
    documentId: z.uuid(),
  }),
  z.object({ kind: z.literal('memory'), operation: z.enum(['edit', 'restore']), revision: z.number().int() }),
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
  status: z.enum(['pending', 'stale', 'preparing', 'saved', 'failed', 'dismissed', 'continued']),
  outcome: draftOutcomeSchema.nullable(),
  /** An undecided workflow draft that a later draft in the same chat replaced. Its status is `stale`. */
  replaced: z.boolean().default(false),
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
export type WorkflowLifecycleProposal = Extract<AuthoringProposal, { kind: 'workflow-archive' | 'workflow-restore' }>;
export const isWorkflowLifecycle = (proposal: AuthoringProposal): proposal is WorkflowLifecycleProposal =>
  proposal.kind === 'workflow-archive' || proposal.kind === 'workflow-restore';
export type DefinitionLifecycleProposal = Extract<
  AuthoringProposal,
  { kind: 'agent-archive' | 'agent-restore' | 'skill-archive' | 'skill-restore' }
>;
export const isDefinitionLifecycle = (proposal: AuthoringProposal): proposal is DefinitionLifecycleProposal =>
  ['agent-archive', 'agent-restore', 'skill-archive', 'skill-restore'].includes(proposal.kind);
export type ProjectProposal = Extract<AuthoringProposal, { kind: 'project' }>;
export type FilesProposal = Extract<AuthoringProposal, { kind: 'files' }>;
export type FileShareProposal = Extract<AuthoringProposal, { kind: 'file-share' }>;
export type KnowledgeProposal = Extract<AuthoringProposal, { kind: 'knowledge' }>;
export type MemoryProposal = Extract<AuthoringProposal, { kind: 'memory' }>;
export type DraftOutcome = z.infer<typeof draftOutcomeSchema>;
export type DraftView = z.infer<typeof draftViewSchema>;
export type AgentDraftChange = z.infer<typeof agentDraftChangeSchema>;
export type AgentDefinitionField = keyof z.infer<typeof agentDefinitionSchema>;
