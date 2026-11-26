import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, remoteSourceCheckLimits, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { createConversations } from '../../conversations/dist/index.js';
import { createConversationRequests } from '../../conversations/dist/requests.js';
import { githubFixture } from './fixture.mjs';

const issues = first => ({
  total_count: 30,
  incomplete_results: false,
  items: Array.from({ length: 30 }, (_, index) => ({
    url: `https://api.github.com/repos/octocat/private/issues/${first + index}`,
    html_url: `https://github.com/octocat/private/issues/${first + index}`,
    number: first + index,
    title: 'Issue',
    state: 'open',
    comments: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })),
});

test('review requests over many GitHub search results open, survive unavailable checks and close only on denial', async () => {
  const f = await githubFixture();
  const originalFetch = globalThis.fetch;
  const originalLimits = { ...remoteSourceCheckLimits };
  try {
    const actor = { kind: 'human', ...f.member };
    const chatId = randomUUID();
    const plain = createConversations(f.runtime);
    await plain.create(f.one.id, actor.userId, { chatId, commandId: randomUUID() });
    const accountId = await f.connect();
    const reads = createGitHubReads({
      runtime: f.runtime,
      accounts: f.service,
      fetcher: async url => Response.json(issues(String(url).includes('second') ? 31 : 1)),
    });
    await reads.select(f.one.id, actor.userId, chatId, { accountId, expectedVersion: 0 });
    const sent = await plain.send(f.one.id, actor.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Find the issues.' }],
    });
    const turn = (
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1 RETURNING generation,attempt_epoch`,
        [sent.turnId],
      )
    ).rows[0];
    // Two issue searches of 30 results each need 62 GitHub reads to recheck, more than one call's old shared 32.
    const sources = [];
    for (const query of ['first', 'second'])
      sources.push(
        ...(
          await reads.read(
            f.one.id,
            actor,
            { conversationId: chatId, turnId: sent.turnId },
            { kind: 'issue.search', query },
          )
        ).sources,
      );
    const producerId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'present.choice','completed')`,
      [producerId, chatId, sent.turnId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_execution_steps')} (call_id,turn_id,call,sources,output) VALUES ($1,$2,'{}','[]',$3)`,
      [producerId, sent.turnId, JSON.stringify({ sources })],
    );
    const { requestId } = await createConversationRequests(f.runtime).createForChat(
      {
        workspaceId: f.one.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: turn.generation,
        epoch: turn.attempt_epoch,
      },
      { producerId, prompt: 'Which issue?', answerSchema: { kind: 'text' } },
    );

    let mode = 'ok';
    let rereads = 0;
    globalThis.fetch = async input => {
      rereads++;
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (mode === 'rate-limited')
        return Response.json({ message: 'rate limited' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      if (mode === 'revoked' && url.pathname.startsWith('/repos/'))
        return Response.json({ message: 'Not Found' }, { status: 404 });
      if (url.pathname.startsWith('/search/')) return Response.json(issues(url.search.includes('second') ? 31 : 1));
      return Response.json({ url: url.href, number: Number(url.pathname.split('/').at(-1)) });
    };
    const requests = createConversationRequests(
      withGitHubSourceAuthorization(f.runtime, {
        INTEGRATION_CREDENTIAL_KEY_ID: 'test',
        INTEGRATION_CREDENTIAL_KEY: f.keyring.keys.test,
        GITHUB_OAUTH_CLIENT_ID: f.configuration.clientId,
        GITHUB_OAUTH_CLIENT_SECRET: f.configuration.clientSecret,
        GITHUB_OAUTH_REDIRECT_URI: f.configuration.redirectUri,
      }),
    );
    const read = () => requests.read(f.one.id, actor.userId, chatId, requestId);
    const state = async () =>
      (
        await f.db.platform.query(
          `SELECT r.status AS request, t.status AS turn FROM ${f.table('tf_conversation_requests')} r JOIN ${f.table('tf_conversation_turns')} t ON t.id=r.turn_id WHERE r.id=$1`,
          [requestId],
        )
      ).rows[0];

    assert.equal((await read()).status, 'pending');
    assert.equal(rereads, 62, 'every search target is reread once');

    // A recently passed check is reused, so repeated loads don't reread GitHub, until it is older than the bound.
    assert.equal((await read()).status, 'pending');
    assert.equal(rereads, 62);
    remoteSourceCheckLimits.reuseMilliseconds = 0;
    assert.equal((await read()).status, 'pending');
    assert.equal(rereads, 124);

    // GitHub rate limiting and a spent check budget are retryable and leave the review open.
    mode = 'rate-limited';
    await assert.rejects(read(), error => error instanceof SourceAuthorizationUnavailable);
    mode = 'ok';
    remoteSourceCheckLimits.checks = 1;
    await assert.rejects(read(), error => error instanceof SourceAuthorizationUnavailable);
    remoteSourceCheckLimits.checks = originalLimits.checks;
    assert.deepEqual(await state(), { request: 'pending', turn: 'waiting' });

    // A real denial still closes the review, and says why.
    mode = 'revoked';
    await assert.rejects(
      read(),
      error =>
        error instanceof AccessDenied &&
        !(error instanceof SourceAuthorizationUnavailable) &&
        error.code === 'source-access-revoked',
    );
    assert.equal((await state()).turn, 'completed');
    assert.match(
      JSON.stringify((await plain.history(f.one.id, actor.userId, chatId)).messages.at(-1)),
      /review request could not be opened/,
    );
  } finally {
    Object.assign(remoteSourceCheckLimits, originalLimits);
    globalThis.fetch = originalFetch;
    await f.close();
  }
});
