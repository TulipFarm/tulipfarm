import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGitHubCorpusProvider,
  isGitHubDocumentPath,
  serializeGitHubIssue,
  unconfiguredGitHubCorpusProvider,
} from '../src/corpus-provider.ts';
import { GitHubCredentialRejected, GitHubAccountError } from '../src/contracts.ts';
import { GitHubCorpusError, githubCorpusSelectionSchema } from '@tulipfarm/knowledge/github-contracts';
import { fakeGitHub } from './corpus-fixture.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const after = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const selection = { repositories: ['acme/handbook'], kinds: ['discussions', 'docs', 'issues', 'pulls'], after };

function setup({ scopes = ['repo', 'read:user'], generation = 4, discoveryPages } = {}) {
  const github = fakeGitHub();
  const token = github.token(101, 'reader');
  const repo = github.addRepo({
    id: 7001,
    fullName: 'acme/handbook',
    readers: [101],
    description: 'Operating handbook',
    files: {
      'README.md': '# Handbook\n\nOrchid onboarding steps.',
      'docs/supplier.md': 'Supplier orchid contract terms.',
      'src/index.ts': 'export {}',
      'notes/plan.txt': 'Quarterly plan',
      'docs/binary.md': 'bad\0bytes',
      'docs/huge.md': 'x'.repeat(300 * 1024),
    },
    issues: [
      {
        number: 1,
        title: 'Orchid shipment delayed',
        body: 'Shipment details',
        comments: [{ body: 'Confirmed new date', user: 'bob' }],
      },
      { number: 2, title: 'Add supplier page', body: 'PR description', pull: true },
      { number: 3, title: 'Stale', body: 'old', updated_at: github.iso(-400) },
    ],
    discussions: [
      {
        number: 5,
        title: 'Orchid roadmap',
        body: 'Roadmap discussion',
        comments: [{ body: 'Agreed', author: 'carol' }],
      },
    ],
  });
  let rejected = null;
  const accounts = {
    async withReadCredential(actualWorkspace, userId, id, operation, expected) {
      assert.equal(actualWorkspace, workspaceId);
      assert.equal(userId, 'reader');
      assert.equal(id, accountId);
      if (expected !== undefined && expected !== generation) throw new GitHubAccountError('account-reconnect-required');
      try {
        return await operation({
          accessToken: token,
          accountId,
          membershipId: 'm',
          generation,
          identity: { id: '101', login: 'reader' },
          scopes,
        });
      } catch (error) {
        if (error instanceof GitHubCredentialRejected) {
          rejected = error;
          throw new GitHubAccountError('account-reconnect-required');
        }
        throw error;
      }
    },
  };
  const provider = createGitHubCorpusProvider({
    accounts,
    fetcher: discoveryPages
      ? async (input, init) => {
          const url = new URL(input);
          return url.pathname === '/user/repos'
            ? Response.json(discoveryPages[Number(url.searchParams.get('page')) - 1] ?? [])
            : github.fetcher(input, init);
        }
      : github.fetcher,
  });
  const binding = { accountId, accountGeneration: generation, githubUserId: '101', login: 'reader' };
  return { github, repo, provider, binding, token, rejected: () => rejected };
}
async function listAll(provider, binding, repositoryId, value = selection) {
  const observations = [];
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const result = await provider.list(workspaceId, 'reader', binding, repositoryId, value, cursor);
    observations.push(...result.observations);
    if (!result.nextCursor) return observations;
    cursor = result.nextCursor;
  }
  assert.fail('listing did not finish');
}

