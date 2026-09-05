import type {
  Team,
  TeamAccessExplanation,
  TeamAssetAccessLevel,
  TeamAssetType,
  TeamCreateRequest,
  TeamDelegationPolicy,
  TeamHierarchy,
  TeamMembership,
  TeamUpdateRequest,
} from "@tulipfarm/schema";
import { apiDelete, apiGet, apiWrite } from "./api";

export type TeamDirectoryMember = {
  principalId: string;
  name: string;
  level: "member" | "admin";
};

export type TeamDirectoryEntry = Team & {
  members: TeamDirectoryMember[];
};

export type TeamMember = {
  membership: "direct" | "inherited";
  sourceTeamId: string;
  pathTeamIds: string[];
  principalId: string;
  principalKind: "user" | "agent" | "service";
  level: "member" | "admin";
  expiresAt: string | null;
  removable: boolean;
  revision: number;
};

export type TeamMemberInput = {
  principalId: string;
  level: "member" | "admin";
  expiresAt?: string;
};

export type TeamBulkResult = {
  principalId: string;
  ok: boolean;
  membership?: TeamMembership;
  error?: string;
};

export type TeamLeaveRequest = {
  id: string;
  teamId: string;
  principalId: string;
  status: "pending" | "approved" | "rejected";
  revision: number;
  requestedAt: string;
  decidedAt: string | null;
  decidedByPrincipalId: string | null;
};

export type ServiceAccountSummary = {
  id: string;
  clientId: string;
  name: string;
  status: "active" | "disabled";
};

export type TeamRole = {
  source: "direct" | "inherited";
  sourceTeamId: string;
  pathTeamIds: string[];
  roleId: string;
  expiresAt: string | null;
  assignedAt: string;
};

