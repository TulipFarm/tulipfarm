import { z } from 'zod';
import { googleOperationSchema, googleOperationCatalog, type GoogleOperation } from './operation-contracts.ts';

export class GoogleLifecycleError extends Error {
  readonly code:
    | 'integration-required'
    | 'operation-conflict'
    | 'operation-expired'
    | 'operation-limit'
    | 'operation-policy-denied'
    | 'operation-read-required'
    | 'operation-write-required'
    | 'operation-approval-required'
    | 'operation-revision-required'
    | 'operation-target-stale'
    | 'operation-unguarded-update';
  constructor(code: GoogleLifecycleError['code'], message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export const googleAutonomousWriteKinds = [
  'gmail.messages.send',
  'gmail.messages.modify',
  'gmail.drafts.create',
  'gmail.drafts.update',
  'gmail.drafts.send',
  'calendar.events.create',
  'calendar.events.update',
] as const;
export type GoogleAutonomousWriteKind = (typeof googleAutonomousWriteKinds)[number];

export const googleAutonomousWritePolicySchema = z.strictObject({
  allowedOperations: z.array(z.enum(googleAutonomousWriteKinds)).min(1).max(20),
  allowedRecipients: z.array(z.string().trim().min(1).max(254)).max(100).optional(),
});
export type GoogleAutonomousWritePolicy = z.infer<typeof googleAutonomousWritePolicySchema>;

export type AutonomousWritePolicyCheck =
  | { allowed: true }
  | { allowed: false; reason: 'operation-not-allowed' }
  | { allowed: false; reason: 'recipient-not-allowed'; blockedRecipients: string[] };

function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const angle = /<([^<>]+)>/.exec(trimmed);
  return (angle?.[1] ?? trimmed).trim().toLowerCase();
}

function extractOperationRecipients(operation: GoogleOperation): string[] {
  switch (operation.kind) {
    case 'gmail.messages.send':
    case 'gmail.drafts.create':
    case 'gmail.drafts.update':
    case 'gmail.drafts.send':
      return [...operation.message.to, ...(operation.message.cc ?? []), ...(operation.message.bcc ?? [])];
    case 'calendar.events.create':
    case 'calendar.events.update':
      return (operation.event.attendees ?? []).map(attendee => attendee.email);
    default:
      return [];
  }
}

export function checkAutonomousWritePolicy(
  operation: GoogleOperation,
  policy: GoogleAutonomousWritePolicy,
): AutonomousWritePolicyCheck {
  if (!(policy.allowedOperations as readonly string[]).includes(operation.kind)) {
    return { allowed: false, reason: 'operation-not-allowed' };
  }
  if (policy.allowedRecipients !== undefined) {
    const rules = policy.allowedRecipients.map(rule => rule.trim().toLowerCase());
    const blockedRecipients: string[] = [];
    const seen = new Set<string>();
    for (const raw of extractOperationRecipients(operation)) {
      const email = normalizeEmailAddress(raw);
      const matched = rules.some(rule => (rule.startsWith('@') ? email.endsWith(rule) : email === rule));
      if (!matched && !seen.has(email)) {
        seen.add(email);
        blockedRecipients.push(email);
      }
    }
    if (blockedRecipients.length > 0) {
      return { allowed: false, reason: 'recipient-not-allowed', blockedRecipients };
    }
  }
  return { allowed: true };
}

export const autonomousExecuteRequestSchema = z.strictObject({
  commandId: z.uuid(),
  integrationId: z.uuid(),
  operation: googleOperationSchema,
  policy: googleAutonomousWritePolicySchema,
});
export const googleReadBindingSchema = z.strictObject({
  integrationId: z.uuid(),
  accountId: z.string(),
  generation: z.number().int().positive(),
  scopes: z.array(z.string()),
});
export const operationRequestSchema = z.strictObject({
  operation: googleOperationSchema,
  expectedIntegration: googleReadBindingSchema.optional(),
  integrationId: z.uuid().optional(),
});
export const proposalRequestSchema = z.strictObject({
  operation: googleOperationSchema,
  commandId: z.uuid(),
  integrationId: z.uuid().optional(),
});
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