test('selection contract bounds repositories, kinds and ordering', () => {
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ repositories: ['b/x', 'a/x'], kinds: ['docs'], after }).success,
    false,
  );
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ repositories: ['a/x', 'A/x'], kinds: ['docs'], after }).success,
    false,
  );
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ repositories: ['a/x'], kinds: ['issues', 'docs'], after }).success,
    false,
  );
  assert.equal(
    githubCorpusSelectionSchema.safeParse({
      repositories: Array.from({ length: 21 }, (_, i) => `o/r${String(i).padStart(2, '0')}`),
      kinds: ['docs'],
      after,
    }).success,
    false,
  );
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ repositories: ['../x'], kinds: ['docs'], after }).success,
    false,
  );
  assert.equal(githubCorpusSelectionSchema.safeParse(selection).success, true);
  assert.deepEqual(
    ['README.md', 'docs/a.mdx', 'notes/x.txt', 'LICENSE', 'src/a.ts', 'image.png'].map(isGitHubDocumentPath),
    [true, true, true, true, false, false],
  );
});

test('discovery and selection use the caller own account and resolve stable repository IDs', async () => {
  const { provider, github } = setup();
  github.addRepo({ id: 7002, fullName: 'acme/secret', readers: [999] });
  const found = await provider.discover(workspaceId, 'reader', accountId);
  assert.deepEqual(
    found.items.map(item => [item.repositoryId, item.fullName, item.visibility]),
    [['7001', 'acme/handbook', 'private']],
  );
  assert.deepEqual(found.binding, { accountId, accountGeneration: 4, githubUserId: '101', login: 'reader' });
  const inspected = await provider.inspectSelection(workspaceId, 'reader', accountId, selection);
  assert.deepEqual(inspected.repositories, [
    {
      repositoryId: '7001',
      fullName: 'acme/handbook',
      visibility: 'private',
      title: 'acme/handbook — Operating handbook',
    },
  ]);
  await assert.rejects(
    provider.inspectSelection(workspaceId, 'reader', accountId, { ...selection, repositories: ['acme/secret'] }),
    error => error.code === 'forbidden',
  );
  github.state.renamed.set('acme/old-name', 7001);
  await assert.rejects(
    provider.inspectSelection(workspaceId, 'reader', accountId, { ...selection, repositories: ['acme/old-name'] }),
    error => error.code === 'invalid-selection',
  );
  assert.ok(github.calls.every(call => call.user === 'reader'));
});

test('private repositories need the repo scope', async () => {
  const { provider, binding } = setup({ scopes: ['read:user'] });
  assert.deepEqual((await provider.discover(workspaceId, 'reader', accountId)).items, []);
  await assert.rejects(
    provider.access(workspaceId, 'reader', binding, '7001'),
    error => error.code === 'insufficient-scope',
  );
});

test('discovery continues after a full provider page even when entries are unreadable or invalid', async () => {
  const repository = {
    id: 7002,
    node_id: 'R_test',
    full_name: 'acme/later',
    private: false,
    visibility: 'public',
    default_branch: 'main',
    description: null,
    permissions: { pull: true },
  };
  const discoveryPages = [
    Array.from({ length: 50 }, (_, index) =>
      index % 2 ? { ...repository, id: index + 1, permissions: { pull: false } } : { id: index + 1 },
    ),
    [repository],
  ];
  const { provider } = setup({ discoveryPages });
  const first = await provider.discover(workspaceId, 'reader', accountId);
  assert.deepEqual(first.items, []);
  assert.equal(first.nextCursor, '2');
  const second = await provider.discover(workspaceId, 'reader', accountId, first.nextCursor);
  assert.equal(second.items[0].fullName, 'acme/later');
  assert.equal(second.nextCursor, null);
});

