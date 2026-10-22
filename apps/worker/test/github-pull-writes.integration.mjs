import assert from 'node:assert/strict';
import test from 'node:test';
import { githubChatFixture } from './github-read-fixture.mjs';
import { createGitHubAccounts } from '@tulipfarm/github';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { mcpWriteCases, mcpWriteFixture } from '../../../packages/github/test/mcp-write-fixture.mjs';

const repo = { owner: 'octocat', repo: 'private', repositoryId: 42 };
const target = { ...repo, pullNumber: 7, pullRequestId: 77 };
const sha = 'a'.repeat(40);
const merge = {
  kind: 'pull.merge',
  ...target,
  headSha: sha,
  base: 'main',
  mergeMethod: 'squash',
  commitTitle: 'Ship fix',
  commitMessage: 'Reviewed changes',
};

async function fixture(mcpCase, mcpResult) {
  const nativeFetch = globalThis.fetch;
  const f = await githubChatFixture();
  let applyMcp;
  const mcp = mcpCase
    ? await mcpWriteFixture({
        item: mcpCase,
        result: mcpResult,
        fetcher: nativeFetch,
        effect: params => applyMcp(params.arguments),
      })
    : null;
  const previousBindings = process.env.GITHUB_MCP_WRITE_BINDINGS;
  if (mcp) {
    process.env.GITHUB_MCP_WRITE_BINDINGS = JSON.stringify(mcp.bindings);
    const restFetch = globalThis.fetch;
    globalThis.fetch = (url, init) =>
      String(url) === 'https://api.githubcopilot.com/mcp/' ? mcp.fetcher(url, init) : restFetch(url, init);
  }
  const accountId = await f.connect(123),
    chatId = await f.chat();
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
  const accounts = createGitHubAccounts({ runtime: f.runtime, configuration: f.configuration, keyring: f.keyring });
  const options = {
    runtime: f.runtime,
    accounts,
    requireSources: requireDraftSources,
    ...(mcp ? { bindings: mcp.bindings } : {}),
  };
  const batches = createGitHubBatches(options);
  const decide = createGitHubBatchDecision({
    ...options,
    resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
  });
  const effects = [],
    comments = [],
    reviews = [],
    created = [];
  let pull = {
    id: 77,
    number: 7,
    title: 'Before',
    body: 'Original',
    base: { ref: 'main', repo: { id: 42 } },
    head: { sha, ref: 'fix' },
    state: 'open',
    merged: false,
    draft: false,
  };
  const mcpEffects = [];
  applyMcp = args => {
    const kind = mcpCase.operation.kind;
    const value = kind.endsWith('.create')
      ? { id: 88, number: 8, title: args.title, body: args.body }
      : kind.endsWith('.comment')
        ? { id: 99, body: args.body }
        : kind === 'pull.review'
          ? { body: args.body, commit_id: args.commitID, state: 'CHANGES_REQUESTED' }
          : kind === 'pull.request-reviewers'
            ? { reviewers: args.reviewers }
            : kind === 'pull.merge'
              ? { merged: true, sha: args.expectedHeadSha }
              : kind.endsWith('.update')
                ? { title: args.title, body: args.body }
                : { state: args.state };
    mcpEffects.push(value);
    if (kind === 'pull.close' || kind === 'pull.reopen') pull.state = args.state;
    if (kind === 'pull.update') {
      pull.title = args.title;
      pull.body = args.body;
    }
    if (kind === 'pull.merge') {
      pull.state = 'closed';
      pull.merged = true;
    }
  };
  let lose = false,
    deny = false,
    race = false;
  f.setProvider(async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === 'GET') {
      if (deny) return Response.json({}, { status: 403 });
      if (path.endsWith('/private'))
        return Response.json({ id: 42, full_name: 'octocat/private', archived: false, permissions: { push: true } });
      return Response.json(
        path.endsWith('/comments')
          ? comments
          : path.endsWith('/reviews')
            ? reviews
            : path.endsWith('/pulls')
              ? created
              : pull,
      );
    }
    const body = JSON.parse(init.body);
    if (race && path.endsWith('/merge')) {
      pull.head.sha = 'b'.repeat(40);
      return Response.json({}, { status: 409 });
    }
    effects.push({ path, body });
    let result = { id: 99 + effects.length, number: 8, ...body, user: { id: 123 } };
    if (path.endsWith('/merge')) {
      pull = { ...pull, merged: true, state: 'closed' };
      result = { merged: true, sha: 'c'.repeat(40) };
    } else if (init.method === 'PATCH') {
      pull = { ...pull, ...body, base: { ref: body.base ?? pull.base.ref, repo: { id: 42 } } };
      result = pull;
    } else if (path.endsWith('/comments')) comments.push(result);
    else if (path.endsWith('/reviews')) {
      result.state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[body.event];
      reviews.push(result);
    } else if (path.endsWith('/pulls')) {
      result.head = { ref: body.head };
      result.base = { ref: body.base, repo: { id: 42 } };
      created.push(result);
    }
    if (lose) throw new Error('Lost acknowledgement after effect');
    return Response.json(result, { status: path.endsWith('/reviews') ? 200 : init.method === 'POST' ? 201 : 200 });
  });
  async function propose(actions, withSource = true) {
    f.decide(
      [
        ...(withSource
          ? [
              {
                tool: 'github.personal.read',
                operation: { kind: 'pull.read', owner: 'octocat', repo: 'private', number: 7 },
              },
            ]
          : []),
        { tool: 'github.personal.propose', actions },
      ],
      'Review the exact pull request batch.',
    );
    assert.equal((await f.send(chatId)).status, 'completed');
    const batch = (await batches.list(f.one.id, f.member.userId, chatId)).batches[0];
    if (withSource)
      assert.equal(
        batch.snapshot.sources.some(source => source.kind === 'github-personal'),
        true,
      );
    return batch;
  }
  const read = batch => batches.read(f.one.id, f.member.userId, chatId, batch.snapshot.id);
  const approve = batch =>
    decide(f.one.id, f.member.userId, chatId, batch.snapshot.id, { digest: batch.digest, decision: 'approve' });
  const execute = batch => batches.execute(f.one.id, f.member.userId, chatId, batch.snapshot.id);
  const reconcile = batch => batches.reconcile(f.one.id, f.member.userId, chatId, batch.snapshot.id);
  return {
    ...f,
    mcp,
    mcpEffects,
    chatId,
    batches,
    effects,
    propose,
    read,
    approve,
    execute,
    reconcile,
    lose() {
      lose = true;
    },
    deny() {
      deny = true;
    },
    race() {
      race = true;
    },
    changeHead() {
      pull.head.sha = 'b'.repeat(40);
    },
    async close() {
      await mcp?.close();
      if (previousBindings === undefined) delete process.env.GITHUB_MCP_WRITE_BINDINGS;
      else process.env.GITHUB_MCP_WRITE_BINDINGS = previousBindings;
      await f.close();
    },
  };
}

