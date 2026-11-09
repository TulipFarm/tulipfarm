import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Database } from 'reicon-react/icons/Database';
import { Label } from '@tulipfarm/sprout/label';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { tableLabels } from '@/features/governance/table-labels';
import { teamLabel, workspaceAdminsLabel } from '@/features/governance/team-labels';
import { permissionSummary, sortPermissions, type PolicyPermission } from '@/features/access/policies';
import { personName } from './access-members';
import type { AccessPage } from './governance';

type Holder = {
  key: string;
  kind: 'team' | 'member' | 'admin';
  id: string;
  name: string;
  grantedBy: string;
  permissions: PolicyPermission[];
  summary: string;
};

/** A read-only view of who can use each table; every row links to the team or member whose policy grants it. */
export function TableAccess({ page }: { page: AccessPage }) {
  const { data, admin, workspaceSlug, busy } = page;
  const [filter, setFilter] = useState('all');
  const labels = tableLabels(data.tables, [...data.teamNames, ...data.teams], data.adminTeamId);
  const teamName = (id: string) =>
    id === data.adminTeamId
      ? workspaceAdminsLabel
      : teamLabel(
          data.teams.find(team => team.id === id)?.name ??
            data.teamNames.find(team => team.id === id)?.name ??
            'A team you can’t see',
        );
  const people = new Map(data.directory.map(member => [member.id, member]));
  function holders(kind: 'table' | 'collection', id: string) {
    const rows = new Map<string, Holder>();
    const add = (key: string, holder: Omit<Holder, 'permissions' | 'summary'>, permission: PolicyPermission) => {
      const row = rows.get(key) ?? { ...holder, permissions: [], summary: '' };
      row.permissions.push(permission);
      rows.set(key, row);
    };
    for (const grant of data.grants)
      if (grant.target.kind === kind && grant.target.id === id)
        add(
          `team:${grant.teamId}`,
          grant.teamId === data.adminTeamId
            ? { key: 'admin', kind: 'admin', id: grant.teamId, name: workspaceAdminsLabel, grantedBy: 'Admin role' }
            : {
                key: `team:${grant.teamId}`,
                kind: 'team',
                id: grant.teamId,
                name: teamName(grant.teamId),
                grantedBy: 'Team policy',
              },
          grant.target.permission,
        );
    for (const grant of data.personGrants)
      if (grant.target.kind === kind && grant.target.id === id) {
        const member = people.get(grant.membershipId);
        add(
          `member:${grant.membershipId}`,
          {
            key: `member:${grant.membershipId}`,
            kind: 'member',
            id: grant.membershipId,
            name: member ? personName(member) : 'Former member',
            grantedBy: 'Direct policy',
          },
          grant.target.permission,
        );
      }
    return [...rows.values()]
      .map(row => ({
        ...row,
        permissions: sortPermissions(row.permissions),
        summary: permissionSummary(row.permissions),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const holderColumns = [
    {
      key: 'name' as const,
      header: 'Who',
      sort: true,
      cell: (row: Holder) =>
        row.kind === 'team' ? (
          <span className="font-medium underline-offset-4 hover:underline">
            <Link to="/$workspaceSlug/teams/$teamId" params={{ workspaceSlug, teamId: row.id }}>
              {row.name}
            </Link>
          </span>
        ) : row.kind === 'member' ? (
          <span className="font-medium underline-offset-4 hover:underline">
            <Link to="/$workspaceSlug/members/$membershipId" params={{ workspaceSlug, membershipId: row.id }}>
              {row.name}
            </Link>
          </span>
        ) : (
          <span className="font-medium">{row.name}</span>
        ),
    },
    { key: 'summary' as const, header: 'Permissions' },
    { key: 'grantedBy' as const, header: 'Granted by', sort: true },
  ];
  const tables = [...data.tables]
    .sort((a, b) => (labels.get(a.id) ?? a.name).localeCompare(labels.get(b.id) ?? b.name))
    .filter(table => filter === 'all' || table.id === filter);
  const destinations = [...data.teams, ...(data.adminTeamId ? [{ id: data.adminTeamId, name: '_admin' }] : [])]
    .map(team => ({ team, rows: holders('collection', team.id) }))
    .filter(entry => entry.rows.length);
  return (
    <section aria-label="Table access" className="flex flex-col gap-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        {admin
          ? 'To change access, open the team or member and edit their access policies. Admins can use every table.'
          : 'Access that your teams give you. Admins can use every table.'}
      </p>
      {data.tables.length > 0 && (
        <div className="flex max-w-sm flex-col gap-2">
          <Label htmlFor="table-filter">Table</Label>
          <Select value={filter} onValueChange={value => setFilter(value ?? 'all')}>
            <SelectTrigger id="table-filter">
              <SelectValue>{filter === 'all' ? 'All tables' : (labels.get(filter) ?? 'Table')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tables</SelectItem>
              {[...data.tables]
                .sort((a, b) => (labels.get(a.id) ?? a.name).localeCompare(labels.get(b.id) ?? b.name))
                .map(table => (
                  <SelectItem key={table.id} value={table.id}>
                    {labels.get(table.id) ?? table.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {!data.tables.length && (
        <StatePanel
          kind="empty"
          heading="h3"
          icon={Database}
          title="No tables yet"
          description="Once there are tables, you’ll see here who can use each one."
        />
      )}
      {tables.map(table => {
        const name = labels.get(table.id) ?? table.name;
        const rows = holders('table', table.id);
        return (
          <article key={table.id} aria-labelledby={`table-${table.id}`} className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id={`table-${table.id}`} className="text-base font-medium wrap-anywhere">
                {name}
              </h2>
              {admin ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor={`owner-${table.id}`}>Owning team</Label>
                  <Select
                    value={table.owningTeamId}
                    disabled={busy}
                    onValueChange={value => {
                      if (value && value !== table.owningTeamId)
                        void page.change(`/tables/${table.id}/owner`, 'PUT', { teamId: value }).then(result => {
                          if (result === 'saved') page.notify(`${name} is now owned by ${teamName(value)}.`);
                        });
                    }}
                  >
                    <SelectTrigger id={`owner-${table.id}`} size="sm" aria-label={`Owning team for ${name}`}>
                      <SelectValue>{teamName(table.owningTeamId)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {[...(data.adminTeamId ? [{ id: data.adminTeamId }] : []), ...data.teams].map(team => (
                        <SelectItem key={team.id} value={team.id}>
                          {teamName(team.id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Owned by {teamName(table.owningTeamId)}</p>
              )}
            </div>
            {rows.length ? (
              <Table
                aria-label={`Who can use ${name}`}
                narrow="stack"
                data={rows}
                getRowId={row => row.key}
                rowLabel={row => row.name}
                columns={holderColumns}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {admin ? 'Only admins can use this table.' : 'None of your teams has a policy on this table.'}
              </p>
            )}
          </article>
        );
      })}
      {filter === 'all' && destinations.length > 0 && (
        <section aria-labelledby="create-tables-heading" className="flex flex-col gap-3 border-t pt-4">
          <h2 id="create-tables-heading" className="text-base font-medium">
            Who can create tables
          </h2>
          {destinations.map(({ team, rows }) => (
            <Table
              key={team.id}
              aria-label={`Who can create tables owned by ${teamName(team.id)}`}
              caption={`New tables owned by ${teamName(team.id)}`}
              narrow="stack"
              data={rows}
              getRowId={row => row.key}
              rowLabel={row => row.name}
              columns={holderColumns}
            />
          ))}
        </section>
      )}
    </section>
  );
}
