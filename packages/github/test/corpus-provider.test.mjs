import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  createGitHubCorpusProvider,
  githubFileKind,
  githubPathIndexable,
  isGitHubBinaryPath,
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

function setup({
  scopes = ['repo', 'read:user'],
  generation = 4,
  discoveryPages,
  extractBinary,
  sleeps = [],
  wrap = f => f,
} = {}) {
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
    ...(extractBinary ? { extractBinary } : {}),
    fetcher: wrap(
      discoveryPages
        ? async (input, init) => {
            const url = new URL(input);
            return url.pathname === '/user/repos'
              ? Response.json(discoveryPages[Number(url.searchParams.get('page')) - 1] ?? [])
              : github.fetcher(input, init);
          }
        : github.fetcher,
    ),
    sleep: async ms => {
      sleeps.push(ms);
    },
    random: () => 1,
  });
  const binding = { accountId, accountGeneration: generation, githubUserId: '101', login: 'reader' };
  return { github, repo, provider, binding, token, rejected: () => rejected };
}
async function listAll(provider, binding, repositoryId, value = selection) {
  const observations = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
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
      repositories: Array.from({ length: 1001 }, (_, i) => `o/r${String(i).padStart(4, '0')}`),
      kinds: ['docs'],
      after,
    }).success,
    false,
  );
  assert.equal(
    githubCorpusSelectionSchema.safeParse({
      repositories: Array.from({ length: 1000 }, (_, i) => `o/r${String(i).padStart(4, '0')}`),
      kinds: ['docs'],
    }).success,
    true,
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
  assert.deepEqual(
    ['README.md', '.env', 'node_modules/x/index.js', 'logo.png'].map(githubFileKind),
    ['doc', 'code', 'code', 'code'],
    'the kind is a label only; every file is one or the other',
  );
  assert.deepEqual(['logo.png', 'docs/manual.PDF', 'a.zip', 'a.ts', 'Makefile'].map(isGitHubBinaryPath), [
    true,
    true,
    true,
    false,
    false,
  ]);
  assert.ok(['.env', 'id_rsa', 'dist/app.min.js', 'pnpm-lock.yaml', 'a.map'].every(githubPathIndexable));
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

test('listing yields every doc, issue, pull request and discussion with stable provenance', async () => {
  const { provider, binding } = setup();
  const items = await listAll(provider, binding, '7001');
  assert.deepEqual(
    items.map(item => [item.kind, item.nativeId, item.coverage]),
    [
      ['doc', 'doc:7001:README.md', 'supported'],
      ['doc', 'doc:7001:docs/binary.md', 'supported'],
      ['doc', 'doc:7001:docs/huge.md', 'supported'],
      ['doc', 'doc:7001:/p/2/docs/huge.md', 'supported'],
      ['doc', 'doc:7001:/p/3/docs/huge.md', 'supported'],
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
  assert.equal(doc.path, 'docs/supplier.md');
  assert.deepEqual(
    items.filter(item => item.path === 'docs/huge.md').map(item => item.title),
    [1, 2, 3].map(part => `acme/handbook: docs/huge.md (part ${part} of 3)`),
  );
  const onlyDocs = await listAll(provider, binding, '7001', { ...selection, kinds: ['docs'] });
  assert.ok(onlyDocs.every(item => item.kind === 'doc'));
  const onlyPulls = await listAll(provider, binding, '7001', { ...selection, kinds: ['pulls'] });
  assert.deepEqual(
    onlyPulls.map(item => item.nativeId),
    ['pull:7001:2'],
  );
});

test('without a cutoff the listing covers full history and asks GitHub for every issue', async () => {
  const { provider, binding, github } = setup();
  const { after: _after, ...full } = selection;
  const items = await listAll(provider, binding, '7001', full);
  assert.deepEqual(
    items.filter(item => item.kind !== 'doc').map(item => item.nativeId),
    ['issue:7001:3', 'issue:7001:1', 'pull:7001:2', 'discussion:7001:5'],
  );
  const issueCalls = github.calls.filter(call => call.path.endsWith('/issues'));
  assert.ok(issueCalls.length > 0);
  assert.ok(issueCalls.every(call => !('since' in call.query)));
  const stale = await provider.read(workspaceId, 'reader', binding, '7001', 'issue:7001:3', full);
  assert.match(stale.markdown, /Stale/);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'issue:7001:3', selection),
    error => error instanceof GitHubCorpusError && error.code === 'outside-selection',
  );
});

test('opt-out path patterns leave matching docs and code out of listing and reading', async () => {
  const { provider, binding, repo } = setup();
  repo.files.set('vendor/lib.ts', 'export const vendored = 1;');
  repo.files.set('src/app.min.js', 'x');
  const opted = { ...selection, kinds: ['code', 'docs'], excludePaths: ['^docs/', '^vendor/', '\\.min\\.js$'] };
  assert.equal(githubCorpusSelectionSchema.safeParse(opted).success, true);
  const items = await listAll(provider, binding, '7001', opted);
  const ids = items.map(item => item.nativeId);
  assert.ok(ids.includes('doc:7001:README.md'));
  assert.ok(ids.includes('code:7001:src/index.ts'));
  for (const id of ['doc:7001:docs/supplier.md', 'code:7001:vendor/lib.ts', 'code:7001:src/app.min.js'])
    assert.ok(!ids.includes(id), id);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:docs/supplier.md', opted),
    error => error instanceof GitHubCorpusError && error.code === 'outside-selection',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'code:7001:vendor/lib.ts', opted),
    error => error instanceof GitHubCorpusError && error.code === 'outside-selection',
  );
  assert.match(
    (await provider.read(workspaceId, 'reader', binding, '7001', 'code:7001:src/index.ts', opted)).markdown,
    /export/,
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
  const binary = await provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:docs/binary.md', selection);
  assert.match(
    binary.markdown,
    /Binary file, 9 bytes, media type application\/octet-stream\. Content extraction pending OCR; only its path and file details are indexed\.\n$/,
    'a file with NUL bytes is indexed as a placeholder, not dropped',
  );
  const huge = [];
  for (const id of ['doc:7001:docs/huge.md', 'doc:7001:/p/2/docs/huge.md', 'doc:7001:/p/3/docs/huge.md'])
    huge.push(await provider.read(workspaceId, 'reader', binding, '7001', id, selection));
  assert.deepEqual(
    huge.map(read => read.markdown.split('\n---\n\n')[1].trimEnd().length),
    [128 * 1024, 128 * 1024, 44 * 1024],
    'a large file is read in parts that together hold every byte',
  );
  assert.match(huge[1].markdown, /^# acme\/handbook: docs\/huge\.md \(part 2 of 3\)\n/);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, '7001', 'doc:7001:/p/4/docs/huge.md', selection),
    error => error.code === 'not-found',
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
  let { provider, binding, github, rejected } = setup();
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
  // The exhausted budget is remembered: the next request pauses without spending a call.
  const spent = github.calls.length;
  github.state.failure = null;
  await assert.rejects(
    provider.access(workspaceId, 'reader', binding, '7001'),
    error => error.code === 'rate-limited' && error.retryAfterMs > 60000,
  );
  assert.equal(github.calls.length, spent);
  ({ provider, binding, github, rejected } = setup());
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

const code = { ...selection, kinds: ['code'] };
const body = read => read.markdown.split('\n---\n\n').slice(1).join('\n---\n\n');
const readAs = (provider, binding, id, value = code, path) =>
  provider.read(workspaceId, 'reader', binding, '7001', id, value, path);

test('code selection indexes every default-branch file, including ones GitHub users chose to commit', async () => {
  const { provider, binding, repo } = setup();
  for (const [path, content] of Object.entries({
    'src/app.py': 'def main():\n    return "```"\n',
    '.env': 'TOKEN=example',
    'config/id_rsa': 'key',
    'deploy/server.pem': 'pem',
    'node_modules/x/index.js': 'x',
    'dist/bundle.min.js': 'x',
    'dist/bundle.js.map': '{}',
    'pnpm-lock.yaml': 'lock',
    'test/__snapshots__/a.snap': 'snap',
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]),
    'src/big.ts': 'y'.repeat(300 * 1024),
  }))
    repo.files.set(path, content);
  assert.equal(githubCorpusSelectionSchema.safeParse(code).success, true);
  assert.equal(githubCorpusSelectionSchema.safeParse({ ...code, window: 'rolling-90d' }).success, false);
  const items = await listAll(provider, binding, '7001', code);
  assert.deepEqual(
    items.map(item => [item.nativeId, item.coverage]),
    [
      ['code:7001:.env', 'supported'],
      ['code:7001:assets/logo.png', 'supported'],
      ['code:7001:config/id_rsa', 'supported'],
      ['code:7001:deploy/server.pem', 'supported'],
      ['code:7001:dist/bundle.js.map', 'supported'],
      ['code:7001:dist/bundle.min.js', 'supported'],
      ['code:7001:node_modules/x/index.js', 'supported'],
      ['code:7001:pnpm-lock.yaml', 'supported'],
      ['code:7001:src/app.py', 'supported'],
      ['code:7001:src/big.ts', 'supported'],
      ['code:7001:/p/2/src/big.ts', 'supported'],
      ['code:7001:/p/3/src/big.ts', 'supported'],
      ['code:7001:src/index.ts', 'supported'],
      ['code:7001:test/__snapshots__/a.snap', 'supported'],
    ],
  );
  const read = await readAs(provider, binding, 'code:7001:src/app.py');
  assert.match(read.markdown, /file `src\/app\.py` at commit [a-f0-9]{40}/);
  assert.match(read.markdown, /\n````\ndef main\(\):\n {4}return "```"\n````\n$/);
  assert.match(body(await readAs(provider, binding, 'code:7001:.env')), /TOKEN=example/);
  assert.match(
    body(await readAs(provider, binding, 'code:7001:assets/logo.png')),
    /^Binary file, 6 bytes, media type image\/png\. Content extraction pending OCR/,
  );
  await assert.rejects(
    readAs(provider, binding, 'code:7001:README.md'),
    error => error.code === 'outside-selection',
    'a file is read only under its own kind',
  );
  await assert.rejects(
    readAs(provider, binding, 'code:7001:src/app.py', { ...code, kinds: ['docs'] }),
    error => error.code === 'outside-selection',
  );
  repo.files.set('src/app.py', 'def main():\n    return 2\n');
  const updated = await readAs(provider, binding, 'code:7001:src/app.py');
  assert.notEqual(updated.sourceRevision, read.sourceRevision, 'a new default-branch head is read at its new blob');
  const both = await listAll(provider, binding, '7001', { ...selection, kinds: ['code', 'docs'] });
  assert.deepEqual([...new Set(both.map(item => item.kind))], ['doc', 'code']);
});

test('listing has no per-repository file count cap and resumes across pages', async () => {
  const { provider, binding, repo } = setup();
  for (let i = 0; i < 2105; i++) repo.files.set(`src/m${String(i).padStart(4, '0')}.ts`, `export const v = ${i};`);
  const items = await listAll(provider, binding, '7001', code);
  assert.equal(items.length, 2106);
  assert.equal(new Set(items.map(item => item.nativeId)).size, 2106);
  assert.ok(items.every(item => item.coverage === 'supported'));
});

test('a truncated recursive tree is walked one directory at a time so every file is listed', async () => {
  const { github, provider, binding, repo } = setup();
  for (let d = 0; d < 60; d++)
    for (let f = 0; f < 3; f++)
      repo.files.set(`pkg/d${String(d).padStart(2, '0')}/f${f}.ts`, `export const v = ${d * 3 + f};`);
  const expected = (await listAll(provider, binding, '7001', { ...selection, kinds: ['code', 'docs'] })).map(
    item => item.nativeId,
  );
  github.state.truncate = true;
  const pages = [];
  let cursor = null;
  do {
    const result = await provider.list(
      workspaceId,
      'reader',
      binding,
      '7001',
      { ...selection, kinds: ['code', 'docs'] },
      cursor,
    );
    pages.push(result);
    cursor = result.nextCursor;
  } while (cursor);
  const walked = pages.flatMap(page => page.observations.map(item => item.nativeId));
  assert.deepEqual(walked.toSorted(), expected.toSorted(), 'the walk lists the same files as the complete tree');
  assert.ok(pages.some(page => /^code:[a-f0-9]{40}:w\d+(?:\.\d+)*(?:\+\d+)?$/.test(page.nextCursor ?? '')));
  assert.ok(
    pages.every(page => page.observations.length <= 100),
    'each page stays within the list page size',
  );
  const huge = walked.filter(id => id.endsWith('docs/huge.md'));
  assert.deepEqual(huge, ['doc:7001:docs/huge.md', 'doc:7001:/p/2/docs/huge.md', 'doc:7001:/p/3/docs/huge.md']);

  github.state.truncateDirs.add('pkg/d07/');
  const partial = await listAll(provider, binding, '7001', code);
  const markers = partial.filter(item => item.coverage === 'excluded');
  assert.equal(markers.length, 1, 'a directory GitHub truncates is a visible skip, listed once');
  assert.match(markers[0].nativeId, /^code:7001:\/truncated\/[a-f0-9]{40}$/);
  assert.match(markers[0].title, /truncated/);
  for (const id of [markers[0].nativeId, 'code:7001:/truncated-tree'])
    await assert.rejects(
      readAs(provider, binding, id),
      error => error.code === 'not-found',
      'markers are never read as content',
    );
  await assert.rejects(
    provider.list(workspaceId, 'reader', binding, '7001', code, `code:${'a'.repeat(40)}:w0.1`),
    error => error.code === 'invalid-cursor',
  );
});

test('a file keeps all its parts on one listing page, and a cursor inside a file still resumes', async () => {
  const { provider, binding, repo } = setup();
  repo.files.set('data/huge.csv', 'r,1\n'.repeat(3400 * 1024));
  for (let i = 0; i < 150; i++) repo.files.set(`src/m${String(i).padStart(3, '0')}.ts`, `export const m${i} = ${i};`);
  const first = await provider.list(workspaceId, 'reader', binding, '7001', code, null);
  const parts = first.observations.filter(item => item.path === 'data/huge.csv');
  assert.equal(parts.length, 107, 'the page grows past its size to finish the file');
  assert.equal(new Set(parts.map(item => item.nativeId)).size, 107);
  assert.equal(parts.at(-1).nativeId, 'code:7001:/p/107/data/huge.csv');
  assert.ok(first.observations.length > 100);
  const [, commit, index] = /^code:([a-f0-9]{40}):(\d+)$/.exec(first.nextCursor);
  assert.ok(Number(index) > 0, 'the page fills between files');
  const items = await listAll(provider, binding, '7001', code);
  assert.equal(items.filter(item => item.path === 'data/huge.csv').length, 107);
  assert.equal(new Set(items.map(item => item.nativeId)).size, items.length, 'no part is listed twice');
  const fileIndex = items
    .filter(item => !item.nativeId.includes('/p/'))
    .findIndex(item => item.path === 'data/huge.csv');
  const resumed = await provider.list(workspaceId, 'reader', binding, '7001', code, `code:${commit}:${fileIndex}+101`);
  assert.deepEqual(
    resumed.observations.filter(item => item.path === 'data/huge.csv').map(item => item.nativeId),
    Array.from({ length: 7 }, (_, i) => `code:7001:/p/${101 + i}/data/huge.csv`),
  );
});

// Wraps blob responses so the test sees how many bytes the provider has pulled from GitHub at any moment.
function countingBlobs() {
  const blobs = { downloads: 0, pulled: 0, cut: Infinity };
  const wrap = fetcher => async (input, init) => {
    const response = await fetcher(input, init);
    if (!new URL(input).pathname.includes('/git/blobs/') || response.status !== 200) return response;
    blobs.downloads++;
    blobs.pulled = 0;
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream(
        {
          async pull(controller) {
            const chunk = await reader.read();
            if (chunk.done || blobs.pulled >= blobs.cut) return controller.close();
            blobs.pulled += chunk.value.byteLength;
            controller.enqueue(chunk.value);
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: response.headers },
    );
  };
  return { blobs, wrap };
}
const readParts = async (provider, binding, id, accept, value = code) => {
  const parts = [];
  await provider.readFile(workspaceId, 'reader', binding, '7001', id, value, null, async part => {
    parts.push(part);
    return accept?.(part, parts);
  });
  return parts;
};

test('a file is read in parts from one blob download, holding about one part at a time', async () => {
  const counted = countingBlobs();
  const { github, provider, binding, repo } = setup({ wrap: counted.wrap });
  const text = Array.from({ length: 300000 }, (_, i) => `row ${i},${'v'.repeat(i % 17)}`).join('\n');
  repo.files.set('data/huge.csv', text);
  github.state.chunk = 4096;
  const ids = (await listAll(provider, binding, '7001', code))
    .filter(item => item.path === 'data/huge.csv')
    .map(item => item.nativeId);
  assert.ok(ids.length > 40);
  github.calls.length = 0;
  const ahead = [];
  const parts = await readParts(provider, binding, ids[0], (_part, seen) => {
    ahead.push(counted.blobs.pulled - seen.length * 128 * 1024);
  });
  assert.equal(github.calls.filter(call => call.path.includes('/git/blobs/')).length, 1, 'one download per file');
  assert.equal(counted.blobs.downloads, 1);
  assert.deepEqual(
    parts.map(part => part.nativeId),
    ids,
  );
  // Each part is handed over as soon as its end is known: no more than the line-break search and a chunk ahead.
  assert.ok(Math.max(...ahead) <= 16 * 1024 + 2 * 4096, `pulled ahead ${Math.max(...ahead)} bytes`);
  const contents = parts.map(part => /\n(`{3,})\n([\s\S]*)\n\1\n$/.exec(part.read.markdown)[2]);
  assert.equal(contents.join('\n'), text, 'parts join back into the file');
  for (const index of [0, 1, 17, ids.length - 1])
    assert.deepEqual(parts[index].read.markdown, (await readAs(provider, binding, ids[index])).markdown);
});

test('a file read can start at a later part and stop early, ending the download', async () => {
  const counted = countingBlobs();
  const { github, provider, binding, repo } = setup({ wrap: counted.wrap });
  repo.files.set('data/huge.csv', 'r,1\n'.repeat(3400 * 1024));
  github.state.chunk = 4096;
  const later = await readParts(provider, binding, 'code:7001:/p/100/data/huge.csv');
  assert.deepEqual(
    later.map(part => part.nativeId),
    Array.from({ length: 8 }, (_, i) => `code:7001:/p/${100 + i}/data/huge.csv`),
  );
  assert.equal(later[0].read.markdown, (await readAs(provider, binding, 'code:7001:/p/100/data/huge.csv')).markdown);
  const early = await readParts(provider, binding, 'code:7001:data/huge.csv', (_part, seen) => seen.length < 3);
  assert.equal(early.length, 3);
  assert.ok(counted.blobs.pulled < 4 * 128 * 1024, 'stopping ends the download');
  await assert.rejects(
    readParts(provider, binding, 'code:7001:/p/108/data/huge.csv'),
    error => error.code === 'not-found',
  );
  counted.blobs.cut = 300 * 1024;
  const cut = [];
  await assert.rejects(
    readParts(provider, binding, 'code:7001:data/huge.csv', part => {
      cut.push(part);
    }),
    error => error.code === 'source-changed',
  );
  assert.equal(cut.length, 2, 'parts read before a short download are kept');
});

test('a file whose content turns out binary yields its placeholder and marks later parts unsupported', async () => {
  const { provider, binding, repo } = setup();
  repo.files.set('data/blob.dat', Buffer.concat([Buffer.from('a\0b'), Buffer.alloc(300 * 1024, 0x61)]));
  const parts = await readParts(provider, binding, 'code:7001:data/blob.dat');
  assert.equal(parts.length, 3);
  assert.match(parts[0].read.markdown, /Binary file, \d+ bytes/);
  assert.deepEqual(
    parts.slice(1).map(part => [part.nativeId, part.error.code]),
    [
      ['code:7001:/p/2/data/blob.dat', 'unsupported'],
      ['code:7001:/p/3/data/blob.dat', 'unsupported'],
    ],
  );
});

test('large files are streamed from the blob API in line-aligned parts that cover every byte once', async () => {
  const { github, provider, binding, repo } = setup();
  const lines = Array.from({ length: 60000 }, (_, i) => `line ${String(i).padStart(5, '0')} é😀`);
  const text = `${lines.join('\n')}\n`;
  repo.files.set('logs/app.log', text);
  assert.ok(Buffer.byteLength(text) > 1024 * 1024, 'over the 1 MB contents API inline limit');
  github.state.chunk = 7777;
  const ids = (await listAll(provider, binding, '7001', code))
    .filter(item => item.path === 'logs/app.log')
    .map(item => item.nativeId);
  const reads = [];
  for (const id of ids) reads.push(await readAs(provider, binding, id));
  const contents = reads.map(read => /\n(`{3,})\n([\s\S]*)\n\1\n$/.exec(read.markdown)[2]);
  assert.equal(contents.join('\n'), text.trimEnd(), 'parts join back into the file without loss or overlap');
  assert.ok(
    contents.every(content => content.startsWith('line ')),
    'parts start at a line',
  );
  assert.ok(github.calls.some(call => /\/git\/blobs\/[a-f0-9]{40}$/.test(call.path)));
});

test('a part boundary without a nearby line break never splits a character', async () => {
  const { provider, binding, repo } = setup();
  repo.files.set('data/one-line.txt', '😀'.repeat(100 * 1024));
  const docs = { ...selection, kinds: ['docs'] };
  const ids = (await listAll(provider, binding, '7001', docs))
    .filter(item => item.path === 'data/one-line.txt')
    .map(item => item.nativeId);
  assert.equal(ids.length, 4);
  let joined = '';
  for (const id of ids) joined += body(await readAs(provider, binding, id, docs)).trimEnd();
  assert.equal(joined, '😀'.repeat(100 * 1024));
});

test('text in UTF-16, UTF-8 with a BOM and Windows-1252 is decoded; NUL bytes mark a binary', async () => {
  const { provider, binding, repo } = setup();
  const utf16be = Buffer.from('Grüße\r\nwelt\n', 'utf16le').swap16();
  repo.files.set('notes/le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße\r\nwelt\n', 'utf16le')]));
  repo.files.set('notes/be.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]));
  repo.files.set('notes/bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Grüße\n')]));
  repo.files.set('notes/latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x01, 0x0a]));
  repo.files.set('notes/nul.txt', Buffer.from('a\0b'));
  repo.files.set('notes/empty.txt', '');
  const docs = { ...selection, kinds: ['docs'] };
  const text = async path => body(await readAs(provider, binding, `doc:7001:${path}`, docs)).trimEnd();
  assert.equal(await text('notes/le.txt'), 'Grüße\nwelt');
  assert.equal(await text('notes/be.txt'), 'Grüße\nwelt');
  assert.equal(await text('notes/bom.txt'), 'Grüße');
  assert.equal(await text('notes/latin.txt'), 'café €\uFFFD');
  assert.match(await text('notes/nul.txt'), /^Binary file, 3 bytes, media type application\/octet-stream\./);
  assert.equal(await text('notes/empty.txt'), '_No text content._');
});