for (const item of mcpWriteCases)
  test(`registered worker persists official MCP ${item.operation.kind} and continues once`, async () => {
    const f = await fixture(item);
    try {
      const follow =
        item.operation.kind === 'pull.comment'
          ? { kind: 'pull.update', ...target, title: 'After', body: 'Updated', base: 'main' }
          : { kind: 'pull.comment', ...target, body: 'Continue' };
      const batch = await f.propose([item.operation, follow], false);
      await f.approve(batch);
      f.decide([{ tool: 'github.personal.execute', batchId: batch.snapshot.id }], 'Completed.');
      assert.equal((await f.send(f.chatId, 'Execute my approved batch.')).status, 'completed');
      const result = await f.read(batch);
      assert.deepEqual(
        result.actions.map(action => action.status),
        ['succeeded', 'succeeded'],
      );
      assert.deepEqual(result.actions[0].result, item.receipt);
      const kind = item.operation.kind,
        body = batch.snapshot.actions[0].body;
      const expectedEffect = kind.endsWith('.create')
        ? { id: 88, number: 8, title: 'New', body }
        : kind.endsWith('.comment')
          ? { id: 99, body }
          : kind === 'pull.review'
            ? { body, commit_id: sha, state: 'CHANGES_REQUESTED' }
            : kind === 'pull.request-reviewers'
              ? { reviewers: ['reviewer', 'octocat/engineers'] }
              : kind === 'pull.merge'
                ? { merged: true, sha }
                : kind.endsWith('.update')
                  ? { title: 'Edit', body: 'Updated' }
                  : { state: kind.endsWith('.close') ? 'closed' : 'open' };
      assert.deepEqual(f.mcpEffects, [expectedEffect]);
      assert.deepEqual(
        result.actions[1].result,
        follow.kind === 'pull.update' ? { id: 77, number: 7 } : { id: 100, number: 8 },
      );
      assert.deepEqual(f.mcp.calls, [
        {
          name: item.name,
          arguments: { ...item.args, ...('body' in item.args ? { body: batch.snapshot.actions[0].body } : {}) },
        },
      ]);
      assert.equal(f.effects.length, 1);
      await f.execute(batch);
      assert.equal(f.mcp.calls.length, 1);
      assert.deepEqual(f.mcpEffects, [expectedEffect]);
      assert.equal(f.effects.length, 1);
      const next = await f.propose([{ kind: 'pull.comment', ...target, body: 'Next batch' }], false);
      assert.equal(next.actions[0].status, 'unattempted');
    } finally {
      await f.close();
    }
  });

