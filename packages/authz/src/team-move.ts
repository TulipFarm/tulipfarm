import { canonicalHash, type TeamAssetAccessLevel, type TeamAssetType } from "@tulipfarm/schema";
import type { TeamDirectGrant, TeamRoleAssignment } from "./team-authority";
import type { TeamMembershipRecord, TeamRecord } from "./teams";

const MAX_TEAM_DEPTH = 10;

export interface TeamMoveAssetLink {
  readonly assetType: TeamAssetType;
  readonly assetId: string;
  readonly teamId: string;
  readonly relation: "owner" | "share";
  readonly access: TeamAssetAccessLevel;
  readonly revision: number;
}

export interface TeamMoveAssetImpactPort {
  listTeamAssetLinks(
    businessId: string,
    teamIds: readonly string[]
  ): Promise<readonly TeamMoveAssetLink[]>;
}

export interface TeamMoveSnapshot {
  readonly teams: readonly TeamRecord[];
  readonly memberships: readonly TeamMembershipRecord[];
  readonly roles: readonly TeamRoleAssignment[];
  readonly grants: readonly TeamDirectGrant[];
  readonly assets: readonly TeamMoveAssetLink[];
}

interface AuthoritySource {
  readonly sourceTeamId: string;
  readonly id: string;
}

interface AssetSource {
  readonly assetType: TeamAssetType;
  readonly assetId: string;
  readonly sourceTeamId: string;
  readonly relation: "owner" | "share";
  readonly access: TeamAssetAccessLevel;
  readonly revision: number;
}

export interface TeamMoveImpact {
  readonly teamId: string;
  readonly proposedParentTeamId: string;
  readonly teamRevision: number;
  readonly currentAncestorTeamIds: readonly string[];
  readonly proposedAncestorTeamIds: readonly string[];
  readonly gainedAncestorTeamIds: readonly string[];
  readonly lostAncestorTeamIds: readonly string[];
  readonly descendantTeamIds: readonly string[];
  readonly identities: readonly {
    readonly principalId: string;
    readonly principalKind: TeamMembershipRecord["principalKind"];
    readonly directTeamIds: readonly string[];
  }[];
  readonly roles: {
    readonly direct: readonly AuthoritySource[];
    readonly currentInherited: readonly AuthoritySource[];
    readonly proposedInherited: readonly AuthoritySource[];
    readonly gained: readonly AuthoritySource[];
    readonly lost: readonly AuthoritySource[];
  };
  readonly grants: {
    readonly direct: readonly AuthoritySource[];
    readonly currentInherited: readonly AuthoritySource[];
    readonly proposedInherited: readonly AuthoritySource[];
    readonly gained: readonly AuthoritySource[];
    readonly lost: readonly AuthoritySource[];
  };
  readonly assets: {
    readonly owned: readonly AssetSource[];
    readonly directlyShared: readonly AssetSource[];
    readonly currentInherited: readonly AssetSource[];
    readonly proposedInherited: readonly AssetSource[];
    readonly gained: readonly AssetSource[];
    readonly lost: readonly AssetSource[];
  };
  readonly accessChanges: readonly {
    readonly principalId: string;
    readonly gainedRoleIds: readonly string[];
    readonly lostRoleIds: readonly string[];
    readonly gainedGrantIds: readonly string[];
    readonly lostGrantIds: readonly string[];
    readonly gainedAssetIds: readonly string[];
    readonly lostAssetIds: readonly string[];
  }[];
  readonly evidenceDigest: string;
}

function compareSource(left: AuthoritySource, right: AuthoritySource): number {
  return left.sourceTeamId.localeCompare(right.sourceTeamId) || left.id.localeCompare(right.id);
}

function sourceKey(source: AuthoritySource): string {
  return `${source.sourceTeamId}\u0000${source.id}`;
}

function assetKey(source: AssetSource): string {
  return [
    source.assetType,
    source.assetId,
    source.sourceTeamId,
    source.relation,
    source.access,
    source.revision,
  ].join("\u0000");
}

function difference<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): T[] {
  const rightKeys = new Set(right.map(key));
  return left.filter((value) => !rightKeys.has(key(value)));
}

function ancestorIds(team: TeamRecord, teamsById: ReadonlyMap<string, TeamRecord>): string[] {
  const ids: string[] = [];
  let current = team;
  while (current.parentTeamId) {
    if (ids.includes(current.parentTeamId)) {
      throw new Error("Team hierarchy cannot contain a cycle");
    }
    const parent = teamsById.get(current.parentTeamId);
    if (!parent) throw new Error("Team hierarchy has a missing parent");
    ids.push(parent.id);
    current = parent;
  }
  return ids;
}

