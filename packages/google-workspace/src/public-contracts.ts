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
  operationRequestSchema,
  proposalRequestSchema,
  approvalDecisionSchema,
  googleResultSchema,
  googleReceiptSchema,
  googleProposalSchema,
  googleProposalSummarySchema,
  googleProposalCursorSchema,
  googleProposalListQuerySchema,
  googleProposalListSchema,
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
export const googleStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('disconnected') }),
  z.strictObject({
    status: z.enum(['connected', 'reconnect-required']),
    integrationId: z.uuid(),
    generation: z.number().int().positive(),
    accountId: z.string(),
    email: z.string(),
    scopes: z.array(z.string()),
  }),
]);
export type GoogleStatus = z.infer<typeof googleStatusSchema>;
export const googleAvailabilitySchema = z.strictObject({ configured: z.boolean() });
export const googleAuthorizationSchema = z.strictObject({ authorizationUrl: z.url() });
export const googleDisconnectSchema = z.strictObject({ disconnected: z.literal(true), revoked: z.boolean() });
