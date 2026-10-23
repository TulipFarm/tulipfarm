import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchGitHubWrite, reconcileGitHubWrite, requireWriteTarget } from '../dist/write-provider.js';
import { githubBatchInputSchema } from '../dist/batch-contracts.js';
import { fileProviderFixture, fileTarget, headSha, blob, forkOperation } from './file-provider-fixture.mjs';

const credential = {
  accessToken: 'synthetic-file-credential',
  identity: { id: '123', login: 'octocat' },
  scopes: ['repo', 'workflow'],
};
export const fileOperations = [
  {
    kind: 'file.create',
    ...fileTarget,
    path: 'new.txt',
    encoding: 'base64',
    content: Buffer.from('exact new text\n').toString('base64'),
    message: 'Create exact file',
  },
  {
    kind: 'file.update',
    ...fileTarget,
    path: 'old.txt',
    blobSha: blob('old text\n'),
    encoding: 'utf-8',
    content: 'updated text\n',
    message: 'Update exact file',
  },
  { kind: 'file.delete', ...fileTarget, path: 'old.txt', blobSha: blob('old text\n'), message: 'Delete exact file' },
  {
    kind: 'files.commit',
    ...fileTarget,
    message: 'Atomic exact files',
    files: [
      { kind: 'create', path: 'new.txt', encoding: 'utf-8', content: 'new text\n' },
      { kind: 'delete', path: 'old.txt', blobSha: blob('old text\n') },
    ],
  },
];
for (const operation of [...fileOperations, forkOperation])
  test(`real HTTP ${operation.kind} writes exact approved data and retains a receipt`, async t => {
    const f = await fileProviderFixture();
    t.after(f.close);
    let candidate;
    await requireWriteTarget(operation, credential, f.fetcher, true);
    const outcome = await dispatchGitHubWrite({
      operation: githubBatchInputSchema.parse({ actions: [operation] }).actions[0],
      credential,
      fetcher: f.fetcher,
      bindings: [],
      authorize: async () => true,
      beforeVisibleWrite: async value => {
        candidate = value;
        assert.equal(f.branches.get('main'), headSha);
      },
    });
    assert.equal(outcome.status, 'succeeded');
    if (operation.kind === 'pull.create-fork') {
      assert.deepEqual(outcome.result, { id: 88, number: 8 });
      assert.deepEqual(f.effects[0].body, {
        title: 'Reviewed fork',
        body: 'Exact fork body',
        head: 'octocat:main',
        head_repo: 'private',
        base: 'main',
        draft: false,
        maintainer_can_modify: false,
      });
      return;
    }
    assert.deepEqual(outcome.result, {
      repositoryId: 42,
      branch: 'main',
      headSha,
      defaultBranch: 'main',
      commitSha: f.branches.get('main'),
      files:
        operation.kind === 'files.commit'
          ? [
              { path: 'new.txt', deleted: false },
              { path: 'old.txt', deleted: true },
            ]
          : [{ path: operation.path, deleted: operation.kind === 'file.delete' }],
    });
    assert.equal(f.current().get('keep.txt').content, 'untouched\n');
    assert.equal(f.current().get('keep.txt').mode, '100755');
    if (operation.kind === 'files.commit') {
      assert.equal(f.current().get('new.txt').content, 'new text\n');
      assert.equal(f.current().has('old.txt'), false);
      assert.deepEqual(
        f.effects.map(effect => effect.path),
        [
          '/repos/octocat/private/git/trees',
          '/repos/octocat/private/git/commits',
          '/repos/octocat/private/git/refs/heads/main',
        ],
      );
      assert.deepEqual(f.effects[0].body, {
        base_tree: 'b'.repeat(40),
        tree: [
          { path: 'new.txt', mode: '100644', type: 'blob', content: 'new text\n' },
          { path: 'old.txt', mode: '100644', type: 'blob', sha: null },
        ],
      });
      assert.deepEqual(f.effects[1].body, { message: operation.message, tree: candidate.treeSha, parents: [headSha] });
      assert.deepEqual(f.effects[2].body, { sha: candidate.commitSha, force: false });
    } else {
      assert.equal(f.effects[0].method, operation.kind === 'file.delete' ? 'DELETE' : 'PUT');
      assert.deepEqual(f.effects[0].body, {
        branch: 'main',
        message: operation.message,
        ...('blobSha' in operation ? { sha: operation.blobSha } : {}),
        ...(operation.kind !== 'file.delete'
          ? {
              content: Buffer.from(
                operation.encoding === 'base64' ? Buffer.from(operation.content, 'base64') : operation.content,
              ).toString('base64'),
            }
          : {}),
      });
    }
  });