test('listing yields bounded docs, issues, pull requests and discussions with stable provenance', async () => {
  const { provider, binding } = setup();
  const items = await listAll(provider, binding, '7001');
  assert.deepEqual(
    items.map(item => [item.kind, item.nativeId, item.coverage]),
    [
      ['doc', 'doc:7001:README.md', 'supported'],
      ['doc', 'doc:7001:docs/binary.md', 'supported'],
      ['doc', 'doc:7001:docs/huge.md', 'too-large'],
      ['doc', 'doc:7001:docs/supplier.md', 'supported'],
      ['doc', 'doc:7001:notes/plan.txt', 'supported'],
      ['issue', 'issue:7001:1', 'supported'],
      ['pull', 'pull:7001:2', 'supported'],
      ['discussion', 'discussion:7001:5', 'supported'],
    ],
  );
  const doc = items.find(item => item.nativeId === 'doc:7001:docs/supplier.md');
  assert.match(doc.canonicalURL, /^https:\/\/github\.com\/acme\/handbook\/blob\/[a-f0-9]{40}\/docs\/supplier\.md$/);
  assert.match(doc.sourceRevision, /^blob:[a-f0-9]{40}$/);
  const onlyDocs = await listAll(provider, binding, '7001', { ...selection, kinds: ['docs'] });
  assert.ok(onlyDocs.every(item => item.kind === 'doc'));
  const onlyPulls = await listAll(provider, binding, '7001', { ...selection, kinds: ['pulls'] });
  assert.deepEqual(
    onlyPulls.map(item => item.nativeId),
    ['pull:7001:2'],
  );
});

test('reads serialize author and time provenance and map deletions, renames and encodings', async () => {
  const { provider, binding, repo, github } = setup();
  const doc = await provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:docs/supplier.md', selection);
  assert.match(
    doc.markdown,
    /^# acme\/handbook: docs\/supplier\.md\n\nGitHub repository acme\/handbook \(ID 7001\), file `docs\/supplier\.md` at commit [a-f0-9]{40} \(blob [a-f0-9]{40}\)\./,
  );
  assert.match(doc.markdown, /Supplier orchid contract terms\./);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:docs/binary.md', selection),
    error => error.code === 'unsupported',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:docs/huge.md', selection),
    error => error.code === 'too-large',
  );
  repo.files.set('docs/vendors.md', repo.files.get('docs/supplier.md'));
  repo.files.delete('docs/supplier.md');
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:docs/supplier.md', selection),
    error => error.code === 'not-found',
  );
  assert.equal(
    (await provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:docs/vendors.md', selection)).sourceRevision,
    doc.sourceRevision,
    'a rename keeps the blob revision at a new path',
  );
  const issue = await provider.read(workspaceId, 'reader', binding, '7001', 'issue:7001:1', selection);
  assert.match(issue.markdown, /GitHub issue acme\/handbook#1 by @octo, opened \d{4}-\d{2}-\d{2}T/);
  assert.match(issue.markdown, /## Comment by @bob at \d{4}-/);
  const pull = await provider.read(workspaceId, 'reader', binding, '7001', 'pull:7001:2', selection);
  assert.match(pull.markdown, /GitHub pull request acme\/handbook#2/);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'issue:7001:2', selection),
    error => error.code === 'not-found',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'issue:7001:3', selection),
    error => error.code === 'outside-selection',
  );
  repo.issues.get(1).deleted = true;
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'issue:7001:1', selection),
    error => error.code === 'not-found',
  );
  repo.issues.get(1).deleted = false;
  repo.issues.get(1).transferred = true;
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'issue:7001:1', selection),
    error => error.code === 'not-found',
  );
  const discussion = await provider.read(workspaceId, 'reader', binding, '7001', 'discussion:7001:5', selection);
  assert.match(discussion.markdown, /## Comment by @carol at/);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'discussion:7001:9', selection),
    error => error.code === 'not-found',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'doc:7002:README.md', selection),
    error => error.code === 'invalid-selection',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:README.md', { ...selection, kinds: ['issues'] }),
    error => error.code === 'outside-selection',
  );
  assert.ok(github.calls.every(call => call.user === 'reader'));
});

