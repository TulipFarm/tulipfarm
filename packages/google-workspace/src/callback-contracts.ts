import { z } from 'zod';

export const googleCallbackOutcomeSchema = z.enum([
  'connected',
  'sign-in-required',
  'invalid-request',
  'invalid-state',
  'consent-denied',
  'not-configured',
  'reconnect-required',
  'insufficient-scope',
  'stale-integration',
  'provider-unavailable',
  'credential-unavailable',
  'integration-not-found',
  'integrations-unavailable',
  'integration-operation-failed',
]);
export const googleCallbackResultSchema = z.strictObject({
  outcome: googleCallbackOutcomeSchema,
  workspaceId: z.uuid().optional(),
});
export type GoogleCallbackResult = z.infer<typeof googleCallbackResultSchema>;
