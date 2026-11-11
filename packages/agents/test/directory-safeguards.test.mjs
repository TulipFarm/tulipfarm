import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools, leakedWording } from '../src/inference.ts';
import { nativeChatTools } from '../src/native-tools.ts';
import { createMcpCatalog } from '../src/mcp-catalog.ts';
import {
  azureStreamReply,
  isCompletionRequest,
  mcpName,
  nativeReply,
  nativeRoutes,
  selectReply,
} from './native-fixture.mjs';

const verdict = workspaceDirectory =>
  selectReply('azure', {
    status: workspaceDirectory === 'lookup-required' ? 'continue' : 'completed',
    reason: 'Compare the request with completed lookups.',
    workspaceDirectory,
  });
const directory = {
  scope: 'workspace',
  memberCount: 1,
  members: [{ name: 'Sam' }],
  teamCount: 1,
  teams: [{ name: 'Operations', people: [{ name: 'Sam', role: 'manager' }] }],
  truncated: false,
};

for (const failing of [false, true])
  test(`internal wording still forces a rewrite when directory admission ${failing ? 'fails' : 'passes'}`, async t => {
    let replies = 0;
    let checks = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      if (isCompletionRequest(JSON.parse(init.body))) {
        checks++;
        return failing
          ? Response.json({ error: { code: 'invalid_request' } }, { status: 400 })
          : Response.json(verdict('not-applicable'));
      }
      assert.ok(replies < 2, 'the existing wording rewrite is sufficient');
      return azureStreamReply(
        nativeReply('azure', { text: replies++ === 0 ? 'Use rows.list to see your rows.' : 'Open the Tables page.' }),
      );
    });
    const result = await inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'How do I see my tables?' }], () =>
      assert.fail('This answer needs no data lookup'),
    );
    assert.equal(result.text, 'Open the Tables page.');
    assert.equal(replies, 2);
    assert.ok(checks > 0, 'admission adds a check without replacing the wording guard');
  });

test('a failed directory admission cannot accept an action outcome without a completed action', async t => {
  let replies = 0;
  let checks = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (isCompletionRequest(JSON.parse(init.body))) {
      checks++;
      return Response.json({ error: { code: 'invalid_request' } }, { status: 400 });
    }
    assert.ok(replies++ < 4, 'unsupported action claims have bounded recovery');
    return Response.json(nativeReply('azure', { text: 'Done. I scheduled a weekly Monday reminder for Operations.' }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Schedule a reminder for Operations every Monday.' }],
    () => assert.fail('No action completed in this fixture'),
    undefined,
    false,
    null,
    {
      readWorkspaceInventory: async () => ({
        visibility: 'requester-readable',
        complete: true,
        tables: [],
        agents: [],
        workflows: [],
        skills: [],
        directoryNames: { members: [], teams: ['Operations'] },
      }),
    },
  );
  assert.doesNotMatch(result.text, /Done|I scheduled/);
  assert.match(result.text, /stopped before finishing/);
  assert.ok(checks > 0);
});

for (const tool of ['members.find', 'members_find', 'web.search', 'web_search', 'files.read', 'files_read'])
  test(`a leaked ${tool} admits the directory check without inventory`, async t => {
    const calls = [];
    const previews = [];
    let replies = 0;
    let checks = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      if (isCompletionRequest(JSON.parse(init.body))) {
        checks++;
        return Response.json(verdict(calls.length ? 'grounded' : 'lookup-required'));
      }
      assert.ok(replies < 3, 'one lookup and a rewrite suffice');
      return azureStreamReply(
        nativeReply('azure', { text: replies++ ? 'Sam manages Operations.' : `Please call ${tool}.` }),
      );
    });
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: 'Does the Operations group have a manager?' }],
      async call => {
        calls.push(call);
        return directory;
      },
      undefined,
      false,
      null,
      { answerText: update => previews.push(update.text) },
    );
    assert.deepEqual(calls, [{ tool: 'members.find' }]);
    assert.equal(result.text, 'Sam manages Operations.');
    assert.equal(checks, 2);
    assert.ok(previews.every(text => !text.includes(tool)));
  });

test('every offered native chat tool and its dotted name are covered by the wording guard', () => {
  for (const { name } of nativeChatTools(undefined, true, new Set(), true).tools)
    for (const spelling of [name, name.replaceAll('_', '.')])
      assert.equal(
        leakedWording(`Please call ${spelling}.`, 'Help me with this request.')?.status,
        'continue',
        spelling,
      );
});

test('the wording guard also covers tools from the current offered integration catalog', async t => {
  const handle = 'selected-directory-helper';
  const catalog = createMcpCatalog([
    {
      handle,
      name: 'directory_helper',
      description: 'Read directory entries.',
      revision: 'a'.repeat(64),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]).model();
  let replies = 0;
  let checks = 0;
  const previews = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (isCompletionRequest(JSON.parse(init.body))) {
      checks++;
      return Response.json({ error: { code: 'invalid_request' } }, { status: 400 });
    }
    assert.ok(replies < 2);
    return azureStreamReply(
      nativeReply('azure', { text: replies++ ? 'Open the Members page.' : `Please call ${mcpName(handle)}.` }),
    );
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'How do I see workspace settings?' }],
    () => assert.fail('No integration call is needed'),
    undefined,
    false,
    null,
    { catalog: async () => catalog, answerText: update => previews.push(update.text) },
  );
  assert.equal(result.text, 'Open the Members page.');
  assert.equal(replies, 2);
  assert.ok(checks > 0);
  assert.ok(previews.every(text => !text.includes(mcpName(handle))));
});
