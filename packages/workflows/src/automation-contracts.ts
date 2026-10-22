import { z } from 'zod';
import {
  githubBranchSelectionSchema,
  githubEventFieldSchema,
  githubEventSelectionSchema,
  githubRepositorySelectionSchema,
} from '@tulipfarm/github/event-contracts';

const id = z.uuid().transform(value => value.toLowerCase());
const generation = z.number().int().positive().max(2147483646);
export const automationDefaults = Object.freeze({
  messagesPerHour: 100,
  pendingRetentionDays: 30,
  maxMessageLength: 4000,
});
export const automationSourceSchema = z.strictObject({
  kind: z.literal('github'),
  sourceId: id,
  generation,
  repositories: githubRepositorySelectionSchema,
  events: githubEventSelectionSchema,
  baseBranches: githubBranchSelectionSchema,
  headBranches: githubBranchSelectionSchema,
});
export const automationTemplateSchema = z
  .strictObject({
    fields: z
      .array(githubEventFieldSchema)
      .max(14)
      .refine(fields => new Set(fields).size === fields.length, 'Approve each field once')
      .transform(fields => fields.sort()),
    parts: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('literal'),
            text: z.string().min(1).max(automationDefaults.maxMessageLength),
          }),
          z.strictObject({ kind: z.literal('field'), field: githubEventFieldSchema }),
        ]),
      )
      .min(1)
      .max(100),
  })
  .superRefine((template, context) => {
    const used = new Set(template.parts.flatMap(part => (part.kind === 'field' ? [part.field] : [])));
    if (template.fields.length !== used.size || template.fields.some(field => !used.has(field))) {
      context.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'Approve exactly the fields used by the template',
      });
    }
    if (
      template.parts.reduce((length, part) => length + (part.kind === 'literal' ? part.text.length : 0), 0) >
      automationDefaults.maxMessageLength
    ) {
      context.addIssue({ code: 'custom', path: ['parts'], message: 'Literal text exceeds the message limit' });
    }
  });
export const automationDestinationSchema = z.strictObject({
  kind: z.literal('slack'),
  destinationId: id,
  installationId: id,
  generation,
  version: generation,
  channelId: z.string().regex(/^[CG][A-Z0-9]+$/),
  sender: z.enum(['user', 'app']),
});
export const automationSetupSchema = z.strictObject({
  source: automationSourceSchema,
  destination: automationDestinationSchema,
  template: automationTemplateSchema,
  messagesPerHour: z.number().int().positive().max(2147483646),
});
export const automationApprovalSchema = z
  .strictObject({
    workflowId: id,
    revision: id,
    sponsorMembershipId: id,
    sponsorshipId: id,
    setup: automationSetupSchema,
    sharing: z.strictObject({
      approvedByMembershipId: id,
      sourceGeneration: generation,
      privateRepositoryExport: z.boolean(),
    }),
  })
  .refine(approval => approval.sharing.sourceGeneration === approval.setup.source.generation, {
    path: ['sharing', 'sourceGeneration'],
    message: 'Sharing approval must match the source generation',
  });
export const automationDraftInputSchema = z.strictObject({
  commandId: id,
  expectedVersion: z.number().int().nonnegative().max(2147483645),
  workflowId: id,
  expectedRevision: id,
  setup: automationSetupSchema,
});
export const automationDecisionSchema = z.strictObject({
  commandId: id,
  version: generation,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
  privateRepositoryExport: z.boolean(),
});
export const automationDecisionReceiptSchema = z
  .strictObject({
    commandId: id,
    workflowId: id,
    version: generation,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approve', 'reject']),
    privateRepositoryExport: z.boolean(),
    grantId: id.nullable(),
    grantDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .refine(
    receipt =>
      receipt.decision === 'approve'
        ? receipt.grantId !== null && receipt.grantDigest !== null
        : receipt.grantId === null && receipt.grantDigest === null,
    'Only approval receipts identify a grant',
  );
export const automationRevokeSchema = z.strictObject({ commandId: id, digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const automationDraftViewSchema = z.strictObject({
  workflowId: id,
  revision: id,
  membershipId: id,
  version: generation,
  setup: automationSetupSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: automationDecisionReceiptSchema.nullable(),
  grantRevokedAt: z.iso.datetime().nullable(),
});
export type AutomationTemplate = z.infer<typeof automationTemplateSchema>;
export type AutomationSetup = z.infer<typeof automationSetupSchema>;
export type AutomationApproval = z.infer<typeof automationApprovalSchema>;
