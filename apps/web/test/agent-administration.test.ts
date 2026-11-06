import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  destinationErrors,
  enrollmentInput,
  executionInput,
  fixSummary,
  sameAccess,
  sameTeams,
} from '../src/features/agents/administration.ts';

const engineering = '33333333-3333-4333-8333-333333333333';
const support = '44444444-4444-4444-8444-444444444444';
const customers = '55555555-5555-4555-8555-555555555555';
const orders = '77777777-7777-4777-8777-777777777777';
const saved = {
  version: 4,
  owningTeamId: engineering,
  grants: [],
  enrollment: [engineering],
  enabled: false,
  slackSender: 'user' as const,
  limits: [{ assetId: customers, permissions: ['table.row.read' as const] }],
  taskLimits: { toolCalls: 50, credits: 500, activeMilliseconds: 600000 },
};

test('unsaved access ignores order and rows without permissions', () => {
  const byTeam = (grant: { teamId: string }) => grant.teamId;
  assert.equal(
    sameAccess(
      [{ teamId: engineering, permissions: ['edit', 'read'] }],
      [{ teamId: engineering, permissions: ['read', 'edit'] }],
      byTeam,
    ),
    true,
  );
  assert.equal(sameAccess([{ teamId: engineering, permissions: [] }], [], byTeam), true);
  assert.equal(
    sameAccess([{ teamId: engineering, permissions: ['read'] }], [{ teamId: support, permissions: ['read'] }], byTeam),
    false,
  );
  assert.equal(
    sameAccess(
      [{ teamId: engineering, permissions: ['read'] }],
      [{ teamId: engineering, permissions: ['read', 'invoke'] }],
      byTeam,
    ),
    false,
  );
  assert.equal(sameTeams([support, engineering], [engineering, support]), true);
  assert.equal(sameTeams([engineering], [engineering, support]), false);
});

test('each save sends only its own section', () => {
  assert.deepEqual(enrollmentInput(saved, [engineering, support]), {
    version: 4,
    teamIds: [engineering, support],
    limits: [{ assetId: customers, permissions: ['table.row.read'] }],
    taskLimits: saved.taskLimits,
    enabled: false,
  });
  const draft = {
    enabled: true,
    limits: saved.limits,
    taskLimits: saved.taskLimits,
    slackSender: 'app' as const,
    resource: orders,
    tablePermissions: ['table.row.read' as const, 'table.row.update' as const],
  };
  assert.deepEqual(executionInput(saved, draft), {
    version: 4,
    teamIds: [engineering],
    enabled: true,
    slackSender: 'app',
    limits: [
      { assetId: customers, permissions: ['table.row.read'] },
      { assetId: orders, permissions: ['table.row.read', 'table.row.update'] },
    ],
    taskLimits: saved.taskLimits,
  });
  assert.deepEqual(executionInput(saved, { ...draft, resource: customers }).limits, [
    { assetId: customers, permissions: ['table.row.read', 'table.row.update'] },
  ]);
  assert.deepEqual(executionInput(saved, { ...draft, resource: '' }).limits, [
    { assetId: customers, permissions: ['table.row.read'] },
  ]);
  assert.deepEqual(saved.limits, [{ assetId: customers, permissions: ['table.row.read'] }]);
});

test('Slack destination errors name the fix for each empty or malformed field', () => {
  assert.deepEqual(destinationErrors({ teamId: '', name: '  ', channel: 'general' }), {
    team: 'Choose a team for this channel.',
    name: 'Enter a name for this destination.',
    channel: 'Enter a channel ID that starts with C or G.',
  });
  assert.deepEqual(destinationErrors({ teamId: support, name: 'Sales alerts', channel: 'C0123ABC' }), {
    team: undefined,
    name: undefined,
    channel: undefined,
  });
  assert.equal(destinationErrors({ teamId: support, name: 'Private', channel: 'G42' }).channel, undefined);
  assert.equal(
    fixSummary(destinationErrors({ teamId: '', name: '', channel: '' }), 'add the destination'),
    'Fix 3 fields to add the destination.',
  );
  assert.equal(
    fixSummary(destinationErrors({ teamId: support, name: 'Sales', channel: 'C1' }), 'add the destination'),
    undefined,
  );
});