export type TeamGrant = {
  source: "direct" | "inherited";
  sourceTeamId: string;
  pathTeamIds: string[];
  id: string;
  action: string;
  resourceType: string;
  effect: "allow" | "deny";
  domain: string | null;
  recordSelector: string | null;
  fieldSelector: string[] | null;
  dataClass: string | null;
  destination: string | null;
  conditions: Record<string, string> | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TeamGrantInput = {
  action: string;
  resourceType: string;
  effect: "allow" | "deny";
  expiresAt?: string;
};

export type TeamActivityItem = {
  id: string;
  action: string;
  actorId: string | null;
  targetId: string | null;
  summary: string;
  target: string;
  reason: string | null;
  outcome: "succeeded" | "failed";
  emergency: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type OwnershipApproval = {
  approvalId: string;
  operationId: string;
  assetType: "agent" | "skill" | "routine" | "file" | "knowledge";
  assetId: string;
  action: "add_owner" | "remove_owner" | "move" | "archive" | "delete";
  risk: "low" | "medium" | "high";
  preview: string;
  riskSummary: string;
  status: "pending" | "denied";
  requiredTeamIds: string[];
  decisions: number;
  requiredDecisions: number;
  readyToComplete: boolean;
  representedTeamId: string | null;
  canDecide: boolean;
  expiresAt: string;
  createdAt: string;
};

export type OwnershipApprovalPage = {
  items: OwnershipApproval[];
  nextCursor: string | null;
};

export type TeamAssetOwnership = {
  owners: Array<
    | { kind: "team"; teamId: string }
    | { kind: "principal"; principalId: string; principalKind: "user" }
  >;
  shares: Array<{ teamId: string; access: TeamAssetAccessLevel }>;
  revision: number;
};

export type TeamAssetSource = "owned" | "inherited" | "shared";
export type TeamAssetLifecycleStatus = "active" | "archived" | "pending";

export type TeamAssetCatalogItem = {
  assetType: TeamAssetType;
  id: string;
  label: string;
  description: string | null;
  href: string | null;
  lifecycleStatus: TeamAssetLifecycleStatus;
  source: TeamAssetSource;
  sourceTeamIds: string[];
  effectiveLevels: TeamAssetAccessLevel[];
  canManageOwnership: boolean;
  ownership: TeamAssetOwnership | null;
  approvals: OwnershipApproval[];
};

export type TeamAssetSectionCatalog = {
  items: TeamAssetCatalogItem[];
  nextCursor: string | null;
  blockers: string[];
};

export type TeamMovePreview = {
  teamId: string;
  proposedParentTeamId: string;
  teamRevision: number;
  currentAncestorTeamIds: string[];
  proposedAncestorTeamIds: string[];
  gainedAncestorTeamIds: string[];
  lostAncestorTeamIds: string[];
  descendantTeamIds: string[];
  identities: Array<{
    principalId: string;
    principalKind: "user" | "agent" | "service";
    directTeamIds: string[];
  }>;
  roles: {
    gained: Array<{ sourceTeamId: string; id: string }>;
    lost: Array<{ sourceTeamId: string; id: string }>;
  };
  grants: {
    gained: Array<{ sourceTeamId: string; id: string }>;
    lost: Array<{ sourceTeamId: string; id: string }>;
  };
  assets: {
    gained: Array<{ sourceTeamId: string; assetType: string; assetId: string }>;
    lost: Array<{ sourceTeamId: string; assetType: string; assetId: string }>;
  };
  accessChanges: Array<{
    principalId: string;
    gainedRoleIds: string[];
    lostRoleIds: string[];
    gainedGrantIds: string[];
    lostGrantIds: string[];
    gainedAssetIds: string[];
    lostAssetIds: string[];
  }>;
  previewToken: string;
  previewExpiresAt: string;
};

export async function listTeams(): Promise<{ teams: TeamDirectoryEntry[] }> {
  const response = await apiGet<{
    teams: Array<Team & { members?: TeamDirectoryMember[] }>;
  }>("/api/v1/teams");
  return {
    teams: response.teams.map((team) => ({ ...team, members: team.members ?? [] })),
  };
}

export function listTeamHierarchy(): Promise<{ teams: TeamHierarchy[] }> {
  return apiGet<{ teams: TeamHierarchy[] }>("/api/v1/teams/hierarchy");
}

export function getTeam(teamId: string): Promise<Team> {
  return apiGet<Team>(`/api/v1/teams/${encodeURIComponent(teamId)}`);
}

export function createTeam(input: TeamCreateRequest): Promise<Team> {
  return apiWrite<Team>("POST", "/api/v1/teams", input);
}

export function updateTeam(teamId: string, input: TeamUpdateRequest): Promise<Team> {
  return apiWrite<Team>("PATCH", `/api/v1/teams/${encodeURIComponent(teamId)}`, input);
}

export function parseTeamLabels(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((label) => label.trim().toLocaleLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, 12);
}

export function formatTeamLabels(labels: readonly string[] | undefined): string {
  return labels?.join(", ") ?? "";
}

export function getTeamMembers(
  teamId: string
): Promise<{ direct: TeamMember[]; inherited: TeamMember[] }> {
  return apiGet(`/api/v1/teams/${encodeURIComponent(teamId)}/members`);
}

export function addTeamMembers(
  teamId: string,
  members: TeamMemberInput[]
): Promise<{ results: TeamBulkResult[] }> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/members/bulk`, {
    members,
  });
}

export function updateTeamMember(
  teamId: string,
  principalId: string,
  input: { level: "member" | "admin"; expiresAt: string | null; revision: number }
): Promise<TeamMembership> {
  return apiWrite(
    "PATCH",
    `/api/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(principalId)}`,
    input
  );
}

export function removeTeamMember(
  teamId: string,
  principalId: string,
  revision: number
): Promise<{ status: "ok" }> {
  return apiWrite(
    "DELETE",
    `/api/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(principalId)}`,
    { revision }
  );
}

export function removeTeamMembers(
  teamId: string,
  members: Array<{ principalId: string; revision: number }>
): Promise<{ results: TeamBulkResult[] }> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/members/bulk-remove`, {
    members,
  });
}

