import { z } from 'zod';
import { trelloOperationSchema } from './trello-contracts.ts';

const id = z.uuid();
const pageId = z.string().regex(/^[1-9][0-9]{0,30}$/);
const trelloId = z.string().regex(/^[a-f0-9]{24}$/);
const issueId = z.string().regex(/^(?:[1-9][0-9]{0,30}|[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,15})$/);
const title = z.string().trim().min(1).max(1024);
const text = z.string().max(32768);
export const sourceBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('jira'), cloudId: id }),
  z.strictObject({ kind: z.literal('confluence'), cloudId: id }),
  z.strictObject({ kind: z.literal('confluence-trash'), cloudId: id, spaceId: pageId }),
  z.strictObject({ kind: z.literal('trello'), boardId: trelloId }),
]);
export const createSourceSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  accountId: id,
  binding: sourceBindingSchema,
});
export const sourceSchema = createSourceSchema.extend({ id, enabled: z.boolean() });
export const providerOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('jira.search'),
    jql: z.string().trim().min(1).max(4096),
    maxResults: z.number().int().min(1).max(50).default(20),
    nextPageToken: z.string().max(2048).optional(),
  }),
  z.strictObject({ kind: z.literal('jira.read'), issueIdOrKey: issueId }),
  z.strictObject({
    kind: z.literal('jira.create'),
    projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    issueTypeName: z.string().min(1).max(100),
    summary: title,
    description: text.optional(),
  }),
  z.strictObject({
    kind: z.literal('jira.update'),
    issueIdOrKey: issueId,
    fields: z
      .strictObject({ summary: title.optional(), description: text.optional() })
      .refine(value => Object.keys(value).length > 0),
  }),
  z.strictObject({ kind: z.literal('jira.delete'), issueIdOrKey: issueId }),
  z.strictObject({
    kind: z.literal('confluence.search'),
    cql: z.string().trim().min(1).max(4096),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.strictObject({ kind: z.literal('confluence.read'), id: pageId }),
  z.strictObject({
    kind: z.literal('confluence.create'),
    spaceKey: z.string().regex(/^[A-Za-z0-9_~-]{1,128}$/),
    title,
    body: text,
    representation: z.literal('storage'),
  }),
  z.strictObject({
    kind: z.literal('confluence.update'),
    id: pageId,
    title,
    body: text,
    representation: z.literal('storage'),
    version: z.number().int().positive().max(2147483647),
  }),
  z.strictObject({ kind: z.literal('confluence.trash'), pageId }),
  ...trelloOperationSchema.options,
]);
export type ProviderOperation = z.infer<typeof providerOperationSchema>;
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export const operationRequestSchema = z.strictObject({ sourceId: id, operation: providerOperationSchema });
export const proposalRequestSchema = operationRequestSchema.extend({ commandId: id });
export const approvalDecisionSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
});
export const receiptSchema = z.strictObject({
  status: z.enum(['executing', 'succeeded', 'failed', 'outcome-unknown']),
  result: z.json().nullable(),
  error: z.string().nullable(),
});
export const proposalSchema = z.strictObject({
  id,
  source: sourceSchema,
  operation: providerOperationSchema,
  digest: z.string(),
  expiresAt: z.iso.datetime(),
  decision: z.enum(['approve', 'reject']).nullable(),
  receipt: receiptSchema.nullable(),
});
export const untrustedResultSchema = z.strictObject({ untrusted: z.literal(true), data: z.json() });
export function isWrite(operation: ProviderOperation) {
  return !operation.kind.endsWith('.read') && !operation.kind.endsWith('.search');
}