test('file payload rejects unsafe paths, malformed text, excessive batches and generic authority fields', () => {
  const valid = fileOperations[0];
  assert.equal(githubBatchInputSchema.safeParse({ actions: [valid] }).success, true);
  for (const change of [
    { headSha: undefined },
    { repositoryId: undefined },
    { path: '../file' },
    { path: '.git/config' },
    { path: '/absolute' },
    { path: 'x\\y' },
    { content: '/w==' },
    { content: 'AA==' },
    { content: 'abc' },
    { content: 'a'.repeat(8193), encoding: 'utf-8' },
    { force: true },
    { url: 'https://attacker.test' },
  ])
    assert.equal(githubBatchInputSchema.safeParse({ actions: [{ ...valid, ...change }] }).success, false);
  assert.equal(githubBatchInputSchema.safeParse({ actions: Array.from({ length: 9 }, () => valid) }).success, false);
  assert.equal(
    githubBatchInputSchema.safeParse({
      actions: [
        {
          ...fileOperations[3],
          files: [
            { kind: 'create', path: 'a', content: '', encoding: 'utf-8' },
            { kind: 'create', path: 'a/b', content: '', encoding: 'utf-8' },
          ],
        },
      ],
    }).success,
    false,
  );
});

test('current identities, heads, blob SHAs, rights, workflow scope and truncated trees prevent file dispatch', async t => {
  const f = await fileProviderFixture();
  t.after(f.close);
  const run = (operation, token = credential) =>
    dispatchGitHubWrite({
      operation,
      credential: token,
      bindings: [],
      fetcher: f.fetcher,
      authorize: async () => true,
    });
  for (const operation of [
    { ...fileOperations[1], blobSha: 'c'.repeat(40) },
    { ...fileOperations[0], path: 'old.txt' },
    { ...fileOperations[2], path: 'absent.txt' },
    { ...fileOperations[1], repositoryId: 43 },
    { ...fileOperations[1], headSha: 'c'.repeat(40) },
  ])
    await assert.rejects(run(operation), /batch-conflict/);
  f.state.push = false;
  await assert.rejects(run(fileOperations[0]), /batch-conflict/);
  f.state.push = true;
  f.state.truncated = true;
  await assert.rejects(run(fileOperations[0]));
  f.state.truncated = false;
  assert.deepEqual(f.effects, []);
  assert.equal((await run(fileOperations[0])).status, 'succeeded');
});

test('contents accepts documented status only and never leaks malformed response credentials', async t => {
  for (const [index, status] of [
    [0, 200],
    [1, 201],
    [2, 201],
  ]) {
    const f = await fileProviderFixture();
    t.after(f.close);
    f.state.status = status;
    assert.deepEqual(
      await dispatchGitHubWrite({
        operation: fileOperations[index],
        credential,
        bindings: [],
        fetcher: f.fetcher,
        authorize: async () => true,
      }),
      { status: 'unknown', result: null },
    );
  }
  const f = await fileProviderFixture();
  t.after(f.close);
  f.state.malformed = 'new.txt';
  f.state.secret = credential.accessToken;
  await assert.rejects(
    dispatchGitHubWrite({
      operation: fileOperations[0],
      credential,
      bindings: [],
      fetcher: f.fetcher,
      authorize: async () => true,
    }),
    error => !String(error).includes(credential.accessToken),
  );
});