export function requestTeamLeave(teamId: string): Promise<TeamLeaveRequest> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/leave-requests`, {});
}

export function listTeamLeaveRequests(teamId: string): Promise<{ requests: TeamLeaveRequest[] }> {
  return apiGet(`/api/v1/teams/${encodeURIComponent(teamId)}/leave-requests`);
}

export function decideTeamLeave(
  teamId: string,
  requestId: string,
  decision: "approved" | "rejected",
  revision: number
): Promise<TeamLeaveRequest> {
  return apiWrite(
    "POST",
    `/api/v1/teams/${encodeURIComponent(teamId)}/leave-requests/${encodeURIComponent(requestId)}/decision`,
    { decision, revision }
  );
}

export async function listServiceAccounts(): Promise<ServiceAccountSummary[]> {
  const response = await apiGet<{ clients: ServiceAccountSummary[] }>(
    "/api/v1/identity/api-clients"
  );
  return response.clients;
}

export function getTeamAuthority(teamId: string): Promise<{
  directRoles: TeamRole[];
  inheritedRoles: TeamRole[];
  directGrants: TeamGrant[];
  inheritedGrants: TeamGrant[];
}> {
  return apiGet(`/api/v1/teams/${encodeURIComponent(teamId)}/authority`);
}

export function assignTeamRole(
  teamId: string,
  roleId: string,
  expiresAt?: string
): Promise<{ status: "ok" }> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/roles`, {
    roleId,
    ...(expiresAt ? { expiresAt } : {}),
  });
}

export function revokeTeamRole(teamId: string, roleId: string): Promise<void> {
  return apiDelete(
    `/api/v1/teams/${encodeURIComponent(teamId)}/roles/${encodeURIComponent(roleId)}`
  );
}

export function addTeamGrant(teamId: string, input: TeamGrantInput): Promise<{ id: string }> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/grants`, input);
}

export function deleteTeamGrant(teamId: string, grantId: string): Promise<void> {
  return apiDelete(
    `/api/v1/teams/${encodeURIComponent(teamId)}/grants/${encodeURIComponent(grantId)}`
  );
}

export function getTeamDelegationPolicy(teamId: string): Promise<TeamDelegationPolicy> {
  return apiGet(`/api/v1/teams/${encodeURIComponent(teamId)}/delegation-policy`);
}

export function updateTeamDelegationPolicy(
  teamId: string,
  input: Pick<TeamDelegationPolicy, "allowedRoleIds" | "allowedGrantScopes" | "revision">
): Promise<TeamDelegationPolicy> {
  return apiWrite("PUT", `/api/v1/teams/${encodeURIComponent(teamId)}/delegation-policy`, input);
}

export function explainTeamAccess(
  teamId: string,
  input: {
    principalId: string;
    action: string;
    resourceType: string;
    agentId?: string;
  }
): Promise<TeamAccessExplanation> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/access-explanations`, input);
}

export function getTeamActivity(
  teamId: string,
  limit = 5
): Promise<{ items: TeamActivityItem[]; nextCursor: string | null }> {
  return apiGet(`/api/v1/teams/${encodeURIComponent(teamId)}/activity?limit=${limit}`);
}

