import { z } from 'zod';
import {
  accountListSchema,
  accountAuthorizationSchema,
  accountDisconnectionSchema,
  accountGrantsSchema,
  accountMetadataSchema,
  beginAccountSchema,
} from '@tulipfarm/atlassian/account-contracts';
import {
  createSourceSchema,
  sourceSchema,
  operationRequestSchema,
  proposalRequestSchema,
  proposalSchema,
  receiptSchema,
  approvalDecisionSchema,
  untrustedResultSchema,
} from '@tulipfarm/atlassian/operation-contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, requestSignal, responseError } from './http';

export type Account = z.infer<typeof accountMetadataSchema>;
export type AccountList = z.infer<typeof accountListSchema>;
export type Grants = z.infer<typeof accountGrantsSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalRequest = z.infer<typeof proposalRequestSchema>;
export type ProviderData = z.infer<typeof untrustedResultSchema>['data'];
const sourcesSchema = z.strictObject({
  sources: z.array(sourceSchema).max(100),
  mcp: z.strictObject({ enabled: z.boolean(), explanation: z.string() }),
});
export type SourceList = z.infer<typeof sourcesSchema>;

export class AtlassianRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function atlassianError(error: unknown) {
  if (error instanceof AtlassianRequestError) {
    if (error.status === 401) return 'Your session expired. Sign in again, then refresh Atlassian integrations.';
    if (error.status === 403 || error.status === 404)
      return 'This account or action is unavailable. Refresh integrations to check your access.';
    if (error.code === 'account-disabled')
      return 'Atlassian accounts are disabled. Ask your operator to configure the account backend, then refresh.';
    if (error.code === 'operation-disabled')
      return 'This operation is disabled. Ask your operator to configure protected operations and reviewed MCP contracts.';
    if (error.code === 'account-reconnect-required')
      return 'This account needs reconnecting. Reconnect it and complete consent, then refresh.';
    if (error.code === 'account-refresh-in-progress')
      return 'The account is refreshing. Wait, then refresh its status.';
    if (error.code === 'operation-expired')
      return 'This review expired. Check its receipt before preparing a new action.';
    if (error.code === 'account-limit-reached' || error.code === 'operation-limit')
      return 'The saved account, source, or operation limit was reached. Reuse an existing account or ask your operator for help.';
    if (error.status === 400) return 'The request was rejected. Check the field values before submitting again.';
    if (error.status === 409)
      return 'The saved state changed or conflicts with this request. Check its current status before continuing.';
  }
  return 'The response could not be confirmed. Your inputs are retained. Check the saved status before another change.';
}
export function rejected(error: unknown) {
  return error instanceof AtlassianRequestError && error.status >= 400 && error.status < 500;
}
export function accessLost(error: unknown) {
  return error instanceof AtlassianRequestError && [401, 403, 404].includes(error.status);
}

async function request<T>(
  workspaceId: string,
  path: string,
  schema: z.ZodType<T>,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await jsonResponse(
    `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/atlassian${path}`,
    { method, body, cache: 'no-store', signal: requestSignal(signal) },
  );
  const value = await readJson(response, !response.ok);
  if (!response.ok) throw new AtlassianRequestError(response.status, responseError(value, 'unavailable'));
  return schema.parse(value);
}
export const atlassianApi = {
  accounts: (workspaceId: string, signal?: AbortSignal) =>
    request(workspaceId, '/accounts', accountListSchema, 'GET', undefined, signal),
  begin: (workspaceId: string, body: z.infer<typeof beginAccountSchema>) =>
    request(workspaceId, '/accounts/begin', accountAuthorizationSchema, 'POST', beginAccountSchema.parse(body)),
  reconnect: (workspaceId: string, id: string) =>
    request(workspaceId, `/accounts/${id}/reconnect`, accountAuthorizationSchema, 'POST'),
  disconnect: (workspaceId: string, id: string) =>
    request(workspaceId, `/accounts/${id}/disconnect`, accountDisconnectionSchema, 'POST'),
  grants: (workspaceId: string, id: string, signal?: AbortSignal) =>
    request(workspaceId, `/accounts/${id}/grants`, accountGrantsSchema, 'GET', undefined, signal),
  saveGrants: (workspaceId: string, id: string, body: Grants) =>
    request(workspaceId, `/accounts/${id}/grants`, accountMetadataSchema, 'PUT', accountGrantsSchema.parse(body)),
  sources: (workspaceId: string, signal?: AbortSignal) =>
    request(workspaceId, '/sources', sourcesSchema, 'GET', undefined, signal),
  createSource: (workspaceId: string, body: z.infer<typeof createSourceSchema>) =>
    request(workspaceId, '/sources', sourceSchema, 'POST', createSourceSchema.parse(body)),
  disableSource: (workspaceId: string, id: string) =>
    request(workspaceId, `/sources/${id}/disable`, sourceSchema, 'POST'),
  discover: (workspaceId: string, id: string, signal?: AbortSignal) =>
    request(workspaceId, `/sources/${id}/qualify`, untrustedResultSchema, 'POST', undefined, signal),
  read: (workspaceId: string, body: z.infer<typeof operationRequestSchema>, signal?: AbortSignal) =>
    request(workspaceId, '/operations/read', untrustedResultSchema, 'POST', operationRequestSchema.parse(body), signal),
  propose: (workspaceId: string, body: ProposalRequest) =>
    request(workspaceId, '/operations/proposals', proposalSchema, 'POST', proposalRequestSchema.parse(body)),
  proposal: (workspaceId: string, id: string, signal?: AbortSignal) =>
    request(workspaceId, `/operations/proposals/${id}`, proposalSchema, 'GET', undefined, signal),
  decide: (workspaceId: string, proposal: Proposal, decision: 'approve' | 'reject') =>
    request(
      workspaceId,
      `/operations/proposals/${proposal.id}/decision`,
      proposalSchema,
      'POST',
      approvalDecisionSchema.parse({ digest: proposal.digest, decision }),
    ),
  execute: (workspaceId: string, id: string) =>
    request(workspaceId, `/operations/proposals/${id}/execute`, receiptSchema.nullable(), 'POST'),
};
