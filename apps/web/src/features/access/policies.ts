import type {
  GovernanceSnapshot,
  MemberAccess,
  PolicyPermission,
  PolicyScope,
} from '@tulipfarm/workspaces/governance-contracts';

export type { PolicyPermission, PolicyScope };
export type TablePermission = Exclude<PolicyPermission, 'table.create'>;

export const permissionInfo: Record<PolicyPermission, { label: string; verb: string; description: string }> = {
  'table.row.read': { label: 'Read rows', verb: 'read rows in', description: 'See every row in the table.' },
  'table.row.create': {
    label: 'Create rows',
    verb: 'create rows in',
    description: 'Add rows. Also needs Read rows.',
  },
  'table.row.update': {
    label: 'Update rows',
    verb: 'update rows in',
    description: 'Change existing rows. Also needs Read rows.',
  },
  'table.row.delete': { label: 'Delete rows', verb: 'delete rows in', description: 'Delete rows.' },
  'table.schema.manage': {
    label: 'Manage schema',
    verb: 'manage the schema of',
    description: 'Add, rename and remove fields. Doesn’t include reading rows.',
  },
  'table.create': {
    label: 'Create tables',
    verb: 'create tables owned by',
    description: 'Create new tables owned by the chosen team.',
  },
};

export const permissionGroups: { label: string; permissions: TablePermission[] }[] = [
  { label: 'Rows', permissions: ['table.row.read', 'table.row.create', 'table.row.update', 'table.row.delete'] },
  { label: 'Table', permissions: ['table.schema.manage'] },
];
const tableOrder: TablePermission[] = permissionGroups.flatMap(group => group.permissions);
const order: PolicyPermission[] = ['table.create', ...tableOrder];

export const presets = {
  editor: {
    label: 'Table editor',
    description: 'Read, create, update and delete rows, and manage the schema.',
    permissions: tableOrder,
  },
  reader: { label: 'Table reader', description: 'Read rows only.', permissions: ['table.row.read'] },
  custom: { label: 'Custom', description: 'Choose each permission.', permissions: [] },
} satisfies Record<string, { label: string; description: string; permissions: TablePermission[] }>;
export type Preset = keyof typeof presets;

export function presetOf(permissions: readonly PolicyPermission[]): Preset {
  const set = new Set(permissions);
  for (const key of ['editor', 'reader'] as const) {
    const wanted: readonly PolicyPermission[] = presets[key].permissions;
    if (wanted.length === set.size && wanted.every(permission => set.has(permission))) return key;
  }
  return 'custom';
}

export const sortPermissions = <T extends PolicyPermission>(permissions: readonly T[]) =>
  [...permissions].sort((a, b) => order.indexOf(a) - order.indexOf(b));

export function permissionSummary(permissions: readonly PolicyPermission[]) {
  if (permissions.length === 1 && permissions[0] === 'table.create') return permissionInfo['table.create'].label;
  const preset = presetOf(permissions);
  if (preset !== 'custom') return presets[preset].label;
  return sortPermissions(permissions)
    .map(permission => permissionInfo[permission].label)
    .join(', ');
}

export const joinList = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** Says exactly what one policy save changed, such as "QA Readers can now read rows in Orders." */
export function describeChange(
  subject: string,
  target: string,
  added: readonly PolicyPermission[],
  removed: readonly PolicyPermission[],
) {
  const sentence = (permissions: readonly PolicyPermission[], lead: string) => {
    const verbs = sortPermissions(permissions).map(permission => permissionInfo[permission].verb);
    // "read, create and update rows in Orders" rather than repeating "rows in" for each permission.
    const rows = verbs.every(verb => verb.endsWith(' rows in'));
    const phrase = rows ? `${joinList(verbs.map(verb => verb.replace(/ rows in$/, '')))} rows in` : joinList(verbs);
    return `${subject} ${lead} ${phrase} ${target}.`;
  };
  const parts = [
    added.length ? sentence(added, 'can now') : '',
    removed.length ? sentence(removed, 'can no longer') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : `No change. ${subject} already had this access to ${target}.`;
}

export type PolicyScopeView = { kind: 'all' } | { kind: 'table' | 'collection'; id: string; name: string };
export type PolicyRow = {
  key: string;
  scope: PolicyScopeView;
  permissions: PolicyPermission[];
  source: MemberAccess['policies'][number]['source'];
};

export const scopeKindLabel = (scope: PolicyScopeView) =>
  scope.kind === 'all' ? 'Workspace' : scope.kind === 'table' ? 'Table' : 'Table creation';
export const scopeTarget = (scope: PolicyScopeView) =>
  scope.kind === 'all' ? 'All tables' : scope.kind === 'table' ? scope.name : `New tables owned by ${scope.name}`;
/** The object of a change sentence: "Orders", or "tables owned by Sales". */
export const scopeObject = (scope: PolicyScopeView) =>
  scope.kind === 'all' ? 'every table' : scope.kind === 'table' ? scope.name : scope.name;

export function scopeNames(data: GovernanceSnapshot) {
  const names = new Map<string, string>();
  for (const table of data.tables) names.set(`table:${table.id}`, table.name);
  for (const team of [...data.teamNames, ...data.teams]) names.set(`collection:${team.id}`, team.name);
  return names;
}

const sortRows = (rows: PolicyRow[]) =>
  rows
    .map(row => ({ ...row, permissions: sortPermissions(row.permissions) }))
    .sort(
      (a, b) =>
        (a.scope.kind === 'collection' ? 1 : 0) - (b.scope.kind === 'collection' ? 1 : 0) ||
        scopeTarget(a.scope).localeCompare(scopeTarget(b.scope)),
    );

type Grant = { target: GovernanceSnapshot['grants'][number]['target'] };
function groupGrants(data: GovernanceSnapshot, grants: Grant[], source: PolicyRow['source']) {
  const names = scopeNames(data);
  const rows = new Map<string, PolicyRow>();
  for (const { target } of grants) {
    const key = `${target.kind}:${target.id}`;
    const name = names.get(key);
    if (name === undefined) continue;
    const row = rows.get(key) ?? { key, scope: { kind: target.kind, id: target.id, name }, permissions: [], source };
    row.permissions.push(target.permission);
    rows.set(key, row);
  }
  return sortRows([...rows.values()]);
}

/** One team's grants in the snapshot, grouped into one policy per table or destination team. */
export const teamPolicies = (data: GovernanceSnapshot, teamId: string) =>
  groupGrants(
    data,
    data.grants.filter(grant => grant.teamId === teamId),
    { kind: 'direct' },
  );

/** One person's direct grants in the snapshot (admins only), grouped like team policies. */
export const personPolicies = (data: GovernanceSnapshot, membershipId: string) =>
  groupGrants(
    data,
    data.personGrants.filter(grant => grant.membershipId === membershipId),
    { kind: 'direct' },
  );

export const accessPolicies = (access: MemberAccess): PolicyRow[] =>
  access.policies.map((policy, index) => ({
    key: `${policy.source.kind}:${policy.source.kind === 'team' ? policy.source.teamId : ''}:${policy.scope.kind}:${'id' in policy.scope ? policy.scope.id : index}`,
    scope: policy.scope,
    permissions: sortPermissions(policy.permissions),
    source: policy.source,
  }));

export const sourceLabel = (source: PolicyRow['source']) =>
  source.kind === 'admin' ? 'Admin role' : source.kind === 'team' ? `Team ${source.teamName}` : 'Direct policy';
