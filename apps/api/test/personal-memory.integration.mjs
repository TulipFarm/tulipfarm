import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { configureKeepPersonalMemory, createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';
import { fakeKeep } from '../../../packages/conversations/test/fake-keep.mjs';
import { registerPersonalMemory } from '../src/personal-memory.ts';
import { authConfig } from '../src/auth.ts';

test(
  'personal memory HTTP only uses the session member, rejects stale edits and enforces origin',
  { timeout: 60000 },
  async t => {
    t.after(configureKeepPersonalMemory({ client: fakeKeep().client }));
    const db = await fixture();
    let runtime, app;
    try {
      const w = await db.create();
      const memberId = randomUUID(),
        memberUser = randomUUID();
      await db.platform.query(
        `INSERT INTO ${qualified(w.names.schema, 'tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`,
        [memberId, memberUser],
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const auth = {
        api: {
          getSession: async ({ headers }) => {
            const id = headers.get('x-test-user');
            return id ? { session: { id: 'current-session' }, user: { id } } : null;
          },
        },
      };
      app = Fastify();
      registerPersonalMemory(app, { auth, service: createPersonalMemoryService(runtime) });
      const url = `/workspaces/${w.id}/personal-memory`;
      const request = (method, payload, user = memberUser, origin = authConfig().webOrigin, extra = {}) =>
        app.inject({
          method,
          url,
          headers: { ...(user ? { 'x-test-user': user } : {}), origin, ...extra },
          ...(payload === undefined ? {} : { payload }),
        });
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await request(
          method,
          method === 'GET' ? undefined : { expectedRevision: 0, ...(method === 'PUT' ? { content: '' } : {}) },
          null,
        );
        assert.equal(response.statusCode, 401);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
      assert.equal((await request('GET', undefined, 'outsider')).statusCode, 404);
      assert.equal(
        (await request('PUT', { content: 'secret', expectedRevision: 0 }, memberUser, 'https://attacker.example'))
          .statusCode,
        403,
      );
      assert.equal((await request('DELETE', { expectedRevision: 0 }, memberUser, '')).statusCode, 403);
      assert.equal(
        (
          await request('GET', undefined, memberUser, authConfig().webOrigin, {
            'x-tulipfarm-expected-session': 'old-session',
          })
        ).statusCode,
        401,
      );
      assert.deepEqual((await request('GET')).json(), {
        content: '',
        revision: 0,
        history: { trashed: false, undo: false },
      });
      for (const payload of [
        { content: 'secret', expectedRevision: 0, membershipId: w.membershipId },
        { content: 'secret', expectedRevision: 0, userId: w.userId },
        { content: 'x'.repeat(10001), expectedRevision: 0 },
        { content: '🌷'.repeat(10001), expectedRevision: 0 },
        { content: '\0', expectedRevision: 0 },
        { content: 'secret', expectedRevision: -1 },
        { content: 'secret' },
      ])
        assert.equal((await request('PUT', payload)).statusCode, 400);
      let response = await request('PUT', { content: 'My explicit preferences', expectedRevision: 0 });
      assert.equal(response.statusCode, 200);
      const saved = response.json();
      assert.equal(saved.content, 'My explicit preferences');
      assert.ok(saved.revision > 0);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal((await request('GET', undefined, w.userId)).json().content, '');
      response = await request('PUT', { content: 'stale', expectedRevision: 0 });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: 'personal_memory_conflict' });
      assert.equal((await request('DELETE', { expectedRevision: 0 })).statusCode, 409);
      assert.equal(
        (await request('DELETE', { expectedRevision: saved.revision, membershipId: memberId })).statusCode,
        400,
      );
      response = await request('DELETE', { expectedRevision: saved.revision });
      assert.equal(response.statusCode, 200);
      const deleted = response.json();
      assert.equal(deleted.content, '');
      assert.equal((await request('GET')).json().content, '');
      assert.equal((await request('PUT', { content: 'resurrect', expectedRevision: saved.revision })).statusCode, 409);
      response = await request('PUT', { content: ' \n ', expectedRevision: deleted.revision });
      assert.equal(response.json().content, '');
      const call = (method, path, payload, user = memberUser, origin = authConfig().webOrigin) =>
        app.inject({
          method,
          url: `${url}${path}`,
          headers: { ...(user ? { 'x-test-user': user } : {}), origin },
          ...(payload === undefined ? {} : { payload }),
        });
      assert.equal((await call('GET', '/files', undefined, null)).statusCode, 401);
      assert.equal((await call('GET', '/files', undefined, 'outsider')).statusCode, 404);
      const listed = (await call('GET', '/files')).json().files;
      assert.deepEqual(
        listed.map(file => [file.path, file.name, file.group]),
        [
          ['/profile.md', 'Preferences', 'you'],
          ['/you/about.md', 'Profile', 'you'],
        ],
      );
      const topic = { path: '/topics/career.md', content: '- Wants a COO role.', expectedRevisionId: null };
      assert.equal((await call('PUT', '/files', topic, memberUser, 'https://attacker.example')).statusCode, 403);
      for (const payload of [
        { ...topic, path: '/notes/career.md' },
        { ...topic, path: '/topics/../profile.md' },
        { ...topic, content: '🌷'.repeat(2049) },
        { ...topic, userId: w.userId },
      ])
        assert.equal((await call('PUT', '/files', payload)).statusCode, 400);
      response = await call('PUT', '/files', { ...topic, name: 'Career', description: 'Goals and growth plans' });
      assert.equal(response.statusCode, 200);
      const career = response.json();
      assert.deepEqual([career.name, career.group, career.content], ['Career', 'topics', '- Wants a COO role.']);
      assert.equal((await call('PUT', '/files', topic)).statusCode, 409, 'creating needs a free path');
      assert.equal(
        (await call('GET', '/files')).json().files.find(file => file.path === '/topics/career.md').content,
        '- Wants a COO role.',
        'the list carries each file’s text',
      );
      assert.equal(
        (await call('GET', `/files/read?path=${encodeURIComponent('/topics/career.md')}`)).json().content,
        '- Wants a COO role.',
      );
      assert.equal(
        (await call('GET', `/files/read?path=${encodeURIComponent('/topics/career.md')}`, undefined, w.userId))
          .statusCode,
        404,
        'another member never reads these files',
      );
      assert.equal(
        (await call('DELETE', '/files', { path: '/topics/career.md', expectedRevisionId: 'stale' })).statusCode,
        409,
      );
      response = await call('DELETE', '/files', { path: '/topics/career.md', expectedRevisionId: career.revisionId });
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.json().files.some(file => file.path === '/topics/career.md'),
        false,
      );
      const instruction = { requestId: randomUUID(), instruction: 'Remember that I prefer metric units.' };
      assert.equal((await call('POST', '/instruct', instruction, null)).statusCode, 401);
      assert.equal((await call('POST', '/instruct', { ...instruction, instruction: ' ' })).statusCode, 400);
      response = await call('POST', '/instruct', instruction);
      assert.equal(response.statusCode, 503, 'without a model the instruction cannot run');
      assert.deepEqual(response.json(), { error: 'personal-memory-unavailable' });
      await db.platform.query(
        `UPDATE ${qualified(w.names.schema, 'tf_memberships')} SET removed_at=now() WHERE id=$1`,
        [memberId],
      );
      assert.equal((await request('GET')).statusCode, 404);
      assert.equal((await request('DELETE', { expectedRevision: deleted.revision })).statusCode, 404);
      assert.equal(
        (await request('PUT', { content: 'no longer a member', expectedRevision: deleted.revision })).statusCode,
        404,
      );
      assert.equal((await call('GET', '/files')).statusCode, 404);
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