test('a binary extractor hook can supply text for binary files, streamed or inline', async () => {
  const seen = [];
  const { provider, binding, repo } = setup({
    async extractBinary(file) {
      let bytes = 0;
      for await (const chunk of file.content()) bytes += chunk.byteLength;
      seen.push([file.path, file.mediaType, file.size, bytes]);
      return file.path.endsWith('.pdf') ? `Extracted ${bytes} bytes` : null;
    },
  });
  repo.files.set('docs/manual.pdf', Buffer.alloc(2 * 1024 * 1024, 1));
  repo.files.set('img/a.png', Buffer.from([0x89, 0x50, 0, 1]));
  const items = await listAll(provider, binding, '7001', { ...selection, kinds: ['code'] });
  assert.equal(items.filter(item => item.path === 'docs/manual.pdf').length, 1, 'a binary is one item at any size');
  assert.equal(
    body(await readAs(provider, binding, 'code:7001:docs/manual.pdf')).trimEnd(),
    `Extracted ${2 * 1024 * 1024} bytes`,
  );
  assert.match(body(await readAs(provider, binding, 'code:7001:img/a.png')), /pending OCR/);
  assert.deepEqual(seen, [
    ['docs/manual.pdf', 'application/pdf', 2 * 1024 * 1024, 2 * 1024 * 1024],
    ['img/a.png', 'image/png', 4, 4],
  ]);
});