test('access reports the reader own current repository access without throwing for denial', async () => {
  const { provider, binding, repo } = setup();
  const before = Date.now();
  const granted = await provider.access(workspaceId, 'reader', binding, '7001');
  assert.equal(granted.readable, true);
  assert.ok(Date.parse(granted.accessedAt) >= before - 1000);
  repo.readers.delete(101);
  assert.equal((await provider.access(workspaceId, 'reader', binding, '7001')).readable, false);
  await assert.rejects(
    provider.access(workspaceId, 'reader', { ...binding, accountGeneration: 3 }, '7001'),
    error => error.code === 'reconnect-required',
  );
  await assert.rejects(
    provider.access(workspaceId, 'reader', { ...binding, githubUserId: '202' }, '7001'),
    error => error.code === 'stale-integration',
  );
});

test('GitHub corpus failures log exact HTTP status and a fixed endpoint class without private request data', async t => {
  const lines = [];
  t.mock.method(process.stdout, 'write', line => {
    lines.push(JSON.parse(line));
    return true;
  });
  const { provider, binding, github } = setup();
  github.state.failure = () => new Response('PRIVATE PROVIDER BODY', { status: 404 });
  assert.equal((await provider.access(workspaceId, 'reader', binding, '7001')).readable, false);
  const [failure] = lines.filter(line => line.category === 'dependency');
  assert.equal(failure['http.response.status_code'], 404);
  assert.equal(failure['dependency.endpoint'], 'github-repository');
  assert.equal(failure.operation, 'request');
  assert.equal(failure.status_class, '4xx');
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE|7001|acme|handbook|api\.github\.com|authorization/i);
});

test('rate limits carry retry-after and credential rejection invalidates the account', async () => {
  const { provider, binding, github, rejected } = setup();
  github.state.failure = () =>
    new Response('{}', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 90) },
    });
  await assert.rejects(
    provider.list(workspaceId, 'reader', binding, '7001', selection, null),
    error =>
      error instanceof GitHubCorpusError &&
      error.code === 'rate-limited' &&
      error.retryAfterMs > 60000 &&
      error.retryAfterMs <= 91000,
  );
  github.state.failure = () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } });
  await assert.rejects(
    provider.list(workspaceId, 'reader', binding, '7001', selection, null),
    error => error.code === 'rate-limited' && error.retryAfterMs === 7000,
  );
  github.state.failure = () => new Response('{}', { status: 502 });
  await assert.rejects(provider.access(workspaceId, 'reader', binding, '7001'), error => error.code === 'transient');
  github.state.failure = () => Response.json({ message: 'Bad credentials' }, { status: 401 });
  await assert.rejects(
    provider.access(workspaceId, 'reader', binding, '7001'),
    error => error.code === 'reconnect-required',
  );
  assert.ok(rejected());
  github.state.failure = null;
  await assert.rejects(
    provider.list(workspaceId, 'reader', binding, '7001', selection, 'docs:not-a-sha:0'),
    error => error.code === 'invalid-cursor',
  );
  await assert.rejects(
    provider.list(workspaceId, 'reader', binding, '7001', { ...selection, kinds: ['docs'] }, 'issues:1'),
    error => error.code === 'invalid-cursor',
  );
  await assert.rejects(
    unconfiguredGitHubCorpusProvider.access(workspaceId, 'reader', binding, '7001'),
    error => error.code === 'not-configured',
  );
});

test('issue serialization keeps author, time and edit provenance', () => {
  const markdown = serializeGitHubIssue(
    'acme/x',
    {
      number: 4,
      title: 'A\nB',
      body: null,
      user: null,
      state: 'closed',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      comments: 1,
      html_url: 'https://github.com/acme/x/issues/4',
    },
    [
      {
        user: { login: 'dee' },
        body: 'Edited',
        created_at: '2026-01-01T01:00:00Z',
        updated_at: '2026-01-01T02:00:00Z',
      },
    ],
  );
  assert.equal(
    markdown,
    '# acme/x#4: A B\n\nGitHub issue acme/x#4 by a deleted user, opened 2026-01-01T00:00:00.000Z, state closed, last updated 2026-01-02T00:00:00.000Z. 1 comment.\n\n## Description by a deleted user at 2026-01-01T00:00:00.000Z\n\n_No description._\n\n## Comment by @dee at 2026-01-01T01:00:00.000Z (edited 2026-01-01T02:00:00.000Z)\n\nEdited\n',
  );
});

