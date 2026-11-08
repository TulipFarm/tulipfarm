import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverTools, parseToolCall } from '../src/tools.ts';
import {
  nextWorkflowRun,
  previewWorkflowRun,
  previewWorkflowRuns,
  workflowDefinitionProblem,
} from '../src/workflow-drafts.ts';

const weekdayReview = {
  version: 1,
  name: 'Review open tickets',
  triggers: [{ id: 'cron', kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York' }],
  steps: [{ id: 'review', kind: 'human', prompt: 'Review open tickets.', timeoutSeconds: 86400 }],
};

test('chat offers workflow tools and saved agents cannot call them', () => {
  const chat = discoverTools({ kind: 'chat' }).map(tool => tool.name);
  for (const name of ['workflows.list', 'workflows.read', 'workflows.providers', 'workflows.draft'])
    assert.ok(chat.includes(name), name);
  const call = { tool: 'workflows.draft', definition: JSON.stringify(weekdayReview), activate: true };
  assert.deepEqual(parseToolCall(call, { kind: 'chat' }), call);
  assert.throws(() => parseToolCall(call, { kind: 'agent', tools: ['workflows.draft'] }));
  assert.throws(() =>
    parseToolCall(
      { tool: 'workflows.draft', workflowId: '11111111-1111-4111-8111-111111111111', activate: true },
      { kind: 'agent', tools: ['workflows.draft'] },
    ),
  );
  assert.deepEqual(discoverTools({ kind: 'agent', tools: ['workflows.list'] }), []);
});

test('weekday 9am New York runs at the next weekday morning in New York time', () => {
  assert.equal(
    nextWorkflowRun(weekdayReview.triggers[0], new Date('2026-10-08T12:00:00Z')),
    '2026-10-08T13:00:00.000Z',
  );
  assert.equal(
    nextWorkflowRun(weekdayReview.triggers[0], new Date('2026-10-09T14:00:00Z')),
    '2026-10-12T13:00:00.000Z',
  );
  assert.equal(
    nextWorkflowRun({ ...weekdayReview.triggers[0] }, new Date('2026-12-04T15:00:00Z')),
    '2026-12-07T14:00:00.000Z',
  );
  assert.equal(nextWorkflowRun({ kind: 'event', name: 'review_requested' }), null);
  assert.equal(
    previewWorkflowRun({ kind: 'once', at: '2026-10-01T00:00:00Z' }, new Date('2026-10-08T12:00:00Z')),
    null,
    'a passed one-time run is never promised',
  );
  assert.equal(
    previewWorkflowRun({ kind: 'once', at: '2026-10-09T00:00:00Z' }, new Date('2026-10-08T12:00:00Z')),
    '2026-10-09T00:00:00.000Z',
  );
});

test('a workflow with several triggers shows its earliest next run', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  assert.equal(
    previewWorkflowRuns(
      [
        weekdayReview.triggers[0],
        { id: 'hourly', kind: 'interval', minutes: 60 },
        { id: 'past', kind: 'once', at: '2026-10-01T00:00:00Z' },
        { id: 'inbound', kind: 'webhook' },
      ],
      now,
    ),
    '2026-10-08T13:00:00.000Z',
  );
  assert.equal(previewWorkflowRuns([{ id: 'inbound', kind: 'webhook' }], now), null);
  assert.equal(previewWorkflowRuns([], now), null);
});

test('drafts reject schedules the scheduler cannot run', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  assert.equal(workflowDefinitionProblem(weekdayReview, now), null);
  assert.equal(
    workflowDefinitionProblem(
      {
        ...weekdayReview,
        triggers: [{ id: 'cron', kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Mars/Olympus' }],
      },
      now,
    )?.error,
    'invalid-schedule',
  );
  assert.equal(
    workflowDefinitionProblem(
      { ...weekdayReview, triggers: [{ id: 'once', kind: 'once', at: '2026-10-01T00:00:00Z' }] },
      now,
    )?.error,
    'schedule-in-past',
  );
  assert.equal(
    workflowDefinitionProblem(
      {
        ...weekdayReview,
        triggers: [...weekdayReview.triggers, { id: 'once', kind: 'once', at: '2026-10-01T00:00:00Z' }],
      },
      now,
    )?.error,
    'schedule-in-past',
    'every trigger is checked, not only the first',
  );
  assert.equal(
    workflowDefinitionProblem(
      {
        ...weekdayReview,
        triggers: [
          {
            id: 'provider',
            kind: 'provider',
            integrationId: '11111111-1111-4111-8111-111111111111',
            event: 'created',
            minutes: 15,
          },
        ],
      },
      now,
    ),
    null,
    'provider drafts use the configured-source authorization check',
  );
  const record = {
    kind: 'record',
    tableId: '22222222-2222-4222-8222-222222222222',
    field: {
      kind: 'date',
      fieldId: '33333333-3333-4333-8333-333333333333',
      offset: { direction: 'before', amount: 1, unit: 'days' },
      time: '09:00',
      timezone: 'America/New_York',
    },
  };
  assert.equal(
    workflowDefinitionProblem({ ...weekdayReview, triggers: [{ id: 'record', ...record }] }, now),
    null,
    'record-date triggers can be drafted; their table and field are checked against the workspace',
  );
  assert.equal(previewWorkflowRun(record, now), null, 'each row sets its own run time');
});

test('drafts reject code steps unless a code runner is configured', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const code = {
    ...weekdayReview,
    steps: [
      { id: 'total', kind: 'code', language: 'python', source: 'return input', input: { kind: 'input', path: [] } },
    ],
  };
  assert.equal(workflowDefinitionProblem(code, now, false)?.error, 'code-steps-unavailable');
  assert.equal(workflowDefinitionProblem(code, now, true), null);
  assert.equal(workflowDefinitionProblem(weekdayReview, now, false), null);
});

test('drafts reject Slack text that comes from HTTP or agent output', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const destinationId = '11111111-1111-4111-8111-111111111111';
  const fetch = { id: 'fetch', kind: 'http', method: 'GET', url: 'https://api.github.com/orgs/example/repos' };
  const slack = text => ({ id: 'notify', kind: 'slack-message', destinationId, text });
  const draft = steps => workflowDefinitionProblem({ ...weekdayReview, steps }, now, true)?.error;
  assert.equal(draft([fetch, slack({ kind: 'step', step: 'fetch', path: ['body'] })]), 'slack-text-source-unsupported');
  assert.equal(
    draft([
      fetch,
      { id: 'shape', kind: 'transform', fields: { text: { kind: 'step', step: 'fetch', path: ['body'] } } },
      slack({ kind: 'step', step: 'shape', path: ['text'] }),
    ]),
    'slack-text-source-unsupported',
  );
  assert.equal(
    draft([
      fetch,
      {
        id: 'format',
        kind: 'code',
        language: 'python',
        source: 'return input',
        input: { kind: 'step', step: 'fetch', path: [] },
      },
      slack({ kind: 'step', step: 'format', path: [] }),
    ]),
    'slack-text-source-unsupported',
  );
  assert.equal(draft([fetch, slack({ kind: 'literal', value: 'Daily check done.' })]), undefined);
});