export function listOwnershipApprovals(
  teamId?: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<OwnershipApprovalPage> {
  const query = new URLSearchParams();
  if (teamId) query.set("teamId", teamId);
  if (options.cursor) query.set("cursor", options.cursor);
  query.set("limit", String(options.limit ?? 25));
  return apiGet(`/api/v1/team-assets/approvals?${query}`);
}

export function updateTeamAssetShares(
  assetType: TeamAssetType,
  assetId: string,
  shares: Array<{ teamId: string; access: TeamAssetAccessLevel }>,
  revision: number
) {
  return apiWrite<TeamAssetOwnership>(
    "PUT",
    `/api/v1/team-assets/${assetType}/${encodeURIComponent(assetId)}/shares`,
    { shares, revision }
  );
}

export function proposeTeamAssetOperation(
  assetType: TeamAssetType,
  assetId: string,
  input: {
    action: "add_owner" | "remove_owner" | "move" | "archive" | "delete";
    teamId?: string;
    revision: number;
  }
) {
  return apiWrite(
    "POST",
    `/api/v1/team-assets/${assetType}/${encodeURIComponent(assetId)}/operations`,
    {
      ...input,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }
  );
}

export function listTeamAssets(input: {
  teamId: string;
  type?: TeamAssetType;
  source?: TeamAssetSource;
  access?: TeamAssetAccessLevel;
  ownerTeamId?: string;
  lifecycleStatus?: TeamAssetLifecycleStatus;
  cursor?: string;
  limit?: number;
}): Promise<TeamAssetSectionCatalog> {
  const params = new URLSearchParams();
  if (input.type) params.set("type", input.type);
  if (input.source) params.set("source", input.source);
  if (input.access) params.set("access", input.access);
  if (input.ownerTeamId) params.set("ownerTeamId", input.ownerTeamId);
  if (input.lifecycleStatus) params.set("lifecycleStatus", input.lifecycleStatus);
  if (input.cursor) params.set("cursor", input.cursor);
  params.set("limit", String(input.limit ?? 25));
  return apiGet<{
    items: Array<
      Omit<TeamAssetCatalogItem, "assetType" | "approvals"> & {
        type: TeamAssetType;
        pendingApprovals: Array<Omit<OwnershipApproval, "assetType" | "assetId">>;
      }
    >;
    nextCursor: string | null;
  }>(`/api/v1/teams/${encodeURIComponent(input.teamId)}/assets?${params}`).then((response) => ({
    items: response.items.map(({ type, pendingApprovals, ...item }) => ({
      ...item,
      assetType: type,
      approvals: pendingApprovals.map((approval) => ({
        ...approval,
        assetType: type,
        assetId: item.id,
      })),
    })),
    nextCursor: response.nextCursor,
    blockers: [],
  }));
}

export function decideOwnershipApproval(
  approval: OwnershipApproval,
  outcome: "approved" | "denied"
): Promise<{
  completion: { status: "pending" | "ready" | "completed"; readyToComplete: boolean };
  ownership: TeamAssetOwnership | null;
}> {
  if (!approval.representedTeamId) {
    throw new Error("An exact Team admin is required");
  }
  return apiWrite(
    "POST",
    `/api/v1/team-assets/${approval.assetType}/${encodeURIComponent(approval.assetId)}/operations/${approval.operationId}/decisions`,
    { teamId: approval.representedTeamId, outcome }
  );
}

export function completeOwnershipOperation(
  approval: OwnershipApproval
): Promise<TeamAssetOwnership> {
  return apiWrite(
    "POST",
    `/api/v1/team-assets/${approval.assetType}/${encodeURIComponent(approval.assetId)}/operations/${approval.operationId}/complete`,
    {}
  );
}

export function emergencyOverrideOwnershipOperation(
  approval: OwnershipApproval,
  reason: string
): Promise<TeamAssetOwnership> {
  return apiWrite(
    "POST",
    `/api/v1/team-assets/${approval.assetType}/${encodeURIComponent(approval.assetId)}/operations/${approval.operationId}/emergency-override`,
    { reason }
  );
}

export function previewTeamMove(
  teamId: string,
  parentTeamId: string,
  revision: number
): Promise<TeamMovePreview> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/move-preview`, {
    parentTeamId,
    revision,
  });
}

export function confirmTeamMove(
  teamId: string,
  parentTeamId: string,
  previewToken: string
): Promise<Team> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/move`, {
    parentTeamId,
    previewToken,
  });
}

export function archiveTeam(teamId: string, revision: number): Promise<Team> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/archive`, { revision });
}

export function deleteTeam(teamId: string, revision: number): Promise<{ status: "ok" }> {
  return apiWrite("DELETE", `/api/v1/teams/${encodeURIComponent(teamId)}`, { revision });
}

export function recoverTeamAdmin(
  teamId: string,
  principalId: string,
  revision: number
): Promise<TeamMembership> {
  return apiWrite("POST", `/api/v1/teams/${encodeURIComponent(teamId)}/admin-recovery`, {
    principalId,
    revision,
  });
}
