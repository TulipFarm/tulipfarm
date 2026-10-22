import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';
import { budStateSchema } from '@tulipfarm/conversations/bud-contracts';

test('browser workspace fixtures reject invalid and reserved routes before navigation', () => {
  assert.throws(() => createWorkspaceFixture({ slug: 'qa' }), /Invalid workspace URL/);
  assert.throws(() => createWorkspaceFixture({ slug: 'login' }), /Invalid workspace URL/);
  const { workspace, session } = createWorkspaceFixture({
    slug: 'valid-qa',
    userId: 'another-user',
    sessionId: 'another-session',
  });
  assert.equal(workspace.slug, 'valid-qa');
  assert.equal(session.session.userId, 'another-user');
  assert.equal(session.user.id, 'another-user');
  assert.equal(session.session.id, 'another-session');
});

test('workspace shell fixtures keep idle Bud valid and handle only explicit shell events', async () => {
  const { workspace } = createWorkspaceFixture();
  const reads = new Map(workspaceShellReads(workspace.id));
  assert.equal(budStateSchema.parse(reads.get(`/v1/workspaces/${workspace.id}/bud`)).bubblesEnabled, false);
  const responses: unknown[] = [];
  const route = (method: string, path: string) => ({
    request: () => ({ method: () => method, url: () => `http://localhost${path}` }),
    fulfill: async (value: unknown) => {
      responses.push(value);
    },
  });
  assert.equal(
    await serveWorkspaceShellEvent(route('GET', `/v1/workspaces/${workspace.id}/recommendations/events`), workspace),
    true,
  );
  assert.equal(
    await serveWorkspaceShellEvent(route('PUT', `/v1/workspaces/${workspace.slug}/last-used`), workspace),
    true,
  );
  assert.deepEqual(responses, [{ status: 204 }, { status: 204 }]);
  assert.equal(await serveWorkspaceShellEvent(route('POST', '/v1/unexpected'), workspace), false);
  await assert.rejects(
    serveWorkspaceShellEvent(route('POST', `/v1/workspaces/${workspace.id}/recommendations/events`), workspace),
  );
});