test('paths longer than 1,024 bytes use a hashed native ID and are read by their stored path', async () => {
  const { provider, binding, repo } = setup();
  const path = `${Array.from({ length: 12 }, (_, i) => `directory-${i}-${'n'.repeat(90)}`).join('/')}/file.ts`;
  assert.ok(Buffer.byteLength(path) > 1024);
  repo.files.set(path, 'export const deep = true;');
  const items = await listAll(provider, binding, '7001', code);
  const item = items.find(entry => entry.path === path);
  const hash = createHash('sha256').update(path).digest('hex');
  assert.equal(item.nativeId, `code:7001:/h/${hash}`);
  assert.match(item.canonicalURL, /\/file\.ts$/);
  const read = await readAs(provider, binding, item.nativeId, code, path);
  assert.match(read.markdown, /export const deep = true;/);
  assert.equal(read.nativeId, item.nativeId);
  assert.equal(read.path, path);
  for (const wrong of [undefined, null, `${path}x`, 'src/index.ts'])
    await assert.rejects(
      readAs(provider, binding, item.nativeId, code, wrong),
      error => error.code === 'not-found',
      'a hashed ID is read only with the path that produced it',
    );
});

test('issues and pull requests are indexed with every comment, in parts of 100', async () => {
  const { provider, binding, repo } = setup();
  repo.issues.get(1).comments = Array.from({ length: 650 }, (_, i) => ({ body: `Comment ${i + 1}`, user: 'bob' }));
  const items = await listAll(provider, binding, '7001', { ...selection, kinds: ['issues'] });
  assert.deepEqual(
    items.map(item => item.nativeId),
    ['issue:7001:1', ...[2, 3, 4, 5, 6, 7].map(part => `issue:7001:/p/${part}/1`)],
  );
  const first = await readAs(provider, binding, 'issue:7001:1', selection);
  assert.match(first.markdown, /## Description by @octo/);
  assert.match(first.markdown, /This part holds comments 1–100\./);
  const last = await readAs(provider, binding, 'issue:7001:/p/7/1', selection);
  assert.match(last.title, /\(part 7 of 7\)$/);
  assert.doesNotMatch(last.markdown, /## Description/);
  assert.match(last.markdown, /This part holds comments 601–650\./);
  assert.equal(last.markdown.match(/## Comment by @bob/g).length, 50);
  assert.match(last.markdown, /Comment 650\n$/);
  await assert.rejects(readAs(provider, binding, 'issue:7001:/p/8/1', selection), error => error.code === 'not-found');
});

test('discussions are indexed with every comment and reply, paged by cursor', async () => {
  const { github, provider, binding, repo } = setup();
  repo.discussions.get(5).comments = Array.from({ length: 150 }, (_, i) => ({
    body: `Comment ${i + 1}`,
    author: 'carol',
    replies: i === 120 ? Array.from({ length: 230 }, (_, r) => ({ body: `Reply ${r + 1}`, author: 'dan' })) : [],
  }));
  const items = await listAll(provider, binding, '7001', { ...selection, kinds: ['discussions'] });
  assert.deepEqual(
    items.map(item => item.nativeId),
    ['discussion:7001:5', 'discussion:7001:/p/2/5'],
  );
  const first = await readAs(provider, binding, 'discussion:7001:5', selection);
  assert.equal(first.markdown.match(/## Comment by @carol/g).length, 100);
  assert.match(first.markdown, /## Discussion by @octo/);
  const second = await readAs(provider, binding, 'discussion:7001:/p/2/5', selection);
  assert.equal(second.markdown.match(/## Comment by @carol/g).length, 50);
  assert.equal(second.markdown.match(/### Reply by @dan/g).length, 230);
  assert.match(second.markdown, /Comment 101\n[\s\S]*Reply 230\n[\s\S]*Comment 150\n$/);
  assert.doesNotMatch(second.markdown, /## Discussion by/);
  assert.equal(github.calls.filter(call => call.graph?.id?.startsWith('DC_')).length, 2, 'replies paged by cursor');
  await assert.rejects(
    readAs(provider, binding, 'discussion:7001:/p/3/5', selection),
    error => error.code === 'not-found',
  );
});

test('an empty repository still indexes issues and discussions, then its files once commits exist', async () => {
  const { provider, binding, repo } = setup();
  const files = new Map(repo.files);
  repo.files.clear();
  const all = { ...selection, kinds: ['code', 'discussions', 'docs', 'issues', 'pulls'] };
  const empty = await listAll(provider, binding, '7001', all);
  assert.deepEqual(
    empty.map(item => item.nativeId),
    ['issue:7001:1', 'pull:7001:2', 'discussion:7001:5'],
  );
  await assert.rejects(readAs(provider, binding, 'doc:7001:README.md', all), error => error.code === 'not-found');
  for (const [path, content] of files) repo.files.set(path, content);
  const later = await listAll(provider, binding, '7001', all);
  assert.ok(later.some(item => item.nativeId === 'doc:7001:README.md'));
  assert.ok(later.some(item => item.nativeId === 'code:7001:src/index.ts'));
  assert.match((await readAs(provider, binding, 'doc:7001:README.md', all)).markdown, /Orchid onboarding steps/);
});

const commitsOnly = { ...selection, kinds: ['commits'] };
async function listPages(provider, binding, value, history) {
  const pages = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const result = await provider.list(workspaceId, 'reader', binding, '7001', value, cursor, history);
    pages.push(result);
    if (!result.nextCursor) return pages;
    cursor = result.nextCursor;
  }
  assert.fail('listing did not finish');
}

test('commits are listed last, through the whole default-branch history in pages of 100', async () => {
  const { provider, binding, repo, github } = setup();
  for (let index = 0; index < 205; index++) github.push(repo, { message: `Change ${index}` });
  const head = repo.history.at(-1).sha;
  const all = { ...selection, kinds: ['commits', 'discussions', 'docs', 'issues', 'pulls'] };
  const pages = await listPages(provider, binding, all, { commitHead: null });
  const items = pages.flatMap(page => page.observations);
  assert.deepEqual(
    items.slice(-205).map(item => item.nativeId),
    [...repo.history].reverse().map(item => `commit:7001:${item.sha}`),
  );
  assert.ok(items.slice(0, -205).every(item => item.kind !== 'commit'));
  assert.deepEqual(pages.at(-1).commits, { head, retained: false });
  assert.ok(pages.slice(0, -1).every(page => !page.commits));
  const listed = github.calls.filter(call => call.path === '/repositories/7001/commits');
  assert.deepEqual(
    listed.map(call => [call.query.sha, call.query.per_page, call.query.page]),
    [1, 2, 3].map(page => [head, '100', String(page)]),
  );
  const newest = items.at(-205);
  assert.equal(newest.title, `acme/handbook@${head.slice(0, 7)}: Change 204`);
  assert.equal(newest.canonicalURL, `https://github.com/acme/handbook/commit/${head}`);
  assert.equal(newest.sourceRevision, `commit:${head}`);
  // A selection without commits never lists them, and an empty repository has no history to record.
  assert.ok((await listAll(provider, binding, '7001')).every(item => item.kind !== 'commit'));
  const empty = setup();
  const emptyPages = await listPages(empty.provider, empty.binding, commitsOnly, { commitHead: null });
  assert.deepEqual(
    emptyPages.map(page => [page.observations.length, page.commits]),
    [[0, undefined]],
  );
});

test('later passes list only commits newer than the indexed head, and the whole history after a force push', async () => {
  const { provider, binding, repo, github } = setup();
  for (let index = 0; index < 3; index++) github.push(repo, { message: `Base ${index}` });
  const indexed = repo.history.at(-1).sha;
  const same = await listPages(provider, binding, commitsOnly, { commitHead: indexed });
  assert.deepEqual(
    same.map(page => [page.observations.length, page.commits]),
    [[0, { head: indexed, retained: true }]],
  );
  for (let index = 0; index < 120; index++) github.push(repo, { message: `New ${index}` });
  const head = repo.history.at(-1).sha;
  github.calls.length = 0;
  const newer = await listPages(provider, binding, commitsOnly, { commitHead: indexed });
  assert.deepEqual(
    newer.flatMap(page => page.observations).map(item => item.nativeId),
    repo.history.slice(3).map(item => `commit:7001:${item.sha}`),
  );
  assert.deepEqual(newer.at(-1).commits, { head, retained: true });
  assert.equal(newer.length, 2);
  assert.match(newer[0].nextCursor, new RegExp(`^commits:${indexed}\\.\\.${head}:2$`));
  assert.ok(github.calls.every(call => call.path !== '/repositories/7001/commits'));
  // A rewritten branch no longer extends the indexed head, so its whole history is listed again.
  repo.history = repo.history.slice(0, 2);
  github.push(repo, { message: 'Rewritten' });
  const rewritten = await listPages(provider, binding, commitsOnly, { commitHead: head });
  assert.deepEqual(
    rewritten.flatMap(page => page.observations).map(item => item.nativeId),
    [...repo.history].reverse().map(item => `commit:7001:${item.sha}`),
  );
  assert.deepEqual(rewritten.at(-1).commits, { head: repo.history.at(-1).sha, retained: false });
  // A comparison GitHub cannot return also falls back to the whole history; rate limits still stop the pass.
  github.state.failure = (_user, path) =>
    path.includes('/compare/') ? new Response('x'.repeat(9 * 1024 * 1024)) : null;
  const tooLarge = await listPages(provider, binding, commitsOnly, { commitHead: repo.history[0].sha });
  assert.equal(tooLarge.at(-1).commits.retained, false);
  assert.equal(tooLarge.flatMap(page => page.observations).length, repo.history.length);
  github.state.failure = (_user, path) =>
    path.includes('/compare/') ? Response.json({}, { status: 429, headers: { 'retry-after': '5' } }) : null;
  await assert.rejects(
    provider.list(workspaceId, 'reader', binding, '7001', commitsOnly, null, { commitHead: repo.history[0].sha }),
    error => error.code === 'rate-limited',
  );
  github.state.failure = null;
  for (const cursor of ['commits:nope', `commits:${head}:0`, `commits:${head}..${head}`])
    await assert.rejects(
      provider.list(workspaceId, 'reader', binding, '7001', commitsOnly, cursor),
      error => error.code === 'invalid-cursor',
    );
  // A listing pinned to a head GitHub no longer has restarts from the current head.
  await assert.rejects(
    provider.list(workspaceId, 'reader', binding, '7001', commitsOnly, `commits:${'a'.repeat(40)}:2`),
    error => error.code === 'invalid-cursor',
  );
});

test('a commit reads as its message, people, parents and every changed file, without diffs', async () => {
  const { provider, binding, repo, github } = setup();
  const root = github.push(repo, { message: 'Initial import', files: [{ filename: 'README.md', status: 'added' }] });
  const files = Array.from({ length: 650 }, (_, index) => ({
    filename: `src/file-${index}.ts`,
    additions: 2,
    deletions: 1,
  }));
  files[0] = {
    filename: 'docs/new`name.md',
    previous_filename: 'docs/old.md',
    status: 'renamed',
    additions: 0,
    deletions: 0,
  };
  const change = github.push(repo, {
    message: 'Rename the handbook\n\nWhy: clearer\u0007 names.\r\nCo-authored-by: Someone',
    author: 'alice',
    name: 'Alice Example',
    files,
  });
  const read = await readAs(provider, binding, `commit:7001:${change.sha}`, commitsOnly);
  assert.equal(read.nativeId, `commit:7001:${change.sha}`);
  assert.equal(read.kind, 'commit');
  assert.equal(read.title, `acme/handbook@${change.sha.slice(0, 7)}: Rename the handbook`);
  assert.equal(read.sourceRevision, `commit:${change.sha}`);
  assert.equal(read.canonicalURL, `https://github.com/acme/handbook/commit/${change.sha}`);
  assert.match(read.markdown, /^# acme\/handbook@[a-f0-9]{7}: Rename the handbook\n/);
  assert.ok(read.markdown.includes(`GitHub commit ${change.sha} on the default branch of acme/handbook`));
  assert.ok(read.markdown.includes('authored by Alice Example (@alice) at '));
  assert.ok(read.markdown.includes('committed by GitHub (@web-flow) at '));
  assert.ok(read.markdown.includes(`Parent ${root.sha.slice(0, 7)}.`));
  assert.ok(read.markdown.includes('650 changed files listed, +1298 −649 lines.'));
  assert.ok(
    read.markdown.includes('## Message\n\nRename the handbook\n\nWhy: clearer\uFFFD names.\nCo-authored-by: Someone\n'),
  );
  assert.ok(read.markdown.includes('- ``docs/new`name.md`` renamed from `docs/old.md`, +0 −0'));
  assert.ok(read.markdown.includes('- `src/file-649.ts` modified, +2 −1'));
  assert.doesNotMatch(read.markdown, /@@|example\.test|noreply/);
  assert.deepEqual(
    github.calls.filter(call => call.path === `/repositories/7001/commits/${change.sha}`).map(call => call.query.page),
    ['1', '2', '3', '4', '5', '6', '7'],
  );
  const first = await readAs(provider, binding, `commit:7001:${root.sha}`, commitsOnly);
  assert.ok(first.markdown.includes('No parents (root commit). 1 changed file listed, +1 −0 lines.'));
  assert.ok(first.markdown.includes('- `README.md` added, +1 −0'));
  await assert.rejects(
    readAs(provider, binding, `commit:7001:${root.sha}`, selection),
    error => error.code === 'outside-selection',
  );
  await assert.rejects(
    readAs(provider, binding, `commit:7001:${'b'.repeat(40)}`, commitsOnly),
    error => error.code === 'not-found',
  );
  for (const id of ['commit:7001:1', `commit:7001:/p/2/${root.sha}`, `commit:7002:${root.sha}`])
    await assert.rejects(readAs(provider, binding, id, commitsOnly), error => error.code === 'invalid-selection');
});

test('a commit over GitHub file limits records the gap instead of failing', async () => {
  const { provider, binding, repo, github } = setup();
  const many = github.push(repo, {
    message: 'Vendor everything',
    files: Array.from({ length: 3200 }, (_, index) => ({ filename: `vendor/${index}.js` })),
  });
  const capped = await readAs(provider, binding, `commit:7001:${many.sha}`, commitsOnly);
  assert.ok(capped.markdown.includes('3000 changed files listed'));
  assert.ok(
    capped.markdown.includes('GitHub lists at most 3,000 changed files for one commit; this commit may change more.'),
  );
  assert.ok(!capped.markdown.includes('vendor/3000.js'));
  const huge = github.push(repo, { message: 'Huge diff\n\nBody text', files: [{ filename: 'data.json' }] });
  github.state.failure = (_user, path) =>
    path === `/repositories/7001/commits/${huge.sha}` ? new Response('x'.repeat(9 * 1024 * 1024)) : null;
  const fallback = await readAs(provider, binding, `commit:7001:${huge.sha}`, commitsOnly);
  assert.equal(fallback.title, `acme/handbook@${huge.sha.slice(0, 7)}: Huge diff`);
  assert.ok(fallback.markdown.includes('authored by Octo Cat at '));
  assert.ok(fallback.markdown.includes('## Message\n\nHuge diff\n\nBody text\n'));
  assert.ok(fallback.markdown.includes("_GitHub could not return this commit's changed files._"));
  // A later page of files GitHub cannot return keeps the files already read.
  github.state.failure = (_user, path, url) =>
    path === `/repositories/7001/commits/${many.sha}` && url.searchParams.get('page') === '3'
      ? new Response('x'.repeat(9 * 1024 * 1024))
      : null;
  const partial = await readAs(provider, binding, `commit:7001:${many.sha}`, commitsOnly);
  assert.ok(partial.markdown.includes('200 changed files listed'));
  assert.ok(partial.markdown.includes("the rest of this commit's changed files"));
});

test('a kind the connection cannot read becomes a denied marker while other kinds keep listing', async () => {
  const { provider, binding, github } = setup();
  const all = { ...selection, kinds: ['code', 'discussions', 'docs', 'issues', 'pulls'] };
  github.state.failure = (_user, path) =>
    path === '/repositories/7001/issues'
      ? Response.json({ message: 'Resource not accessible' }, { status: 403 })
      : null;
  const items = await listAll(provider, binding, '7001', all);
  const markers = items.filter(item => item.coverage === 'denied');
  assert.deepEqual(
    markers.map(item => [item.kind, item.nativeId, item.sourceRevision]),
    [
      ['issue', 'issue:7001:/denied', 'denied'],
      ['pull', 'pull:7001:/denied', 'denied'],
    ],
  );
  assert.equal(markers[0].canonicalURL, 'https://github.com/acme/handbook');
  assert.ok(items.some(item => item.nativeId === 'doc:7001:README.md'));
  assert.ok(items.some(item => item.nativeId === 'discussion:7001:5'));

  github.state.failure = (_user, path) =>
    path === '/repositories/7001/commits/main'
      ? Response.json({ message: 'Not Found' }, { status: 404 })
      : path === '/graphql'
        ? Response.json({ data: { repository: null }, errors: [{ type: 'FORBIDDEN', message: 'denied' }] })
        : null;
  const blocked = await listAll(provider, binding, '7001', all);
  assert.deepEqual(
    blocked.filter(item => item.coverage === 'denied').map(item => item.nativeId),
    ['doc:7001:/denied', 'code:7001:/denied', 'discussion:7001:/denied'],
  );
  assert.ok(blocked.some(item => item.nativeId === 'issue:7001:1'));
  await assert.rejects(readAs(provider, binding, 'issue:7001:/denied', all), error => error.code === 'not-found');

  github.state.failure = (_user, path) =>
    path === '/repositories/7001/issues' ? Response.json({ message: 'Issues are disabled' }, { status: 410 }) : null;
  const disabled = await listAll(provider, binding, '7001', all);
  assert.ok(disabled.every(item => item.coverage !== 'denied' && !['issue', 'pull'].includes(item.kind)));
});

test('a commit history the connection cannot read becomes a commit denied marker', async () => {
  const { provider, binding, repo, github } = setup();
  github.push(repo, { message: 'Hidden' });
  github.state.failure = (_user, path) =>
    path === '/repositories/7001/commits'
      ? Response.json({ message: 'Resource not accessible' }, { status: 403 })
      : null;
  const items = (await listPages(provider, binding, commitsOnly, { commitHead: null })).flatMap(
    page => page.observations,
  );
  assert.deepEqual(
    items.map(item => [item.kind, item.nativeId, item.coverage]),
    [['commit', 'commit:7001:/denied', 'denied']],
  );
  await assert.rejects(
    readAs(provider, binding, 'commit:7001:/denied', commitsOnly),
    error => error.code === 'not-found',
  );
});

test('transient failures retry with exponential backoff before surfacing', async () => {
  const sleeps = [];
  const { provider, binding, github } = setup({ sleeps });
  let failures = 2;
  github.state.failure = () => (failures-- > 0 ? new Response('{}', { status: 503 }) : null);
  const access = await provider.access(workspaceId, 'reader', binding, '7001');
  assert.equal(access.readable, true);
  assert.deepEqual(sleeps, [500, 1000]);
  sleeps.length = 0;
  const before = github.calls.length;
  github.state.failure = () => new Response('{}', { status: 502 });
  await assert.rejects(provider.access(workspaceId, 'reader', binding, '7001'), error => error.code === 'transient');
  assert.equal(github.calls.length - before, 4, 'four attempts in total');
  assert.deepEqual(sleeps, [500, 1000, 2000]);
  sleeps.length = 0;
  github.state.failure = () => Response.json({ message: 'Not Found' }, { status: 404 });
  const denied = await provider.access(workspaceId, 'reader', binding, '7001').catch(error => error);
  assert.ok(denied.readable === false || denied.code === 'forbidden');
  assert.deepEqual(sleeps, [], 'a denial is not retried');
  github.state.failure = () => Response.json({ message: 'Forbidden' }, { status: 403 });
  await provider.access(workspaceId, 'reader', binding, '7001').catch(error => error);
  assert.deepEqual(sleeps, [], 'a 403 without a rate limit is not retried');
  const rejectedBefore = github.calls.length;
  github.state.failure = () => Response.json({ message: 'Bad credentials' }, { status: 401 });
  await assert.rejects(
    provider.access(workspaceId, 'reader', binding, '7001'),
    error => error.code === 'reconnect-required',
  );
  assert.equal(github.calls.length - rejectedBefore, 1, 'a rejected credential asks for reconnection at once');
  assert.deepEqual(sleeps, []);
});

test('requests slow down as the rate budget drains and pause before it runs out', async () => {
  const sleeps = [];
  const reset = Math.floor(Date.now() / 1000) + 600;
  let remaining = 15;
  const {
    provider: paced,
    binding,
    github,
  } = setup({
    sleeps,
    wrap: fetcher => async (input, init) => {
      const response = await fetcher(input, init);
      const headers = new Headers(response.headers);
      headers.set('x-ratelimit-limit', '100');
      headers.set('x-ratelimit-remaining', String(remaining));
      headers.set('x-ratelimit-reset', String(reset));
      return new Response(response.body, { status: response.status, headers });
    },
  });
  await paced.access(workspaceId, 'reader', binding, '7001');
  assert.deepEqual(sleeps, [], 'the first call has no budget to pace against');
  await paced.access(workspaceId, 'reader', binding, '7001');
  assert.equal(sleeps.length, 1, 'below a fifth of the budget, requests are spread until the reset');
  assert.ok(sleeps[0] > 0 && sleeps[0] <= 10_000);
  remaining = 5;
  await paced.access(workspaceId, 'reader', binding, '7001');
  const calls = github.calls.length;
  await assert.rejects(
    paced.access(workspaceId, 'reader', binding, '7001'),
    error => error.code === 'rate-limited' && error.retryAfterMs > 500_000 && error.retryAfterMs <= 600_000,
  );
  assert.equal(github.calls.length, calls, 'the reserve is never spent by sync');
});

test('issue listings request the GitHub maximum page size', async () => {
  const { provider, binding, github } = setup();
  await listAll(provider, binding, '7001', { ...selection, kinds: ['issues'] });
  const issues = github.calls.filter(call => call.path.endsWith('/issues'));
  assert.ok(issues.length);
  assert.ok(issues.every(call => call.query.per_page === '100'));
});

// Lists one repository to the end the way the sync engine does: the head read for the files is passed on to later
// phases, and `mark` is the previous listing's mark.
async function listPass(provider, binding, mark, value = selection) {
  const pass = { observations: [], removed: [], mark: {}, reconcile: false };
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const history = {
      commitHead: null,
      ...(mark ? { mark } : {}),
      ...(pass.mark.head ? { head: pass.mark.head } : {}),
    };
    const result = await provider.list(workspaceId, 'reader', binding, '7001', value, cursor, history);
    pass.observations.push(...result.observations);
    pass.removed.push(...(result.removed ?? []));
    pass.mark = { ...pass.mark, ...result.mark };
    pass.reconcile ||= result.reconcile === true;
    if (!result.nextCursor) return pass;
    cursor = result.nextCursor;
  }
  assert.fail('listing did not finish');
}
const ids = pass => pass.observations.map(item => item.nativeId).sort();
const filesSelection = { ...selection, kinds: ['code', 'docs'] };

test('a full listing records the head commit and listing start as the next incremental mark', async () => {
  const { provider, binding, github } = setup();
  const pass = await listPass(provider, binding, undefined);
  assert.match(pass.mark.head, /^[a-f0-9]{40}$/);
  assert.ok(Date.parse(pass.mark.issues) > Date.now() - 60000);
  assert.ok(Date.parse(pass.mark.discussions) > Date.now() - 60000);
  assert.ok(ids(pass).includes('doc:7001:README.md'));
  assert.equal(pass.reconcile, false);
  assert.equal(github.calls.filter(call => call.path === '/repositories/7001/commits/main').length, 1);
});

test('an unchanged default-branch head skips the file listing entirely', async () => {
  const { provider, binding, github } = setup();
  const { mark } = await listPass(provider, binding, undefined, filesSelection);
  github.calls.length = 0;
  const pass = await listPass(provider, binding, mark, filesSelection);
  assert.deepEqual(pass.observations, []);
  assert.deepEqual(pass.removed, []);
  assert.equal(pass.mark.head, mark.head);
  assert.deepEqual(
    github.calls.map(call => call.path),
    ['/repositories/7001', '/repositories/7001/commits/main'],
  );
});

test('a changed head lists only changed files, in parts, and reports every touched file for removal', async () => {
  const { provider, binding, github, repo } = setup();
  const { mark } = await listPass(provider, binding, undefined, filesSelection);
  repo.files.set('docs/new.md', 'A new orchid page');
  repo.files.set('README.md', '# Handbook\n\nUpdated orchid onboarding.');
  repo.files.set('docs/huge.md', 'y'.repeat(300 * 1024));
  repo.files.set('docs/moved.md', repo.files.get('docs/supplier.md'));
  repo.files.delete('docs/supplier.md');
  repo.files.delete('src/index.ts');
  github.calls.length = 0;
  const pass = await listPass(provider, binding, mark, filesSelection);
  assert.deepEqual(ids(pass), [
    'doc:7001:/p/2/docs/huge.md',
    'doc:7001:/p/3/docs/huge.md',
    'doc:7001:README.md',
    'doc:7001:docs/huge.md',
    'doc:7001:docs/moved.md',
    'doc:7001:docs/new.md',
  ]);
  assert.deepEqual(pass.removed.sort(), [
    'code:7001:src/index.ts',
    'doc:7001:README.md',
    'doc:7001:docs/huge.md',
    'doc:7001:docs/moved.md',
    'doc:7001:docs/new.md',
    'doc:7001:docs/supplier.md',
  ]);
  assert.notEqual(pass.mark.head, mark.head);
  assert.equal(pass.reconcile, false);
  assert.ok(github.calls.some(call => call.path.startsWith(`/repositories/7001/compare/${mark.head}...`)));
  assert.ok(pass.observations.every(item => item.sourceRevision.startsWith('blob:')));
});

test('incremental file listings keep excluded paths and unselected kinds out', async () => {
  const { provider, binding, repo } = setup();
  const value = { ...selection, kinds: ['docs'], excludePaths: ['^docs/private/'] };
  const { mark } = await listPass(provider, binding, undefined, value);
  repo.files.set('docs/private/salary.md', 'Excluded orchid budget');
  repo.files.set('docs/public.md', 'Public orchid page');
  repo.files.set('src/next.ts', 'export const next = 1;');
  const pass = await listPass(provider, binding, mark, value);
  assert.deepEqual(ids(pass), ['doc:7001:docs/public.md']);
  assert.ok(!pass.removed.some(id => id.startsWith('code:')));
});

test('a truncated recursive tree still lists changes by reading only the changed directories', async () => {
  const { provider, binding, github, repo } = setup();
  const { mark } = await listPass(provider, binding, undefined, filesSelection);
  repo.files.set('docs/new.md', 'A new orchid page');
  github.state.truncate = true;
  github.calls.length = 0;
  const pass = await listPass(provider, binding, mark, filesSelection);
  assert.deepEqual(ids(pass), ['doc:7001:docs/new.md']);
  assert.equal(pass.reconcile, false);
  assert.equal(github.calls.filter(call => call.path.includes('/git/trees/') && !call.query.recursive).length, 2);
});

test('incremental file listing falls back to a full listing and asks for reconciliation when compare cannot be used', async t => {
  for (const [name, change] of [
    [
      'force-pushed base',
      github => (github.state.compare = () => Response.json({ message: 'No common ancestor' }, { status: 404 })),
    ],
    ['diverged history', github => (github.state.compare = () => Response.json({ status: 'diverged', files: [] }))],
    [
      'too many changed files',
      github =>
        (github.state.compare = () =>
          Response.json({
            status: 'ahead',
            files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md`, status: 'added' })),
          })),
    ],
    [
      'truncated directories',
      github => {
        github.state.truncate = true;
        github.state.truncateDirs.add('docs/');
      },
    ],
  ])
    await t.test(name, async () => {
      const { provider, binding, github, repo } = setup();
      const { mark } = await listPass(provider, binding, undefined, filesSelection);
      repo.files.set('docs/new.md', 'A new orchid page');
      change(github);
      const pass = await listPass(provider, binding, mark, filesSelection);
      assert.equal(pass.reconcile, true);
      assert.ok(ids(pass).includes('doc:7001:README.md'), 'the full listing still includes unchanged files');
      assert.notEqual(pass.mark.head, mark.head);
    });
});

test('incremental issue and discussion listings start from the previous listing less a small overlap', async () => {
  const { provider, binding, github, repo } = setup();
  const value = { ...selection, kinds: ['discussions', 'issues'] };
  const first = await listPass(provider, binding, undefined, value);
  assert.deepEqual(ids(first), ['discussion:7001:5', 'issue:7001:1']);
  // Nothing changed since the last listing started, beyond the overlap.
  const old = new Date(Date.now() - 10 * 60000).toISOString();
  repo.issues.get(1).updated_at = old;
  repo.discussions.get(5).updatedAt = old;
  github.calls.length = 0;
  const quiet = await listPass(provider, binding, first.mark, value);
  assert.deepEqual(ids(quiet), []);
  const since = github.calls.find(call => call.path === '/repositories/7001/issues').query.since;
  assert.ok(Math.abs(Date.parse(since) - (Date.parse(first.mark.issues) - 5 * 60000)) < 1000);
  github.touch(repo, 1, { title: 'Orchid shipment arrived' });
  repo.discussions.get(5).updatedAt = new Date().toISOString();
  const changed = await listPass(provider, binding, first.mark, value);
  assert.deepEqual(ids(changed), ['discussion:7001:5', 'issue:7001:1']);
  assert.ok(Date.parse(changed.mark.issues) >= Date.parse(first.mark.issues));
});

test('without a cutoff or mark, issues are listed from the beginning', async () => {
  const { provider, binding, github } = setup();
  const { after: _after, ...value } = { ...selection, kinds: ['issues'] };
  await listPass(provider, binding, undefined, value);
  assert.equal(github.calls.find(call => call.path === '/repositories/7001/issues').query.since, undefined);
});

// Serves a repository's issues from a list sorted once, the way GitHub's ascending update-time listing pages them.
function manyIssues(issues) {
  const sorted = issues.toSorted((a, b) => a.updated_at.localeCompare(b.updated_at) || a.number - b.number);
  const requests = [];
  const wrap = fetcher => async (input, init) => {
    const url = new URL(input);
    if (url.pathname !== '/repositories/7001/issues') return fetcher(input, init);
    const since = url.searchParams.get('since');
    const per = Number(url.searchParams.get('per_page'));
    const page = Number(url.searchParams.get('page'));
    requests.push({ since, page });
    let start = 0;
    if (since) {
      let high = sorted.length;
      while (start < high) {
        const middle = (start + high) >> 1;
        if (Date.parse(sorted[middle].updated_at) < Date.parse(since)) start = middle + 1;
        else high = middle;
      }
    }
    return Response.json(
      sorted.slice(start + (page - 1) * per, start + page * per).map(issue => ({
        number: issue.number,
        title: `Issue ${issue.number}`,
        body: null,
        user: { login: 'octo' },
        state: 'open',
        created_at: issue.updated_at,
        updated_at: issue.updated_at,
        comments: 0,
        html_url: `https://github.com/acme/handbook/issues/${issue.number}`,
      })),
    );
  };
  return { wrap, requests };
}
async function listIssuesToEnd(provider, binding, value, cursor = null) {
  const numbers = [];
  for (let page = 0; page < 5000; page++) {
    const result = await provider.list(workspaceId, 'reader', binding, '7001', value, cursor);
    numbers.push(...result.observations.map(item => Number(item.nativeId.split(':')[2])));
    if (!result.nextCursor) return numbers;
    assert.notEqual(result.nextCursor, cursor, 'every page moves the cursor');
    cursor = result.nextCursor;
  }
  assert.fail('listing did not finish');
}
const second = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

test('issue listings page by update time past 50,000 issues without large page numbers', async () => {
  const base = Date.parse(`${after}T00:00:00Z`) + 86400000;
  // Three issues share each update second, so ties straddle most page boundaries.
  const issues = Array.from({ length: 60000 }, (_, i) => ({
    number: i + 1,
    updated_at: second(base + Math.floor(i / 3) * 1000),
  }));
  const served = manyIssues(issues);
  const { provider, binding } = setup({ wrap: served.wrap });
  const numbers = await listIssuesToEnd(provider, binding, { ...selection, kinds: ['issues'] });
  assert.equal(numbers.length, 60000);
  assert.equal(new Set(numbers).size, 60000, 'every issue is listed exactly once');
  assert.ok(
    served.requests.every(request => request.page === 1),
    'page numbers never grow with the issue count',
  );
  assert.ok(served.requests.length < 700);
});

test('issues sharing one update second are paged through without skipping or repeating', async () => {
  const base = Date.parse(`${after}T00:00:00Z`) + 86400000;
  const issues = [
    ...Array.from({ length: 98 }, (_, i) => ({ number: i + 1, updated_at: second(base + i * 1000) })),
    // 250 issues share one second across three pages, and the group starts two issues before a page boundary.
    ...Array.from({ length: 250 }, (_, i) => ({ number: 1000 + i, updated_at: second(base + 500000) })),
    ...Array.from({ length: 5 }, (_, i) => ({ number: 2000 + i, updated_at: second(base + 600000 + i * 1000) })),
  ];
  const served = manyIssues(issues);
  const { provider, binding } = setup({ wrap: served.wrap });
  const numbers = await listIssuesToEnd(provider, binding, { ...selection, kinds: ['issues'] });
  assert.deepEqual(
    numbers.toSorted((a, b) => a - b),
    issues.map(issue => issue.number),
  );
  assert.ok(
    served.requests.some(request => request.page === 3),
    'a tie group longer than a page steps by page',
  );
  assert.ok(served.requests.every(request => request.page <= 3));
});

test('issue cursors are validated, and a page-number cursor from an older listing restarts it', async () => {
  const { provider, binding } = setup();
  const value = { ...selection, kinds: ['issues'] };
  const restarted = await provider.list(workspaceId, 'reader', binding, '7001', value, 'issues:7');
  assert.deepEqual(
    restarted.observations.map(item => item.nativeId),
    ['issue:7001:1'],
  );
  assert.ok(restarted.mark?.issues, 'a restarted listing records its own start');
  for (const cursor of [
    'issues:2024-01-01',
    'issues:2024-02-30T00:00:00Z',
    'issues:2024-01-01T00:00:00Z/1',
    'issues:2024-01-01T00:00:00.000Z',
    'issues:x',
  ])
    await assert.rejects(
      provider.list(workspaceId, 'reader', binding, '7001', value, cursor),
      error => error.code === 'invalid-cursor',
      cursor,
    );
  const resumed = await provider.list(workspaceId, 'reader', binding, '7001', value, 'issues:2000-01-01T00:00:00Z/2');
  assert.deepEqual(resumed.observations, []);
  assert.equal(resumed.mark, undefined);
});

test('the commit listing pins to the head the file listing read', async () => {
  const { provider, binding, github } = setup();
  github.push(github.state.repos.get(7001), { message: 'First', files: [{ filename: 'README.md' }] });
  const pass = await listPass(provider, binding, undefined, { ...selection, kinds: ['commits', 'docs'] });
  assert.equal(github.calls.filter(call => call.path === '/repositories/7001/commits/main').length, 1);
  assert.ok(ids(pass).some(id => id.startsWith('commit:7001:')));
});
