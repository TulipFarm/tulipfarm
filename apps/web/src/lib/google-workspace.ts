import { z } from 'zod';
import {
  googleStatusSchema,
  googleAvailabilitySchema,
  googleAuthorizationSchema,
  googleDisconnectSchema,
  googleProposalListSchema,
  googleProposalSchema,
  googleReceiptSchema,
  approvalDecisionSchema,
  heartbeatViewSchema,
  heartbeatCommandSchema,
  heartbeatResultsSchema,
  heartbeatRetrySchema,
  heartbeatRetryResultSchema,
  operationRequestSchema,
  proposalRequestSchema,
  googleResultSchema,
  type GoogleApp,
} from '@tulipfarm/google-workspace/public-contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, requestSignal, responseError } from './http';

export type GoogleProposal = z.infer<typeof googleProposalSchema>;
export type HeartbeatView = z.infer<typeof heartbeatViewSchema>;
export type HeartbeatCommand = z.infer<typeof heartbeatCommandSchema>;
export type HeartbeatRetry = z.infer<typeof heartbeatRetrySchema>;
export class GoogleRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function googleActionRefused(error: unknown) {
  return (
    error instanceof GoogleRequestError &&
    [
      'operation-revision-required',
      'operation-target-stale',
      'operation-unguarded-update',
      'calendar-feature-disabled',
    ].includes(error.code)
  );
}
export function googleAccessLost(error: unknown) {
  return (
    error instanceof GoogleRequestError &&
    ([401, 403, 404].includes(error.status) ||
      ['reconnect-required', 'integration-required', 'stale-integration', 'heartbeat-stale'].includes(error.code))
  );
}
export function googleError(error: unknown): string {
  if (error instanceof GoogleRequestError) {
    if (error.status === 401) return 'Your session expired. Sign in again, then check status.';
    if (error.status === 403 || error.status === 404)
      return 'This personal Google resource is unavailable to your current membership. Return to your workspace or sign in again.';
    if (error.code === 'not-configured')
      return 'Google is not configured. Ask your operator to configure Google Workspace OAuth, then check status.';
    if (['reconnect-required', 'integration-required', 'stale-integration', 'heartbeat-stale'].includes(error.code))
      return 'Reconnect Google, then reload the saved settings before continuing.';
    if (error.code === 'operation-expired')
      return 'This proposal expired. Check its status before asking for a new proposal.';
    if (error.code === 'calendar-feature-disabled')
      return 'Google Meet creation is not enabled for this workspace. No Calendar write was sent.';
    if (error.code === 'operation-revision-required')
      return 'This action cannot run because it was saved without a required Google revision. Ask for a new proposal before approving or executing it.';
    if (error.code === 'operation-target-stale')
      return 'This action cannot run because the Google file changed after review. Ask for a new proposal based on the latest file state.';
    if (error.code === 'operation-unguarded-update')
      return 'This action cannot run because it would update Google without a supported review guard. Ask for a new proposal that uses a guarded operation.';
    if (error.status === 409)
      return 'The saved state changed or conflicts with this request. Check status before making another change.';
    if (error.status === 400) return 'The request was rejected. Check the field values before continuing.';
  }
  return 'The response could not be confirmed. Check status before making another change.';
}
async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1${path}`, {
    method,
    body,
    cache: 'no-store',
    signal: requestSignal(signal),
  });
  const value = await readJson(response, !response.ok);
  if (!response.ok) throw new GoogleRequestError(response.status, responseError(value, 'unavailable'));
  return schema.parse(value);
}
const base = (id: string) => `/workspaces/${encodeURIComponent(id)}/google-workspace`;
export const googleApi = {
  propose: async (id: string, input: z.infer<typeof proposalRequestSchema>) =>
    request(`${base(id)}/operations/proposals`, googleProposalSchema, 'POST', proposalRequestSchema.parse(input)),
  read: (id: string, input: z.infer<typeof operationRequestSchema>, signal?: AbortSignal) =>
    request(`${base(id)}/operations/read`, googleResultSchema, 'POST', operationRequestSchema.parse(input), signal),
  availability: (signal?: AbortSignal) =>
    request('/google-workspace/availability', googleAvailabilitySchema, 'GET', undefined, signal),
  status: (id: string, signal?: AbortSignal) => request(base(id), googleStatusSchema, 'GET', undefined, signal),
  begin: (id: string, app?: GoogleApp) =>
    request(`${base(id)}/begin${app ? `?app=${app}` : ''}`, googleAuthorizationSchema, 'POST'),
  disconnect: (id: string) => request(base(id), googleDisconnectSchema, 'DELETE'),
  proposals: (id: string, cursor: string | null, signal?: AbortSignal) =>
    request(
      `${base(id)}/operations/proposals?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      googleProposalListSchema,
      'GET',
      undefined,
      signal,
    ),
  proposal: (id: string, proposalId: string, signal?: AbortSignal) =>
    request(`${base(id)}/operations/proposals/${proposalId}`, googleProposalSchema, 'GET', undefined, signal),
  decide: (id: string, proposal: GoogleProposal, decision: 'approve' | 'reject') =>
    request(
      `${base(id)}/operations/proposals/${proposal.id}/decision`,
      googleProposalSchema,
      'POST',
      approvalDecisionSchema.parse({ digest: proposal.digest, decision }),
    ),
  execute: (id: string, proposalId: string) =>
    request(`${base(id)}/operations/proposals/${proposalId}/execute`, googleReceiptSchema.nullable(), 'POST'),
  heartbeat: (id: string, signal?: AbortSignal) =>
    request(`${base(id)}/heartbeat`, heartbeatViewSchema, 'GET', undefined, signal),
  saveHeartbeat: (id: string, command: HeartbeatCommand) =>
    request(`${base(id)}/heartbeat`, heartbeatViewSchema, 'POST', heartbeatCommandSchema.parse(command)),
  retryHeartbeat: (id: string, command: HeartbeatRetry) =>
    request(`${base(id)}/heartbeat/retry`, heartbeatRetryResultSchema, 'POST', heartbeatRetrySchema.parse(command)),
  results: (id: string, cursor: string | null, signal?: AbortSignal) =>
    request(
      `${base(id)}/heartbeat/results?limit=20${cursor ? `&before=${cursor}` : ''}`,
      heartbeatResultsSchema,
      'GET',
      undefined,
      signal,
    ),
};

export async function loadGoogleIntegration(workspaceId: string, signal: AbortSignal) {
  const availability = googleApi.availability(signal).then(
    value => ({ kind: 'success' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  const status = await googleApi.status(workspaceId, signal);
  const configuration = await availability;
  if (configuration.kind === 'error') throw configuration.error;
  return { ...configuration.value, status };
}
