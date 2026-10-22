import {
  collaborationDirectorySchema,
  governanceSnapshotSchema,
  governanceSuccessSchema,
  ownMembershipSchema,
} from '@tulipfarm/workspaces/governance-contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, requestSignal, responseError } from './http';

export class GovernanceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function governanceRequest(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1${path}`, { method, signal: requestSignal(signal), body });
  const value = await readJson(response);
  if (!response.ok) {
    const code = responseError(value, 'request-failed');
    throw new GovernanceRequestError(response.status, code);
  }
  return value;
}

export const governancePath = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/governance`;
export async function loadOwnMembership(workspaceId: string, signal: AbortSignal) {
  return ownMembershipSchema.parse(
    await governanceRequest(`${governancePath(workspaceId)}/me`, 'GET', undefined, signal),
  );
}
export async function loadCollaborationDirectory(workspaceId: string, signal: AbortSignal) {
  return collaborationDirectorySchema.parse(
    await governanceRequest(`${governancePath(workspaceId)}/directory`, 'GET', undefined, signal),
  );
}
export async function loadGovernance(workspaceId: string, signal: AbortSignal) {
  return governanceSnapshotSchema.parse(await governanceRequest(governancePath(workspaceId), 'GET', undefined, signal));
}
export async function changeGovernance(workspaceId: string, path: string, method: string, body?: unknown) {
  return governanceSuccessSchema.parse(await governanceRequest(`${governancePath(workspaceId)}${path}`, method, body));
}

export function governanceError(error: unknown) {
  if (error instanceof GovernanceRequestError) {
    if (error.code === 'final-team-manager')
      return 'Appoint another team manager before leaving, removing, or demoting the last manager.';
    if (error.code === 'manager-handoff-required')
      return 'Appoint another manager for the projects, agents, skills, workflows, or integrations you manage before this change.';
    if (error.code === 'team-details-conflict')
      return 'Team details changed since you started editing. Review the current details before saving.';
    if (error.code === 'duplicate-team-name') return 'A team already uses this name. Choose a different name.';
    if (error.code === 'invalid-team-name') return 'Enter a team name of 1 to 80 characters.';
    if (error.code === 'invalid-team-description') return 'Keep the description within 1,000 characters.';
    if (error.code === 'team-owns-agents') return 'This team owns active agents and cannot be deleted.';
    if (error.code === 'invitation-unavailable')
      return 'This invitation is no longer available. The invitation list has been refreshed.';
    if (error.code === 'final-admin')
      return 'Promote another member to admin before leaving, removing, or demoting the last admin.';
    if (error.code === 'team-owns-tables') return 'Transfer this team’s tables to another team before deleting it.';
    if (error.code === 'team-owns-integrations')
      return 'Transfer or delete this team’s active integrations before deleting the team.';
    if (error.code === 'team-id-conflict')
      return 'This team was already created with another name. Refresh the list before trying again.';
    if (error.code === 'team-id-retired')
      return 'This team was deleted. Refresh the list before creating another team.';
    if (error.code === 'teams-unavailable')
      return 'Team creation and deletion are not available in this workspace yet.';
    if (error.code === 'invitations-unavailable') return 'Invitation storage is not available in this workspace yet.';
    if (error.status === 401) return 'Your session expired. Sign in again to continue.';
    if (error.status === 404) return 'This operation is unavailable. Your access may have changed.';
    if (error.status === 400) return 'Check the form values and try again.';
    if (error.status === 429)
      return 'Invitation limit reached. Wait before retrying. Up to 20 invitation requests per hour are allowed.';
  }
  return 'The request could not be confirmed. Check the current state before retrying. Your form values have been kept.';
}