for (const operation of fileOperations)
  test(`lost ${operation.kind} acknowledgement reconciles exact commit and ancestry without another write`, async t => {
    const f = await fileProviderFixture();
    t.after(f.close);
    const marker = '<!-- tulipfarm:receipt:0 -->',
      approved = { ...operation, message: operation.message + '\n\n' + marker };
    let candidate;
    f.state.lose = operation.kind === 'files.commit' ? '/git/refs/heads/main' : operation.path;
    await assert.rejects(
      dispatchGitHubWrite({
        operation: approved,
        credential,
        bindings: [],
        fetcher: f.fetcher,
        authorize: async () => true,
        beforeVisibleWrite: async value => {
          candidate = value;
        },
      }),
    );
    const original = f.branches.get('main'),
      later = 'e'.repeat(40);
    f.commits.set(later, {
      sha: later,
      parents: [{ sha: original }],
      message: 'Later unrelated',
      tree: f.commits.get(original).tree,
    });
    f.branches.set('main', later);
    const result = await reconcileGitHubWrite({
      operation: approved,
      credential,
      fetcher: f.fetcher,
      marker,
      previousEvidence: candidate,
    });
    assert.equal(result.result.commitSha, original);
    assert.equal(result.evidence.observedHead, later);
    assert.equal(result.evidence.outcome, 'confirmed-original-success');
    assert.equal(f.effects.length, operation.kind === 'files.commit' ? 3 : 1);
    if (operation.kind === 'files.commit') {
      f.branches.set('main', headSha);
      assert.equal(
        (
          await reconcileGitHubWrite({
            operation: approved,
            credential,
            fetcher: f.fetcher,
            marker,
            previousEvidence: candidate,
          })
        ).result,
        null,
      );
    }
  });

test('preparatory orphan objects and a changed branch never count as branch success', async t => {
  const f = await fileProviderFixture();
  t.after(f.close);
  f.state.race = true;
  let visible = false;
  await assert.rejects(
    dispatchGitHubWrite({
      operation: fileOperations[3],
      credential,
      bindings: [],
      fetcher: f.fetcher,
      authorize: async () => true,
      beforeVisibleWrite: async () => {
        visible = true;
      },
    }),
    /batch-conflict/,
  );
  assert.equal(visible, false);
  assert.equal(f.effects.length, 2);
  assert.equal(f.branches.get('main'), 'c'.repeat(40));
});

test('a ref race at dispatch rejects without force or rollback of unrelated work', async t => {
  const f = await fileProviderFixture();
  t.after(f.close);
  const result = await dispatchGitHubWrite({
    operation: fileOperations[3],
    credential,
    bindings: [],
    fetcher: f.fetcher,
    authorize: async () => true,
    beforeVisibleWrite: async () => {
      f.branches.set('main', 'c'.repeat(40));
    },
  });
  assert.deepEqual(result, { status: 'rejected', result: null });
  assert.equal(f.branches.get('main'), 'c'.repeat(40));
  assert.deepEqual(
    f.requests.filter(item => item.method === 'PATCH').map(item => item.body),
    [{ sha: '0000000000000000000000000000000000000003', force: false }],
  );
});

test('fork checks both stable repositories, current head permission and expected head', async t => {
  const f = await fileProviderFixture();
  t.after(f.close);
  await requireWriteTarget(forkOperation, credential, f.fetcher, true);
  for (const change of [{ repositoryId: 100 }, { headRepositoryId: 43 }, { headSha: 'f'.repeat(40) }])
    await assert.rejects(
      requireWriteTarget({ ...forkOperation, ...change }, credential, f.fetcher, true),
      /batch-conflict/,
    );
  f.state.push = false;
  await assert.rejects(requireWriteTarget(forkOperation, credential, f.fetcher, true), /batch-conflict/);
  await requireWriteTarget(forkOperation, credential, f.fetcher, false);
  assert.deepEqual(f.effects, []);
});

test('encoded credentials in provider JSON cannot enter file receipts', async () => {
  const token = credential.accessToken;
  const escaped = [...token].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  await assert.rejects(
    requireWriteTarget(
      fileOperations[0],
      credential,
      async () =>
        new Response(
          `{"id":42,"full_name":"octocat/private","archived":false,"default_branch":"${escaped}","permissions":{"push":true}}`,
        ),
    ),
    error => !String(error).includes(token),
  );
});