test('code selection indexes default-branch source and lists sensitive, generated and binary files as skipped', async () => {
  const { provider, binding, repo } = setup();
  for (const [path, content] of Object.entries({
    'src/app.py': 'def main():\n    return "```"\n',
    '.env': 'TOKEN=secret',
    'config/id_rsa': 'key',
    'deploy/server.pem': 'pem',
    'node_modules/x/index.js': 'x',
    'dist/bundle.min.js': 'x',
    'pnpm-lock.yaml': 'lock',
    'assets/logo.png': 'png',
    'src/big.ts': 'y'.repeat(300 * 1024),
  }))
    repo.files.set(path, content);
  const code = { ...selection, kinds: ['code'], window: 'rolling-90d' };
  assert.equal(githubCorpusSelectionSchema.safeParse(code).success, true);
  const items = await listAll(provider, binding, '7001', code);
  assert.deepEqual(
    items.map(item => [item.nativeId, item.coverage]),
    [
      ['code:7001:.env', 'excluded'],
      ['code:7001:assets/logo.png', 'excluded'],
      ['code:7001:config/id_rsa', 'excluded'],
      ['code:7001:deploy/server.pem', 'excluded'],
      ['code:7001:dist/bundle.min.js', 'excluded'],
      ['code:7001:node_modules/x/index.js', 'excluded'],
      ['code:7001:pnpm-lock.yaml', 'excluded'],
      ['code:7001:src/app.py', 'supported'],
      ['code:7001:src/big.ts', 'too-large'],
      ['code:7001:src/index.ts', 'supported'],
    ],
  );
  assert.ok(
    items.every(item => item.kind === 'code'),
    'documentation stays in the docs phase',
  );
  const read = await provider.read(workspaceId, 'reader', binding, '7001', 'code:7001:src/app.py', code);
  assert.match(read.markdown, /file `src\/app\.py` at commit [a-f0-9]{40}/);
  assert.match(read.markdown, /\n````\ndef main\(\):\n {4}return "```"\n````\n$/);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'code:7001:.env', code),
    error => error.code === 'outside-selection',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'code:7001:README.md', code),
    error => error.code === 'outside-selection',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'code:7001:src/app.py', { ...code, kinds: ['docs'] }),
    error => error.code === 'outside-selection',
  );
  repo.files.set('src/app.py', 'def main():\n    return 2\n');
  const updated = await provider.read(workspaceId, 'reader', binding, '7001', 'code:7001:src/app.py', code);
  assert.notEqual(updated.sourceRevision, read.sourceRevision, 'a new default-branch head is read at its new blob');
  const both = await listAll(provider, binding, '7001', { ...selection, kinds: ['code', 'docs'] });
  assert.deepEqual([...new Set(both.map(item => item.kind))], ['doc', 'code']);
});

test('code listing bounds indexed files and skipped entries per repository', async () => {
  const { provider, binding, repo } = setup();
  for (let i = 0; i < 1005; i++) repo.files.set(`src/m${String(i).padStart(4, '0')}.ts`, `export const v = ${i};`);
  const items = await listAll(provider, binding, '7001', { ...selection, kinds: ['code'] });
  assert.equal(items.filter(item => item.coverage === 'supported').length, 1000);
  assert.ok(items.filter(item => item.coverage === 'excluded').length >= 6);
});

