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

test('a table owned by the admin team reads as Workspace admins even when that team is not listed', () => {
  const labels = tableLabels(
    [
      { id: '33333333-aaaa', name: 'Invoices', owningTeamId: '8a62a927-admin' },
      { id: '55555555-bbbb', name: 'Invoices', owningTeamId: 'team-ops' },
    ],
    [{ id: 'team-ops', name: 'Operations' }],
    '8a62a927-admin',
  );
  assert.equal(labels.get('33333333-aaaa'), 'Invoices · Workspace admins · 33333333');
  assert.equal(labels.get('55555555-bbbb'), 'Invoices · Operations · 55555555');
});