function descendantIds(teamId: string, teams: readonly TeamRecord[]): string[] {
  const descendants: string[] = [];
  let frontier = [teamId];
  while (frontier.length > 0) {
    const children = teams
      .filter((team) => team.parentTeamId && frontier.includes(team.parentTeamId))
      .map((team) => team.id)
      .sort();
    if (children.some((id) => id === teamId || descendants.includes(id))) {
      throw new Error("Team hierarchy cannot contain a cycle");
    }
    descendants.push(...children);
    frontier = children;
  }
  return descendants;
}

function maxSubtreeDepth(teamId: string, teams: readonly TeamRecord[]): number {
  let maximum = 0;
  let frontier = [teamId];
  while (frontier.length > 0) {
    const children = teams.filter(
      (team) => team.parentTeamId && frontier.includes(team.parentTeamId)
    );
    if (children.length === 0) break;
    maximum += 1;
    frontier = children.map((team) => team.id);
  }
  return maximum;
}

function effectiveTeamIds(
  memberships: readonly TeamMembershipRecord[],
  teamsById: ReadonlyMap<string, TeamRecord>
): Set<string> {
  const result = new Set<string>();
  for (const membership of memberships) {
    const team = teamsById.get(membership.teamId);
    if (!team) continue;
    result.add(team.id);
    for (const ancestorId of ancestorIds(team, teamsById)) result.add(ancestorId);
  }
  return result;
}

function authoritySources(
  records: readonly { readonly teamId: string; readonly roleId?: string; readonly id?: string }[],
  teamIds: ReadonlySet<string>
): AuthoritySource[] {
  return records
    .filter((record) => teamIds.has(record.teamId))
    .map((record) => ({ sourceTeamId: record.teamId, id: record.roleId ?? record.id ?? "" }))
    .sort(compareSource);
}

function assetSources(
  assets: readonly TeamMoveAssetLink[],
  teamIds: ReadonlySet<string>,
  relation?: TeamMoveAssetLink["relation"]
): AssetSource[] {
  return assets
    .filter((asset) => teamIds.has(asset.teamId) && (!relation || asset.relation === relation))
    .map((asset) => ({
      assetType: asset.assetType,
      assetId: asset.assetId,
      sourceTeamId: asset.teamId,
      relation: asset.relation,
      access: asset.access,
      revision: asset.revision,
    }))
    .sort(
      (left, right) =>
        left.assetType.localeCompare(right.assetType) ||
        left.assetId.localeCompare(right.assetId) ||
        left.sourceTeamId.localeCompare(right.sourceTeamId)
    );
}