test('reconciliation reports files a new head pushed beyond the code bound, and nothing when the tree is truncated', async () => {
  const { github, provider, binding, repo } = setup();
  const code = { ...selection, kinds: ['code'] };
  const name = (prefix, i) => `${prefix}/${String(i).padStart(4, '0')}.ts`;
  for (let i = 0; i < 1000; i++) repo.files.set(name('b', i), `export const b = ${i};`);
  const first = await listAll(provider, binding, '7001', code);
  assert.equal(
    first.filter(item => item.coverage === 'supported' && item.nativeId.startsWith('code:7001:b/')).length,
    1000,
  );
  const ids = Array.from({ length: 40 }, (_, i) => `code:7001:${name('b', i * 25)}`);
  assert.deepEqual(
    await provider.displacedCode(workspaceId, 'reader', binding, '7001', code, ids),
    [],
    'nothing is displaced while the files are within the bound',
  );
  for (let i = 0; i < 1000; i++) repo.files.set(name('a', i), `export const a = ${i};`);
  const second = await listAll(provider, binding, '7001', code);
  const listed = new Set(second.map(item => item.nativeId));
  assert.equal(second.filter(item => item.coverage === 'supported').length, 1000);
  assert.ok(
    second.filter(item => item.coverage === 'supported').every(item => item.nativeId.startsWith('code:7001:a/')),
  );
  const unlisted = ids.filter(id => !listed.has(id));
  assert.ok(unlisted.length > 0, 'some displaced files are beyond the listed skip sample');
  assert.deepEqual(
    await provider.displacedCode(workspaceId, 'reader', binding, '7001', code, [
      ...ids,
      'code:7001:a/0001.ts',
      'code:7001:gone.ts',
    ]),
    ids,
    'only existing files beyond the bound are displaced',
  );
  const read = await provider.read(workspaceId, 'reader', binding, '7001', unlisted[0], code);
  assert.equal(
    read.coverage,
    'supported',
    'an exact read alone cannot see the bound, so reconciliation must ask first',
  );
  github.state.truncate = true;
  assert.deepEqual(
    await provider.displacedCode(workspaceId, 'reader', binding, '7001', code, ids),
    [],
    'a truncated tree proves nothing displaced',
  );
  github.state.truncate = false;
  await assert.rejects(
    provider.displacedCode(workspaceId, 'reader', binding, '7001', { ...code, kinds: ['docs'] }, ids),
    error => error.code === 'outside-selection',
  );
  await assert.rejects(
    provider.displacedCode(workspaceId, 'reader', binding, '7001', code, ['doc:7001:README.md']),
    error => error.code === 'invalid-selection',
  );
  await assert.rejects(
    provider.displacedCode(workspaceId, 'reader', binding, '7001', code, ['code:7002:x.ts']),
    error => error.code === 'invalid-selection',
  );
});

test('a truncated repository tree is listed as a visible skip, never as complete coverage', async () => {
  const { github, provider, binding } = setup();
  github.state.truncate = true;
  for (const kinds of [['docs'], ['code']]) {
    const items = await listAll(provider, binding, '7001', { ...selection, kinds });
    const kind = kinds[0] === 'docs' ? 'doc' : 'code';
    const marker = items.find(item => item.nativeId === `${kind}:7001:/truncated-tree`);
    assert.equal(marker?.coverage, 'excluded', `${kind} listing records the omitted files`);
    assert.match(marker.title, /repository tree truncated/);
    assert.equal(
      items.filter(item => item.nativeId.endsWith('/truncated-tree')).length,
      1,
      'the marker is listed once, not on every page',
    );
    await assert.rejects(
      provider.read(workspaceId, 'reader', binding, '7001', marker.nativeId, { ...selection, kinds }),
      error => error.code === 'outside-selection',
      'the marker is never read as content',
    );
  }
  github.state.truncate = false;
  assert.ok(
    (await listAll(provider, binding, '7001', { ...selection, kinds: ['code', 'docs'] })).every(
      item => !item.nativeId.endsWith('/truncated-tree'),
    ),
  );
});
