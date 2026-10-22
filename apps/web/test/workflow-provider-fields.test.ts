import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerIssues } from '../src/features/workflows/provider-fields.ts';

const ready = { name: 'Ops channel', token: 'xoxb-fixture', consent: true };

test('a complete provider integration has no field issues', () => {
  assert.deepEqual(
    providerIssues({
      ...ready,
      source: { provider: 'slack', teamId: 'T0123456789', channelId: 'C0123456789', conversation: 'public' },
    }),
    {},
  );
});

test('each malformed source value is reported on its own field', () => {
  assert.deepEqual(
    providerIssues({
      ...ready,
      source: { provider: 'slack', teamId: 'acme', channelId: '#ops', conversation: 'public' },
    }),
    {
      teamId: 'Slack workspace IDs start with T followed by capital letters or numbers.',
      channelId: 'Conversation IDs start with C or D followed by capital letters or numbers.',
    },
  );
  assert.deepEqual(
    Object.keys(
      providerIssues({ ...ready, source: { provider: 'jira', cloudId: 'acme.atlassian.net', projectKey: 'ops' } }),
    ),
    ['cloudId', 'projectKey'],
  );
  assert.deepEqual(
    Object.keys(providerIssues({ ...ready, source: { provider: 'hubspot', portalId: 'acme', objectType: 'deals' } })),
    ['portalId'],
  );
});

test('integration basics are reported alongside source values', () => {
  assert.deepEqual(
    Object.keys(
      providerIssues({
        name: ' ',
        token: 'has space',
        consent: false,
        source: { provider: 'forms', formId: 'form/1' },
      }),
    ).sort(),
    ['consent', 'formId', 'name', 'token'],
  );
});