for (const kind of ['pull.update', 'pull.close', 'pull.reopen', 'pull.review'])
  test(`malformed configured MCP ${kind} remains uncertain and blocks continuation`, async () => {
    const item = mcpWriteCases.find(item => item.operation.kind === kind);
    const f = await fixture(item, { content: [{ type: 'text', text: 'not a qualified success' }] });
    try {
      const batch = await f.propose([item.operation, { kind: 'pull.comment', ...target, body: 'Must wait' }], false);
      await f.approve(batch);
      f.decide([{ tool: 'github.personal.execute', batchId: batch.snapshot.id }], 'Outcome uncertain.');
      assert.equal((await f.send(f.chatId, 'Execute my approved batch.')).status, 'completed');
      assert.deepEqual(
        (await f.read(batch)).actions.map(action => action.status),
        ['unknown', 'unattempted'],
      );
      await f.execute(batch);
      assert.deepEqual(
        (await f.reconcile(batch)).actions.map(action => action.status),
        ['unknown', 'unattempted'],
      );
      assert.equal(f.mcp.calls.length, 1);
      assert.equal(f.effects.length, 0);
    } finally {
      await f.close();
    }
  });

test('registered worker executes an exact approved ordered pull batch and preserves receipts after its own source changes', async () => {
  const f = await fixture();
  try {
    const actions = [
      { kind: 'pull.create', ...repo, head: 'next', base: 'main', title: 'Next', body: 'New PR', draft: false },
      { kind: 'pull.update', ...target, title: 'After', body: 'Updated', base: 'main' },
      { kind: 'pull.comment', ...target, body: 'Comment' },
      { kind: 'pull.review', ...target, headSha: sha, body: 'Reviewed', event: 'COMMENT' },
      { kind: 'pull.request-reviewers', ...target, reviewers: ['reviewer'], teamReviewers: ['engineers'] },
      { kind: 'pull.close', ...target },
      { kind: 'pull.reopen', ...target },
      merge,
    ];
    const batch = await f.propose(actions, false);
    await assert.rejects(f.execute(batch), /batch-approval-required/);
    assert.equal(f.effects.length, 0);
    await f.approve(batch);
    f.decide([{ tool: 'github.personal.execute', batchId: batch.snapshot.id }], 'The reviewed batch completed.');
    assert.equal((await f.send(f.chatId, 'Execute my approved batch.')).status, 'completed');
    const result = await f.read(batch);
    assert.deepEqual(
      result.actions.map(action => action.status),
      Array(8).fill('succeeded'),
    );
    assert.deepEqual(result.snapshot, batch.snapshot);
    assert.deepEqual(result.actions[7].result, { merged: true, sha: 'c'.repeat(40) });
    assert.deepEqual(
      f.effects.map(effect => effect.path),
      [
        '/repos/octocat/private/pulls',
        '/repos/octocat/private/pulls/7',
        '/repos/octocat/private/issues/7/comments',
        '/repos/octocat/private/pulls/7/reviews',
        '/repos/octocat/private/pulls/7/requested_reviewers',
        '/repos/octocat/private/pulls/7',
        '/repos/octocat/private/pulls/7',
        '/repos/octocat/private/pulls/7/merge',
      ],
    );
    assert.deepEqual(f.effects[7].body, {
      sha,
      merge_method: 'squash',
      commit_title: 'Ship fix',
      commit_message: 'Reviewed changes',
    });
    await f.execute(batch);
    assert.equal(f.effects.length, 8);
  } finally {
    await f.close();
  }
});

