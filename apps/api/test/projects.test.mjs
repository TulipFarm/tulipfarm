import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerProjects } from '../src/projects.ts';

test('project files return the parts that could not be read', async t => {
  const app = Fastify();
  const workspaceId = randomUUID(),
    projectId = randomUUID();
  const file = (title, gaps) => ({
    id: randomUUID(),
    title,
    pinned: false,
    revisionId: randomUUID(),
    filename: title,
    bytes: 2048,
    updatedAt: '2026-10-23T09:00:00.000Z',
    source: null,
    gaps,
  });
  const gaps = {
    count: 21,
    items: [
      { kind: 'image', reason: 'recognition-unavailable', label: 'Page image', location: { kind: 'page', page: 1 } },
      { kind: 'object', reason: 'unsupported-media', label: 'Embedded document' },
    ],
  };
  const files = [file('policy.pdf', gaps), file('notes.md', null)];
  registerProjects(app, {
    auth: { api: { getSession: async () => ({ user: { id: 'reader' }, session: { id: 'session' } }) } },
    identity: { query: async () => ({ rows: [] }) },
    service: {
      read: async () => ({
        project: { id: projectId, name: 'Launch', instructions: '', revision: 1, archived: false, manager: false },
        members: [],
        files,
      }),
    },
  });
  t.after(() => app.close());
  const response = await app.inject(`/workspaces/${workspaceId}/projects/${projectId}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().files.map(entry => [entry.title, entry.gaps]),
    [
      ['policy.pdf', gaps],
      ['notes.md', null],
    ],
  );
});
