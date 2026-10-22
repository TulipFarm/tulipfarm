import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { archive, githubDownloadFixture, downloadAnswer } from './github-download-fixture.mjs';

test('model-selected downloads deliver exact bytes through real HTTP and retain owner/account/chat source restrictions', async t => {
  const f = await githubDownloadFixture();
  t.after(() => f.close());
  const app = Fastify();
  t.after(() => app.close());
  const admin = { userId: randomUUID(), membershipId: randomUUID() };
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
    admin.membershipId,
    admin.userId,
  ]);
  let userId = f.member.userId;
  await app.register(
    async routes =>
      registerGitHubAccounts(
        routes,
        { api: { getSession: async () => (userId ? { user: { id: userId }, session: { id: 'fixture' } } : null) } },
        f.service,
        f.reads,
      ),
    { prefix: '/v1' },
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const accountId = await f.connect(),
    second = await f.connect(456);
  for (const kind of ['release.download', 'actions.artifact-download', 'actions.run-logs-download']) {
    const chatId = await f.chat();
    await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
    f.decide(
      [{ tool: 'github.personal.download', operation: { kind, owner: 'octocat', repo: 'private', id: 7 } }],
      downloadAnswer,
    );
    const sent = await f.send(chatId, 'Download my private archive.');
    assert.equal(sent.status, 'completed');
    const sources = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
        sent.turnId,
      ])
    ).rows[0].sources;
    const source = sources.find(item => item.proof?.download);
    assert.equal(source.proof.download.sha256, 'ff9fcdfa5cbd0e50f0fb0cd6ff0fa7d138bbfadc73a92fe7e68b6d949cc28e7c');
    const path = `/v1/workspaces/${f.one.id}/github/chats/${chatId}/downloads/${source.proof.download.id}`;
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), archive);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-disposition'), /^attachment; filename=/);
    assert.equal(JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(path), true);
    userId = admin.userId;
    assert.equal((await fetch(base + path)).status, 404);
    userId = null;
    assert.equal((await fetch(base + path)).status, 401);
    userId = f.member.userId;
    assert.equal((await fetch(base + path.replace(chatId, await f.chat()))).status, 404);
    f.state.expired = true;
    assert.equal((await fetch(base + path)).status, 409);
    assert.equal((await f.service.status(f.one.id, userId, accountId)).state, 'active');
    f.state.expired = false;
    f.state.content = Buffer.from('CHANGED!');
    assert.equal((await fetch(base + path)).status, 404);
    f.state.content = archive;
    assert.deepEqual(Buffer.from(await (await fetch(base + path)).arrayBuffer()), archive);
    f.state.deny = true;
    assert.equal((await fetch(base + path)).status, 404);
    assert.equal(JSON.stringify(await f.store.history(f.one.id, userId, chatId)).includes(path), false);
    const models = f.modelRequests.length;
    f.decide([], 'Must not see this');
    await f.send(chatId, 'Summarize the previous file.');
    assert.equal(f.modelRequests.length, models);
    f.state.deny = false;
    assert.deepEqual(Buffer.from(await (await fetch(base + path)).arrayBuffer()), archive);
    await f.reads.select(f.one.id, userId, chatId, { accountId: second, expectedVersion: 1 });
    assert.equal((await fetch(base + path)).status, 404);
  }
  const model = JSON.stringify(f.modelRequests);
  for (const secret of [
    'synthetic-access-token',
    'private-signed-fixture',
    archive.toString('base64'),
    'release-assets.githubusercontent.com',
    'productionresultssa1.blob.core.windows.net',
  ])
    assert.equal(model.includes(secret), false);
  assert.equal(
    f.state.requests.filter(r => r.path.startsWith('/object')).every(r => r.authorization === undefined),
    true,
  );
  const chatId = await f.chat();
  await f.reads.select(f.one.id, userId, chatId, { accountId, expectedVersion: 0 });
  f.decide(
    [
      {
        tool: 'github.personal.download',
        operation: { kind: 'release.download', owner: 'octocat', repo: 'private', id: 7 },
      },
    ],
    downloadAnswer,
  );
  assert.equal((await f.send(chatId)).status, 'completed');
  const history = JSON.stringify(await f.store.history(f.one.id, userId, chatId));
  const path = history.match(/\/v1\/workspaces\/[a-f0-9-]+\/github\/chats\/[a-f0-9-]+\/downloads\/[a-f0-9-]+/)[0];
  assert.equal((await fetch(base + path)).status, 200);
  await f.service.disconnect(f.one.id, userId, accountId);
  assert.equal((await fetch(base + path)).status, 404);
  const reconnect = await f.service.reconnect(f.one.id, userId, 'test-session', accountId);
  f.setProfile({ id: 123, login: 'person-123' });
  await f.complete({ ...reconnect, state: new URL(reconnect.url).searchParams.get('state') });
  await f.reads.select(f.one.id, userId, chatId, { accountId, expectedVersion: 1 });
  assert.equal((await fetch(base + path)).status, 404);
});
