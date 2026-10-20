import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { googleFixture } from '../../../google-workspace/test/fixture.mjs';
import { githubFixture } from '../../../github/test/fixture.mjs';
import { createGitHubReads } from '../../../github/src/reads.ts';
import { createConversations } from '../../src/index.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

async function seed(f, runtime, workspace, userId, tool = 'web.fetch') {
  const store = createConversations(runtime);
  const chatId = randomUUID();
  await store.create(workspace.id, userId, { chatId, commandId: randomUUID() });
  const url = 'https://example.com/?q=PRIVATE-MEETING-ACQUISITION';
  const resultUrl = 'https://example.com/PRIVATE-REPOSITORY-RESULT';
  const result = {
    kind: 'public-web',
    status: 'success',
    sources: [{ url: resultUrl, title: 'PRIVATE-MEETING source title', description: '', publishedAt: null }],
    pages: [],
    window: 'any',
    widened: false,
    retrievedAt: new Date().toISOString(),
    untrusted: true,
  };
  const sent = await store.send(workspace.id, userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Look up the related public page' }],
  });
  const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
    await executeTool(
      tool,
      true,
      async () => ({ result, sources: [] }),
      [],
      tool === 'web.fetch' ? { tool, url } : { tool, query: 'PRIVATE-MEETING-ACQUISITION', window: 'day', limit: 5 },
    );
    return 'Public lookup finished.';
  });
  assert.equal(
    await executor.process({ workspaceId: workspace.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
    'completed',
  );
  const call = (
    await f.db.platform.query(`SELECT call_id FROM ${f.table('tf_conversation_execution_steps')} WHERE turn_id=$1`, [
      sent.turnId,
    ])
  ).rows[0];
  const set = async (sources, outputSources, status, output = true) => {
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_execution_steps')} SET sources=$2,output=$3 WHERE call_id=$1`,
      [call.call_id, JSON.stringify(sources), output ? JSON.stringify({ result, sources: outputSources }) : null],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_tool_calls')} SET status=$2 WHERE id=$1`, [
      call.call_id,
      status,
    ]);
  };
  const history = () => createConversations(runtime).history(workspace.id, userId, chatId);
  const protectAnswer = async source => {
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_results')} SET sources=$2 WHERE turn_id=$1`, [
      sent.turnId,
      JSON.stringify([source]),
    ]);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_parts')} SET text='PRIVATE-MEETING answer' WHERE message_id IN (SELECT message_id FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1) AND kind='text'`,
      [sent.turnId],
    );
  };
  return { chatId, url, resultUrl, callId: call.call_id, result, set, history, protectAnswer };
}

async function assertRevocation(rows, source, revoke) {
  for (const row of rows) {
    await row.set([], [source(row)], 'completed');
    const history = await row.history();
    assert.ok(
      history.messages[0].tools[0].web.urls.includes(row.resultUrl),
      'authorized output sources remain visible',
    );
    assert.equal(history.messages[0].tools[0].web.sources[0].title, 'PRIVATE-MEETING source title');
    if (history.messages[0].tools[0].tool === 'web.search')
      assert.equal(history.messages[0].tools[0].web.query, 'PRIVATE-MEETING-ACQUISITION');
    await row.set([source(row)], [], 'running', false);
    const running = await row.history();
    if (running.messages[0].tools[0].tool === 'web.fetch')
      assert.deepEqual(running.messages[0].tools[0].web.urls, [row.url]);
    else assert.equal(running.messages[0].tools[0].web.query, 'PRIVATE-MEETING-ACQUISITION');
  }
  for (const row of rows) await row.protectAnswer(source(row));
  await revoke();
  for (const row of rows) {
    for (const status of ['running', 'completed', 'failed', 'blocked']) {
      for (const dependency of ['retained', 'output', 'both']) {
        if (status === 'running' && dependency === 'output') continue;
        await row.set(
          dependency !== 'output' ? [source(row)] : [],
          dependency !== 'retained' ? [source(row)] : [],
          status,
          status !== 'running',
        );
        const history = await row.history();
        assert.deepEqual(
          history.messages[0].tools[0].web,
          { status: 'failed', urls: [], failedUrls: [], widened: false },
          `${status}/${dependency}`,
        );
        assert.doesNotMatch(JSON.stringify(history), /PRIVATE-MEETING|PRIVATE-REPOSITORY/);
      }
    }
  }
}

