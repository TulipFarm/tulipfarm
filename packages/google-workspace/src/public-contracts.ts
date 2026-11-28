import { z } from 'zod';
export {
  googleCallbackOutcomeSchema,
  googleCallbackResultSchema,
  type GoogleCallbackResult,
} from './callback-contracts.ts';
export {
  googleCorpusSelectionSchema,
  googleCorpusBindingSchema,
  googleCorpusCursorSchema,
  googleCorpusKindSchema,
  googleCorpusErrorCodeSchema,
  type GoogleCorpusSelection,
  type GoogleCorpusBinding,
  type GoogleCorpusCursor,
} from './corpus-contracts.ts';
export * from './file-contracts.ts';
export {
  heartbeatSettingsSchema,
  heartbeatCommandSchema,
  heartbeatRetrySchema,
  heartbeatRetryResultSchema,
  heartbeatViewSchema,
  heartbeatPageSchema,
  heartbeatResultSchema,
  heartbeatResultsSchema,
  type HeartbeatSettings,
} from './heartbeat-contracts.ts';

export {
  googleOperationSchema,
  googleOperationCatalog,
  isGoogleWrite,
  type GoogleOperation,
} from './operation-contracts.ts';
export {
  googleAutonomousWriteKinds,
  googleAutonomousWritePolicySchema,
  checkAutonomousWritePolicy,
  operationRequestSchema,
  proposalRequestSchema,
  autonomousExecuteRequestSchema,
  approvalDecisionSchema,
  googleResultSchema,
  googleReceiptSchema,
  googleProposalSchema,
  googleProposalSummarySchema,
  googleProposalCursorSchema,
  googleProposalListQuerySchema,
  googleProposalListSchema,
  type GoogleAutonomousWriteKind,
  type GoogleAutonomousWritePolicy,
  type AutonomousWritePolicyCheck,
} from './lifecycle-contracts.ts';

const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
export const googleIdentityScopes = ['openid', scope('userinfo.email')];
export const googleAppScopes = {
  gmail: [scope('gmail.modify'), scope('gmail.send')],
  calendar: [scope('calendar')],
  drive: [scope('drive')],
  sheets: [scope('spreadsheets')],
  docs: [scope('documents')],
  slides: [scope('presentations')],
} as const;
export const googleAppSchema = z.enum(['gmail', 'calendar', 'drive', 'sheets', 'docs', 'slides']);
export type GoogleApp = z.infer<typeof googleAppSchema>;
export const googleOwnershipSchema = z.enum(['personal', 'shared']);
export type GoogleOwnership = z.infer<typeof googleOwnershipSchema>;
export const googleGrantRoleSchema = z.enum(['use', 'manage']);
export type GoogleGrantRole = z.infer<typeof googleGrantRoleSchema>;
export const googleGrantTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace'), role: googleGrantRoleSchema }),
  z.strictObject({ kind: z.literal('member'), membershipId: z.uuid(), role: googleGrantRoleSchema }),
  z.strictObject({ kind: z.literal('team'), teamId: z.uuid(), role: googleGrantRoleSchema }),
]);
export type GoogleGrantTarget = z.infer<typeof googleGrantTargetSchema>;
export const googleGrantsResponseSchema = z.strictObject({
  integrationId: z.uuid(),
  grantsVersion: z.number().int().positive(),
  grants: z.array(googleGrantTargetSchema),
});
export type GoogleGrantsResponse = z.infer<typeof googleGrantsResponseSchema>;
export const googleGrantsUpdateSchema = z.strictObject({
  expectedGrantsVersion: z.number().int().positive(),
  grants: z.array(googleGrantTargetSchema).max(200),
});
export type GoogleGrantsUpdate = z.infer<typeof googleGrantsUpdateSchema>;
export const googleLabelSchema = z
  .string()
  .min(1)
  .max(120)
  .refine(value => ![...value].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f));
export const googleBeginOptionsSchema = z.strictObject({
  integrationId: z.uuid().optional(),
  ownership: googleOwnershipSchema.optional(),
  label: googleLabelSchema.optional(),
  newAccount: z.boolean().optional(),
});
export type GoogleBeginOptions = z.infer<typeof googleBeginOptionsSchema>;
export const googleShareSummarySchema = z.strictObject({
  workspace: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  teamCount: z.number().int().nonnegative(),
});
export type GoogleShareSummary = z.infer<typeof googleShareSummarySchema>;
export const googleAccountSummarySchema = z.strictObject({
  integrationId: z.uuid(),
  ownership: googleOwnershipSchema,
  status: z.enum(['connected', 'reconnect-required', 'disconnected']),
  accountId: z.string().optional(),
  email: z.string().optional(),
  label: z.string().optional(),
  generation: z.number().int().positive(),
  grantsVersion: z.number().int().positive(),
  scopes: z.array(z.string()),
  canUse: z.boolean(),
  canManage: z.boolean(),
  shareSummary: googleShareSummarySchema.optional(),
});
export type GoogleAccountSummary = z.infer<typeof googleAccountSummarySchema>;
export const googleAccountsListSchema = z.strictObject({
  accounts: z.array(googleAccountSummarySchema),
});
export const googleStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('disconnected'),
    accounts: z.array(googleAccountSummarySchema).optional(),
  }),
  z.strictObject({
    status: z.enum(['connected', 'reconnect-required']),
    integrationId: z.uuid(),
    generation: z.number().int().positive(),
    accountId: z.string(),
    email: z.string(),
    scopes: z.array(z.string()),
    accounts: z.array(googleAccountSummarySchema).optional(),
  }),
]);
export type GoogleStatus = z.infer<typeof googleStatusSchema>;
export const googleAvailabilitySchema = z.strictObject({ configured: z.boolean() });
export const googleAuthorizationSchema = z.strictObject({ authorizationUrl: z.url() });
export const googleDisconnectSchema = z.strictObject({ disconnected: z.literal(true), revoked: z.boolean() });
