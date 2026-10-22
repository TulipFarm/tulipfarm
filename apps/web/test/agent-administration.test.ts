import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  destinationErrors,
  enrollmentInput,
  executionInput,
  fixSummary,
  sameAccess,
  sameTeams,
  parseSchedule,
  intervalError,
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

const inspection = (change: object = {}) => ({
  kind: 'inspect' as const,
  cadence: 'interval' as const,
  text: '',
  tableId: customers,
  limits: { toolCalls: '100', credits: '100', activeMilliseconds: '300' },
  activationId: support,
  minutes: { task: '1440', inspect: '60' },
  cronExpression: '0 9 * * 1',
  timezone: 'Europe/London',
  sponsorConsent: true,
  ...change,
});
const prompt = (change: object = {}) => ({
  ...inspection(),
  kind: 'task' as const,
  text: '  Summarize overdue invoices.  ',
  tableId: '',
  ...change,
});

test('inspection schedules require a table, instructions, whole minutes up to one week, and sponsor consent', () => {
  assert.deepEqual(
    parseSchedule(
      inspection({ tableId: '', activationId: '', minutes: { task: '1440', inspect: '' }, sponsorConsent: false }),
      2,
    ),
    {
      errors: {
        resource: 'Choose a table to inspect.',
        activation: 'Choose the instructions to run.',
        cadence: 'Enter whole minutes from 1 to 10,080.',
        sponsor: 'Confirm that you sponsor this schedule.',
      },
      action: null,
      trigger: null,
    },
  );
  assert.equal(
    parseSchedule(inspection({ activationId: '' }), 0).errors.activation,
    'Activate the instructions in Execution first.',
  );
  assert.deepEqual(
    ['0', '1', '1.5', '10080', '10081'].map(
      inspect => parseSchedule(inspection({ minutes: { task: '1440', inspect } }), 1).errors.cadence,
    ),
    [
      'Enter whole minutes from 1 to 10,080.',
      undefined,
      'Enter whole minutes from 1 to 10,080.',
      undefined,
      'Enter whole minutes from 1 to 10,080.',
    ],
  );
  assert.equal(
    fixSummary(parseSchedule(inspection({ minutes: { task: '1440', inspect: '0' } }), 1).errors, 'create the schedule'),
    'Fix 1 field to create the schedule.',
  );
  assert.deepEqual(parseSchedule(inspection(), 1), {
    errors: { resource: undefined, activation: undefined, cadence: undefined, sponsor: undefined },
    action: { kind: 'inspect', tableId: customers },
    trigger: { kind: 'interval', minutes: 60 },
  });
});

test('a changed interval follows the minimum of what the schedule runs', () => {
  assert.deepEqual(
    [0, 1, 59, 60, 1.5, 10080, 10081].map(minutes => intervalError('task', minutes)),
    [
      'Enter whole minutes from 60 to 10,080.',
      'Enter whole minutes from 60 to 10,080.',
      'Enter whole minutes from 60 to 10,080.',
      undefined,
      'Enter whole minutes from 60 to 10,080.',
      undefined,
      'Enter whole minutes from 60 to 10,080.',
    ],
  );
  assert.deepEqual(
    [0, 1, 10080].map(minutes => intervalError('inspect', minutes)),
    ['Enter whole minutes from 1 to 10,080.', undefined, undefined],
  );
});

test('calendar schedules retain a cron expression and time zone', () => {
  assert.deepEqual(
    parseSchedule(inspection({ cadence: 'cron', cronExpression: '0 9 * * 1', timezone: 'Europe/London' }), 1),
    {
      errors: { resource: undefined, activation: undefined, cadence: undefined, sponsor: undefined },
      action: { kind: 'inspect', tableId: customers },
      trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'Europe/London' },
    },
  );
  assert.equal(
    parseSchedule(inspection({ cadence: 'cron', cronExpression: 'not a cron', timezone: 'UTC' }), 1).errors.cadence,
    'Enter a valid cron expression and IANA time zone.',
  );
});

test('prompt schedules require a prompt, an hourly or longer interval, and valid task limits', () => {
  assert.deepEqual(parseSchedule(prompt(), 1), {
    errors: { prompt: undefined, activation: undefined, cadence: undefined, sponsor: undefined },
    action: {
      kind: 'task',
      text: 'Summarize overdue invoices.',
      limits: { toolCalls: 100, credits: 100, activeMilliseconds: 300000 },
    },
    trigger: { kind: 'interval', minutes: 1440 },
  });
  assert.deepEqual(
    parseSchedule(prompt({ text: '   ', minutes: { task: '59', inspect: '60' }, sponsorConsent: false }), 1).errors,
    {
      prompt: 'Write the prompt each run starts with.',
      activation: undefined,
      cadence: 'Enter whole minutes from 60 to 10,080.',
      sponsor: 'Confirm that you sponsor this schedule.',
    },
  );
  assert.deepEqual(
    ['59', '60', '10080', '10081'].map(
      task => parseSchedule(prompt({ minutes: { task, inspect: '1' } }), 1).errors.cadence,
    ),
    ['Enter whole minutes from 60 to 10,080.', undefined, undefined, 'Enter whole minutes from 60 to 10,080.'],
  );
  assert.equal(
    parseSchedule(prompt({ text: 'x'.repeat(8001) }), 1).errors.prompt,
    'Shorten the prompt to 8,000 characters or fewer.',
  );
  const limited = parseSchedule(prompt({ limits: { toolCalls: '0', credits: '100', activeMilliseconds: '3601' } }), 1);
  assert.deepEqual(
    [limited.errors.toolCalls, limited.errors.activeMilliseconds, limited.action],
    ['Use 1 to 1,000 tool calls.', 'Use 1 to 3,600 seconds.', null],
  );
  assert.equal(fixSummary(limited.errors, 'create the schedule'), 'Fix 2 fields to create the schedule.');
});

test('prompt schedules on a calendar must run at least an hour apart', () => {
  const calendar = (cronExpression: string, kind: 'task' | 'inspect' = 'task') =>
    parseSchedule(
      { ...(kind === 'task' ? prompt() : inspection()), cadence: 'cron', cronExpression, timezone: 'Europe/Berlin' },
      1,
    );
  assert.equal(
    calendar('*/5 * * * *').errors.cadence,
    'Prompt schedules run at most once an hour. Choose runs at least an hour apart.',
  );
  assert.equal(calendar('0 9 * * 1').errors.cadence, undefined);
  assert.deepEqual(calendar('0 9 * * 1').trigger, { kind: 'cron', expression: '0 9 * * 1', timezone: 'Europe/Berlin' });
  assert.equal(
    calendar('*/5 * * * *', 'inspect').errors.cadence,
    undefined,
    'inspection schedules may run every few minutes',
  );
  assert.equal(calendar('not cron').errors.cadence, 'Enter a valid cron expression and IANA time zone.');
});
