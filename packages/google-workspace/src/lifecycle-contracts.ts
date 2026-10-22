import { z } from 'zod';
import { googleOperationSchema, googleOperationCatalog, type GoogleOperation } from './operation-contracts.ts';

export class GoogleLifecycleError extends Error {
  readonly code:
    | 'integration-required'
    | 'operation-conflict'
    | 'operation-expired'
    | 'operation-limit'
    | 'operation-read-required'
    | 'operation-write-required'
    | 'operation-approval-required'
    | 'operation-revision-required'
    | 'operation-target-stale'
    | 'operation-unguarded-update'
    | 'calendar-feature-disabled';
  constructor(code: GoogleLifecycleError['code']) {
    super(code);
    this.code = code;
  }
}
export const googleReadBindingSchema = z.strictObject({
  integrationId: z.uuid(),
  accountId: z.string(),
  generation: z.number().int().positive(),
  scopes: z.array(z.string()),
});
export const operationRequestSchema = z.strictObject({
  operation: googleOperationSchema,
  expectedIntegration: googleReadBindingSchema.optional(),
});
export const proposalRequestSchema = z.strictObject({ operation: googleOperationSchema, commandId: z.uuid() });
export const approvalDecisionSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
});
/**
 * What a Sheets write on a created or copied spreadsheet checked. Sheets has no write precondition, so TulipFarm reads
 * the Drive `version` just before the write; an edit landing after that read is not detected.
 */
export const googleVersionGuardSchema = z.object({
  requiredVersion: z.string(),
  versionAfterWrite: z.string().nullable(),
  residualRace: z.literal(
    'An edit saved between the final Drive version read and this write is not detected and may have been overwritten.',
  ),
});
export const googleResultSchema = z.object({
  untrusted: z.literal(true),
  data: z.json(),
  versionGuard: googleVersionGuardSchema.optional(),
});
export const googleReceiptSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('executing'), result: z.null(), error: z.null() }),
  z.object({ status: z.literal('succeeded'), result: googleResultSchema, error: z.null() }),
  z.object({ status: z.literal('failed'), result: z.null(), error: z.literal('provider-request-failed') }),
  z.object({ status: z.literal('outcome-unknown'), result: z.null(), error: z.literal('provider-outcome-unknown') }),
]);
export const googleProposalSchema = z.object({
  id: z.uuid(),
  operation: googleOperationSchema,
  digest: z.string(),
  expiresAt: z.iso.datetime(),
  integration: z.object({
    integrationId: z.uuid(),
    accountId: z.string(),
    generation: z.number().int(),
    scopes: z.array(z.string()),
    requiredScopes: z.array(z.string()),
  }),
  decision: z.enum(['approve', 'reject']).nullable(),
  receipt: googleReceiptSchema.nullable(),
});
export const googleProposalSummarySchema = z.object({
  id: z.uuid(),
  operationKind: z.enum(googleOperationCatalog.map(entry => entry.kind)),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  decision: z.enum(['approve', 'reject']).nullable(),
  receiptStatus: z.enum(['executing', 'succeeded', 'failed', 'outcome-unknown']).nullable(),
});
export const googleProposalCursorSchema = z
  .string()
  .max(100)
  .refine(value => {
    const [createdAt, id, extra] = value.split('~');
    return extra === undefined && z.iso.datetime().safeParse(createdAt).success && z.uuid().safeParse(id).success;
  });
export const googleProposalListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: googleProposalCursorSchema.optional(),
});
export const googleProposalListSchema = z.object({
  proposals: z.array(googleProposalSummarySchema).max(100),
  nextCursor: googleProposalCursorSchema.nullable(),
});
export function requiredScopes(operation: GoogleOperation): string[] {
  const contract = googleOperationCatalog.find(entry => entry.kind === operation.kind);
  if (!contract) throw new GoogleLifecycleError('operation-conflict');
  return [...new Set(contract.requiredScopes)].sort();
}
