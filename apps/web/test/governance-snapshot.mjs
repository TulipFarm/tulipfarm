// Completes a legacy governance mock to the current governanceSnapshotSchema
// (packages/workspaces/src/governance-contracts.ts): `resources` became `tables` (cloud b2392146 #553),
// and the snapshot now carries the member directory, table team ids and per-team manager state.
export function governanceSnapshot({
  resources,
  tables = resources ?? [],
  members = [],
  teams = [],
  directory,
  tableTeamIds = [],
  grants = [],
  ...rest
}) {
  return {
    ...rest,
    members,
    directory: directory ?? members.map(({ id, name, email }) => ({ id, name, email, image: null })),
    teams: teams.map(team => ({ managerIds: [], canManage: false, canLeave: true, ...team })),
    tableTeamIds,
    tables,
    grants,
  };
}
