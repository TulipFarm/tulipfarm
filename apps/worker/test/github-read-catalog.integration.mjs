import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { githubChatFixture } from './github-read-fixture.mjs';

test('composed worker executes new read families over HTTP and rechecks GraphQL and text source access before disclosure', async t => {
  const originalFetch = globalThis.fetch;
  const f = await githubChatFixture();
  t.after(() => f.close());
  let deny = false,
    changed = false;
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path: request.url, method: request.method, body, authorization: request.headers.authorization });
    if (deny) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (request.url === '/graphql') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: {
            target: {
              result: {
                id: 'private-object',
                number: 7,
                owner: { id: 'O_1', login: 'octocat', __typename: 'Organization' },
                title: changed ? 'Changed private title' : 'Private roadmap',
                repository: { id: 'R_42', databaseId: 42, owner: { id: 'U_1' } },
              },
            },
          },
        }),
      );
      return;
    }
    if (
      request.url.endsWith('/logs') ||
      request.headers.accept === 'application/vnd.github.diff' ||
      request.headers.accept === 'application/vnd.github.raw+json'
    ) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(changed ? 'Changed private content' : 'Private build succeeded');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        request.url.includes('/contents/') ? { type: 'file', size: 23 } : { id: 7, name: 'private-asset', size: 100 },
      ),
    );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  f.setProvider((url, init) =>
    originalFetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, init),
  );
  const accountId = await f.connect();
  const cases = [
    { kind: 'project.read', owner: 'octocat', ownerType: 'organization', number: 7 },
    { kind: 'discussion.read', owner: 'octocat', repo: 'private', number: 7 },
    { kind: 'pull.diff', owner: 'octocat', repo: 'private', number: 7 },
    { kind: 'file.content', owner: 'octocat', repo: 'private', path: 'src/main.ts' },
    { kind: 'actions.logs', owner: 'octocat', repo: 'private', id: 7 },
    { kind: 'release.asset', owner: 'octocat', repo: 'private', id: 7 },
  ];
  for (const operation of cases) {
    const chatId = await f.chat();
    await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
    const answer = `Verified private result for ${operation.kind}.`;
    f.decide([{ tool: 'github.personal.read', operation }], answer);
    const sent = await f.send(chatId);
    assert.equal(sent.status, 'completed');
    const result = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
        sent.turnId,
      ])
    ).rows[0];
    const source = result.sources.find(source => source.kind === 'github-personal');
    assert.deepEqual(source.proof.operation, operation);
    assert.equal(source.proof.transport, operation.kind.endsWith('.read') ? 'graphql' : 'rest');
    assert.equal(JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(answer), true);
    assert.equal(
      JSON.stringify(f.modelRequests).includes(
        operation.kind.endsWith('.read')
          ? 'Private roadmap'
          : operation.kind === 'release.asset'
            ? 'private-asset'
            : 'Private build succeeded',
      ),
      true,
    );
    const before = requests.length;
    changed = true;
    assert.equal(JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(answer), true);
    f.decide([], `Follow-up after ${operation.kind} changed.`);
    assert.equal((await f.send(chatId, 'Summarize the prior result.')).status, 'completed');
    changed = false;
    deny = true;
    assert.equal(JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(answer), false);
    const models = f.modelRequests.length;
    f.decide([], 'Must not infer from denied data');
    await f.send(chatId, 'Summarize the prior result.');
    assert.equal(f.modelRequests.length, models);
    assert.ok(requests.length > before);
    deny = false;
    assert.equal(JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(answer), true);
  }
  assert.ok(
    requests.some(request => request.method === 'POST' && request.body.query.includes('organization(login: $owner)')),
  );
  assert.equal(
    requests.every(request => request.authorization.startsWith('Bearer ')),
    true,
  );
  assert.equal(JSON.stringify(f.modelRequests).includes('synthetic-access-token'), false);
});
