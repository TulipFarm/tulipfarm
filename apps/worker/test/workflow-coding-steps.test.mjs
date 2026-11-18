import assert from 'node:assert/strict';
import test from 'node:test';
import { openPullRequest, repositoryAccount } from '../src/workflow-coding-steps.ts';

const job = {
  agent: 'claude-code',
  repository: 'octo/app',
  branch: null,
  prompt: '\nFix the login bug\nDetails follow.',
  pullRequest: true,
  title: null,
};

function stubFetch(t, respond) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, token: init.headers.authorization });
    const [status, body] = respond(String(url), init);
    return new Response(JSON.stringify(body), { status });
  };
  t.after(() => (globalThis.fetch = previous));
  return calls;
}

function accounts(list) {
  return {
    list: async () => ({
      accounts: list.map(([id, state, login, useForCoding = true]) => ({
        id,
        state,
        useForCoding,
        identity: login ? { login, id: `${id}-uid` } : null,
      })),
    }),
    memberAccessToken: async (_workspaceId, _membershipId, id) => {
      if (id === 'broken') throw new Error('revoked');
      return `token-${id}`;
    },
  };
}

const member = { membershipId: 'm', userId: 'u' };

test('a coding step uses the first active account that can push, skipping ones that only read', async t => {
  stubFetch(t, (_url, init) =>
    init.headers.authorization === 'Bearer token-reader'
      ? [200, { permissions: { push: false } }]
      : [200, { permissions: { push: true } }],
  );
  const list = accounts([
    ['paused', 'reconnect', 'old'],
    ['broken', 'active', 'gone'],
    ['reader', 'active', 'ada'],
    ['writer', 'active', 'grace'],
  ]);
  assert.deepEqual(await repositoryAccount(list, 'w', member, job), {
    token: 'token-writer',
    login: 'grace',
    id: 'writer-uid',
  });
});

test('a reader is enough only when the step opens no pull request', async t => {
  stubFetch(t, () => [200, { permissions: { push: false } }]);
  const list = accounts([['reader', 'active', 'ada']]);
  assert.equal(await repositoryAccount(list, 'w', member, job), null);
  assert.equal((await repositoryAccount(list, 'w', member, { ...job, pullRequest: false })).login, 'ada');
});

test('a step uses only logins on for coding, and a named login only when it is on for coding', async t => {
  stubFetch(t, () => [200, { permissions: { push: true } }]);
  const list = accounts([
    ['off', 'active', 'ada', false],
    ['first', 'active', 'grace'],
    ['second', 'active', 'linus'],
  ]);
  assert.equal((await repositoryAccount(list, 'w', member, job)).login, 'grace');
  assert.equal((await repositoryAccount(list, 'w', member, { ...job, githubAccount: 'Linus' })).login, 'linus');
  assert.equal((await repositoryAccount(list, 'w', member, { ...job, githubAccount: 'ada' })).login, 'grace');
  assert.equal(await repositoryAccount(accounts([['off', 'active', 'ada', false]]), 'w', member, job), null);
});

test('a pull request is titled from the first non-empty prompt line, and a retry finds the one already open', async t => {
  let opened = false;
  const calls = stubFetch(t, (url, init) => {
    if (init.method === 'POST') return opened ? [422, { message: 'exists' }] : ((opened = true), [201, pull]);
    return [200, [pull]];
  });
  const pull = { number: 7, html_url: 'https://github.com/octo/app/pull/7' };
  const expected = { number: 7, url: pull.html_url };
  assert.deepEqual(await openPullRequest('t', job, 'tulipfarm/claude-code-1', 'main', 'body'), expected);
  assert.deepEqual(JSON.parse(calls[0].body), {
    title: 'Fix the login bug',
    head: 'tulipfarm/claude-code-1',
    base: 'main',
    body: 'body',
  });
  assert.deepEqual(await openPullRequest('t', job, 'tulipfarm/claude-code-1', 'main', 'body'), expected);
  assert.equal(
    calls.at(-1).url,
    'https://api.github.com/repos/octo/app/pulls?state=open&head=octo%3Atulipfarm%2Fclaude-code-1',
  );
});