test('a pull read followed by update and merge keeps its exact approval and source access', async () => {
  const f = await fixture();
  try {
    const batch = await f.propose([
      { kind: 'pull.update', ...target, title: 'After', body: 'Changed', base: 'main' },
      merge,
    ]);
    await f.approve(batch);
    assert.deepEqual(
      (await f.execute(batch)).actions.map(action => action.status),
      ['succeeded', 'succeeded'],
    );
    assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
    f.deny();
    await assert.rejects(f.read(batch), /Resource not found/);
    assert.equal(f.effects.length, 2);
  } finally {
    await f.close();
  }
});

for (const mode of ['changed-head', 'race', 'lost-ack'])
  test(`merge ${mode} never retries or dispatches a later action`, async () => {
    const f = await fixture();
    try {
      const batch = await f.propose([merge, { kind: 'pull.comment', ...target, body: 'Merged' }]);
      await f.approve(batch);
      if (mode === 'changed-head') f.changeHead();
      if (mode === 'race') f.race();
      if (mode === 'lost-ack') f.lose();
      await Promise.all([f.execute(batch), f.execute(batch)]);
      const result = await f.read(batch);
      assert.deepEqual(
        result.actions.map(action => action.status),
        [mode === 'lost-ack' ? 'unknown' : 'rejected', 'unattempted'],
      );
      assert.equal(f.effects.length, mode === 'lost-ack' ? 1 : 0);
      assert.deepEqual(
        (await f.reconcile(batch)).actions.map(action => action.status),
        result.actions.map(action => action.status),
      );
      await f.execute(batch);
      assert.equal(f.effects.length, mode === 'lost-ack' ? 1 : 0);
    } finally {
      await f.close();
    }
  });

test('lost review acknowledgement recovers exact head, event, actor, and marker without repeated review', async () => {
  const f = await fixture();
  try {
    const batch = await f.propose([
      { kind: 'pull.review', ...target, headSha: sha, event: 'REQUEST_CHANGES', body: 'Fix tests' },
    ]);
    await f.approve(batch);
    f.lose();
    assert.equal((await f.execute(batch)).actions[0].status, 'unknown');
    const result = await f.reconcile(batch);
    assert.equal(result.actions[0].status, 'succeeded');
    assert.equal(result.actions[0].reconciliation.outcome, 'confirmed-original-success');
    assert.deepEqual(result.snapshot, batch.snapshot);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});