export function analyzeTeamMove(
  snapshot: TeamMoveSnapshot,
  teamId: string,
  proposedParentTeamId: string,
  now: Date
): TeamMoveImpact {
  const teamsById = new Map(snapshot.teams.map((team) => [team.id, team]));
  const team = teamsById.get(teamId);
  const parent = teamsById.get(proposedParentTeamId);
  if (!team || !parent) throw new Error("Team or parent was not found");
  if (team.status !== "active" || parent.status !== "active") {
    throw new Error("Team and proposed parent must be active");
  }
  if (team.protected) throw new Error("Everyone is protected");

  const descendants = descendantIds(teamId, snapshot.teams);
  if (proposedParentTeamId === teamId || descendants.includes(proposedParentTeamId)) {
    throw new Error("Team hierarchy cannot contain a cycle");
  }
  const currentAncestors = ancestorIds(team, teamsById);
  const proposedAncestors = [parent.id, ...ancestorIds(parent, teamsById)];
  if (proposedAncestors.length + 1 + maxSubtreeDepth(teamId, snapshot.teams) > MAX_TEAM_DEPTH) {
    throw new Error("Team hierarchy cannot exceed 10 levels");
  }

  const subtree = new Set([teamId, ...descendants]);
  const currentAncestorSet = new Set(currentAncestors);
  const proposedAncestorSet = new Set(proposedAncestors);
  const gainedAncestors = proposedAncestors.filter((id) => !currentAncestorSet.has(id));
  const lostAncestors = currentAncestors.filter((id) => !proposedAncestorSet.has(id));
  const activeMemberships = snapshot.memberships.filter(
    (membership) =>
      subtree.has(membership.teamId) && (!membership.expiresAt || membership.expiresAt > now)
  );
  const identitiesById = new Map<
    string,
    {
      principalId: string;
      principalKind: TeamMembershipRecord["principalKind"];
      directTeamIds: string[];
    }
  >();
  for (const membership of activeMemberships) {
    const identity = identitiesById.get(membership.principalId) ?? {
      principalId: membership.principalId,
      principalKind: membership.principalKind,
      directTeamIds: [],
    };
    identity.directTeamIds.push(membership.teamId);
    identitiesById.set(membership.principalId, identity);
  }
  const identities = [...identitiesById.values()]
    .map((identity) => ({ ...identity, directTeamIds: identity.directTeamIds.sort() }))
    .sort((left, right) => left.principalId.localeCompare(right.principalId));

  const directRoles = authoritySources(snapshot.roles, subtree);
  const currentInheritedRoles = authoritySources(snapshot.roles, currentAncestorSet);
  const proposedInheritedRoles = authoritySources(snapshot.roles, proposedAncestorSet);
  const gainedRoles = difference(proposedInheritedRoles, currentInheritedRoles, sourceKey);
  const lostRoles = difference(currentInheritedRoles, proposedInheritedRoles, sourceKey);
  const directGrants = authoritySources(snapshot.grants, subtree);
  const currentInheritedGrants = authoritySources(snapshot.grants, currentAncestorSet);
  const proposedInheritedGrants = authoritySources(snapshot.grants, proposedAncestorSet);
  const gainedGrants = difference(proposedInheritedGrants, currentInheritedGrants, sourceKey);
  const lostGrants = difference(currentInheritedGrants, proposedInheritedGrants, sourceKey);

  const ownedAssets = assetSources(snapshot.assets, subtree, "owner");
  const directlySharedAssets = assetSources(snapshot.assets, subtree, "share");
  const currentInheritedAssets = assetSources(snapshot.assets, currentAncestorSet);
  const proposedInheritedAssets = assetSources(snapshot.assets, proposedAncestorSet);
  const gainedAssets = difference(proposedInheritedAssets, currentInheritedAssets, assetKey);
  const lostAssets = difference(currentInheritedAssets, proposedInheritedAssets, assetKey);
  const proposedTeamsById = new Map(teamsById);
  proposedTeamsById.set(team.id, { ...team, parentTeamId: proposedParentTeamId });
  const accessChanges = identities.map((identity) => {
    const memberships = snapshot.memberships.filter(
      (membership) =>
        membership.principalId === identity.principalId &&
        (!membership.expiresAt || membership.expiresAt > now)
    );
    const currentTeams = effectiveTeamIds(memberships, teamsById);
    const proposedTeams = effectiveTeamIds(memberships, proposedTeamsById);
    const currentRoles = authoritySources(snapshot.roles, currentTeams);
    const proposedRoles = authoritySources(snapshot.roles, proposedTeams);
    const currentGrants = authoritySources(snapshot.grants, currentTeams);
    const proposedGrants = authoritySources(snapshot.grants, proposedTeams);
    const currentAssets = assetSources(snapshot.assets, currentTeams);
    const proposedAssets = assetSources(snapshot.assets, proposedTeams);
    return {
      principalId: identity.principalId,
      gainedRoleIds: [
        ...new Set(difference(proposedRoles, currentRoles, sourceKey).map((source) => source.id)),
      ].sort(),
      lostRoleIds: [
        ...new Set(difference(currentRoles, proposedRoles, sourceKey).map((source) => source.id)),
      ].sort(),
      gainedGrantIds: [
        ...new Set(difference(proposedGrants, currentGrants, sourceKey).map((source) => source.id)),
      ].sort(),
      lostGrantIds: [
        ...new Set(difference(currentGrants, proposedGrants, sourceKey).map((source) => source.id)),
      ].sort(),
      gainedAssetIds: [
        ...new Set(
          difference(proposedAssets, currentAssets, assetKey).map((source) => source.assetId)
        ),
      ].sort(),
      lostAssetIds: [
        ...new Set(
          difference(currentAssets, proposedAssets, assetKey).map((source) => source.assetId)
        ),
      ].sort(),
    };
  });

  const impact = {
    teamId,
    proposedParentTeamId,
    teamRevision: team.revision,
    currentAncestorTeamIds: currentAncestors,
    proposedAncestorTeamIds: proposedAncestors,
    gainedAncestorTeamIds: gainedAncestors,
    lostAncestorTeamIds: lostAncestors,
    descendantTeamIds: descendants,
    identities,
    roles: {
      direct: directRoles,
      currentInherited: currentInheritedRoles,
      proposedInherited: proposedInheritedRoles,
      gained: gainedRoles,
      lost: lostRoles,
    },
    grants: {
      direct: directGrants,
      currentInherited: currentInheritedGrants,
      proposedInherited: proposedInheritedGrants,
      gained: gainedGrants,
      lost: lostGrants,
    },
    assets: {
      owned: ownedAssets,
      directlyShared: directlySharedAssets,
      currentInherited: currentInheritedAssets,
      proposedInherited: proposedInheritedAssets,
      gained: gainedAssets,
      lost: lostAssets,
    },
    accessChanges,
  };
  return { ...impact, evidenceDigest: canonicalHash(impact) };
}
