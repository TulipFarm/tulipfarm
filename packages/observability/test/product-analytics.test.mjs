import assert from 'node:assert/strict';
import test from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { identifyUser, identifyWorkspace, trackEvent } from '../src/index.ts';

async function recorder(t) {
  t.after(resetExtensions);
  const seen = [];
  await registerExtension(
    {
      name: 'analytics-fixture',
      register(slots) {
        slots.analytics({
          capture: event => seen.push(['capture', event]),
          group: group => seen.push(['group', group]),
          person: person => seen.push(['person', person]),
        });
      },
    },
    { app: 'api', env: {} },
  );
  return seen;
}

test('trackEvent sends declared properties with the workspace group, and drops the rest', async t => {
  const seen = await recorder(t);
  trackEvent('task_completed', { workspaceId: 'w1' }, { outcome: 'failed', prompt: 'secret' });
  trackEvent('member_invited', { userId: 'u1', workspaceId: 'w1' }, { resend: true });
  trackEvent('user_signed_up', { userId: 'u2' });
  trackEvent('user_signed_up', {});
  trackEvent('not_an_event', { userId: 'u1' });
  assert.deepEqual(seen, [
    [
      'capture',
      {
        event: 'task_completed',
        distinctId: 'workspace:w1',
        properties: { outcome: 'failed', workspace_id: 'w1' },
        groups: { workspace: 'w1' },
      },
    ],
    [
      'capture',
      {
        event: 'member_invited',
        distinctId: 'u1',
        properties: { resend: true, workspace_id: 'w1' },
        groups: { workspace: 'w1' },
      },
    ],
    ['capture', { event: 'user_signed_up', distinctId: 'u2', properties: {} }],
  ]);
});

test('profiles store the workspace name, slug and creation time, and only the email domain', async t => {
  const seen = await recorder(t);
  identifyWorkspace({ id: 'w1', name: 'Acme', slug: 'acme', createdAt: new Date('2026-01-01T00:00:00Z') });
  identifyUser({ id: 'u1', email: 'Ada@Example.COM' });
  identifyUser({ id: 'u2' });
  assert.deepEqual(seen, [
    [
      'group',
      {
        type: 'workspace',
        key: 'w1',
        properties: { name: 'Acme', slug: 'acme', created_at: '2026-01-01T00:00:00.000Z' },
      },
    ],
    ['person', { distinctId: 'u1', properties: { email_domain: 'example.com' } }],
    ['person', { distinctId: 'u2', properties: {} }],
  ]);
  assert.ok(!JSON.stringify(seen).includes('Ada@'), 'the email address is never stored');
});