test('Google revocation conceals retained and output-derived web URLs across running and terminal history', async () => {
  const f = await googleFixture();
  try {
    const status = await f.connect();
    const source = {
      kind: 'google-integration',
      integrationId: status.integrationId,
      accountId: status.accountId,
      membershipId: f.member.membershipId,
      generation: status.generation,
      scopes: [...status.scopes].sort(),
      requiredScopes: ['https://www.googleapis.com/auth/calendar'],
    };
    const rows = await Promise.all(
      ['web.fetch', 'web.search'].map(tool => seed(f, f.runtime, f.workspace, f.member.userId, tool)),
    );
    await assertRevocation(
      rows,
      () => source,
      () => f.service.disconnect(f.workspace.id, f.member.userId),
    );
  } finally {
    await f.close();
  }
});

test('GitHub disconnection conceals web URLs while preserving account selection authorization', async () => {
  const f = await githubFixture();
  let proofChecks = 0;
  const runtime = {
    transaction: (workspace, range, operation) =>
      f.runtime.transaction(workspace, range, tx =>
        operation({
          ...tx,
          requireGitHubSource: async () => {
            proofChecks++;
          },
        }),
      ),
  };
  try {
    const accountId = await f.connect();
    const rows = await Promise.all(
      ['web.fetch', 'web.search'].map(tool => seed(f, runtime, f.one, f.member.userId, tool)),
    );
    for (const row of rows)
      await createGitHubReads({ runtime: f.runtime, accounts: f.service }).select(
        f.one.id,
        f.member.userId,
        row.chatId,
        { accountId, expectedVersion: 0 },
      );
    const status = await f.service.status(f.one.id, f.member.userId, accountId);
    const source = row => ({
      kind: 'github-personal',
      accountId,
      membershipId: f.member.membershipId,
      generation: status.generation,
      selectionVersion: 1,
      conversationId: row.chatId,
      proof: {
        operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
        transport: 'rest',
        digest: 'a'.repeat(64),
      },
    });
    await assertRevocation(rows, source, () => f.service.disconnect(f.one.id, f.member.userId, accountId));
    assert.ok(proofChecks > 0, 'history invokes the provider proof authorizer as well as local selection checks');
  } finally {
    await f.close();
  }
});

test('persisted forbidden DNS suffixes and malformed provenance never expose receipt URLs', async () => {
  const f = await conversationFixture();
  try {
    const row = await seed(f, f.runtime, f.workspace, f.workspace.userId);
    for (const url of [
      'https://metadata.google.internal./',
      'https://web-api.internal.foo.azurecontainerapps.io./',
      'https://azurecontainerapps.io./',
      'https://metadata.google.internal%2e/',
    ]) {
      for (const status of ['running', 'completed', 'failed']) {
        await row.set([], [], status, status !== 'running');
        const result = { ...row.result, sources: [{ ...row.result.sources[0], url }] };
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_execution_steps')} SET call=$2,output=$3 WHERE call_id=$1`,
          [row.callId, { tool: 'web.fetch', url }, status === 'running' ? null : { result, sources: [] }],
        );
        const history = await row.history();
        assert.deepEqual(history.messages[0].tools[0].web.urls, []);
        assert.deepEqual(history.messages[0].tools[0].web.failedUrls, []);
        assert.equal(JSON.stringify(history).includes(url), false);
      }
    }
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_execution_steps')} SET call=$2 WHERE call_id=$1`, [
      row.callId,
      { tool: 'web.fetch', url: row.url },
    ]);
    for (const [retained, output] of [
      [[], { result: row.result }],
      [[{ kind: 'unknown' }], null],
    ]) {
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_execution_steps')} SET sources=$2,output=$3 WHERE call_id=$1`,
        [row.callId, JSON.stringify(retained), JSON.stringify(output)],
      );
      if (output !== null) {
        await assert.rejects(row.history(), error => error.name === 'ZodError');
        continue;
      }
      const history = await row.history();
      assert.deepEqual(history.messages[0].tools[0].web.urls, []);
    }
  } finally {
    await f.close();
  }
});
