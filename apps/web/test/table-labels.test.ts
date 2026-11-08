import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tableLabels } from '../src/features/governance/table-labels.ts';

test('tables that share a name read with their owning team and short id', () => {
  const teams = [
    { id: 'team-eng', name: 'Engineering' },
    { id: 'team-admin', name: '_admin' },
  ];
  const labels = tableLabels(
    [
      { id: 'aaaaaaaa-1111', name: 'Pull requests', owningTeamId: 'team-eng' },
      { id: 'bbbbbbbb-2222', name: 'pull requests ', owningTeamId: 'team-admin' },
      { id: 'cccccccc-3333', name: 'Pull Requests', owningTeamId: 'dddddddd-hidden' },
      { id: 'eeeeeeee-4444', name: 'Invoices', owningTeamId: 'team-eng' },
    ],
    teams,
  );
  assert.equal(labels.get('aaaaaaaa-1111'), 'Pull requests · Engineering · aaaaaaaa');
  assert.equal(labels.get('bbbbbbbb-2222'), 'pull requests  · Workspace admins · bbbbbbbb');
  assert.equal(labels.get('cccccccc-3333'), 'Pull Requests · Team dddddddd · cccccccc');
  assert.equal(labels.get('eeeeeeee-4444'), 'Invoices');
});
