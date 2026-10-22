import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { GitHubCredentialRejected, githubCompatibility } from '@tulipfarm/github';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createGitHubCorpusProvider } from '@tulipfarm/github/corpus';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { createConversations } from '../../conversations/dist/index.js';
import { githubFixture } from './fixture.mjs';

async function promptly(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Database authority operation blocked by provider read')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function gate() {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  return {
    ready: entered.promise,
    release: released.resolve,
    async wait() {
      entered.resolve();
      await released.promise;
    },
  };
}

test('read credentials release database locks and fence in-flight account changes', async t => {
  const f = await githubFixture();
  try {
    let identity = 1000;
    const workspace = f.one.id,
      user = f.member.userId;
    const authority = () => f.runtime.transaction(workspace, githubCompatibility, tx => lockAuthorization(tx, 'write'));
    await t.test('happy read permits an unrelated workspace authority write during provider work', async () => {
      const id = await f.connect(identity++);
      const blocked = gate();
      const pending = f.service.withReadCredential(workspace, user, id, async () => {
        await blocked.wait();
        return 'read-result';
      });
      try {
        await blocked.ready;
        await promptly(authority());
      } finally {
        blocked.release();
      }
      assert.equal(await pending, 'read-result');
    });
    for (const change of ['disconnect', 'generation', 'expiry', 'configuration', 'credential-rejected']) {
      await t.test(`${change} discards a result fetched under old authority`, async () => {
        const id = await f.connect(identity++);
        const blocked = gate();
        const pending = f.service.withReadCredential(workspace, user, id, async () => {
          await blocked.wait();
          if (change === 'credential-rejected') throw new GitHubCredentialRejected();
          return 'must-not-escape';
        });
        const rejected = assert.rejects(pending, /account-reconnect-required/);
        try {
          await blocked.ready;
          if (change === 'disconnect') await promptly(f.service.disconnect(workspace, user, id));
          if (change === 'generation') await promptly(f.service.reconnect(workspace, user, 'test-session', id));
          if (change === 'expiry')
            await f.db.platform.query(
              `UPDATE ${f.table('tf_github_accounts')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
              [id],
            );
          if (change === 'configuration')
            await f.db.platform.query(`UPDATE ${f.table('tf_github_accounts')} SET config_hash='changed' WHERE id=$1`, [
              id,
            ]);
        } finally {
          blocked.release();
        }
        await rejected;
        const status = await f.service.status(workspace, user, id);
        assert.equal(
          status.state,
          change === 'disconnect' ? 'disconnected' : change === 'generation' ? 'authorizing' : 'reconnect-required',
        );
      });
    }
    await t.test('an old provider rejection cannot invalidate a newly connected generation', async () => {
      const id = await f.connect(identity++);
      const blocked = gate();
      const pending = f.service.withReadCredential(workspace, user, id, async () => {
        await blocked.wait();
        throw new GitHubCredentialRejected();
      });
      const rejected = assert.rejects(pending, /account-reconnect-required/);
      try {
        await blocked.ready;
        const next = await promptly(f.service.reconnect(workspace, user, 'test-session', id));
        await f.complete({ state: new URL(next.url).searchParams.get('state') });
      } finally {
        blocked.release();
      }
      await rejected;
      assert.equal((await f.service.status(workspace, user, id)).state, 'active');
      assert.equal(await f.service.withReadCredential(workspace, user, id, async () => 'new-result'), 'new-result');
    });
    await t.test('completion access failures propagate rather than returning provider data', async () => {
      const id = await f.connect(identity++);
      let allowed = true;
      await assert.rejects(
        f.service.withReadCredential(
          workspace,
          user,
          id,
          async () => {
            allowed = false;
            return 'must-not-escape';
          },
          undefined,
          async () => {
            if (!allowed) throw new AccessDenied();
          },
        ),
        AccessDenied,
      );
    });
    await t.test('removal and re-addition cannot substitute a new membership for an in-flight reader', async () => {
      const id = await f.connect(identity++);
      const blocked = gate();
      const pending = f.service.withReadCredential(workspace, user, id, async () => {
        await blocked.wait();
        return 'must-not-escape';
      });
      const rejected = assert.rejects(pending, AccessDenied);
      try {
        await blocked.ready;
        await promptly(authority());
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          f.member.membershipId,
        ]);
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`,
          [randomUUID(), user],
        );
      } finally {
        blocked.release();
      }
      await rejected;
    });
  } finally {
    await f.close();
  }
});

test('personal provider reads check current selection before returning and never hold the authority lock over fetch', async t => {
  const f = await githubFixture();
  try {
    const actor = { kind: 'human', ...f.member };
    const store = createConversations(f.runtime);
    const conversationId = randomUUID();
    await store.create(f.one.id, actor.userId, { chatId: conversationId, commandId: randomUUID() });
    const accountId = await f.connect();
    const blocked = gate();
    const reads = createGitHubReads({
      runtime: f.runtime,
      accounts: f.service,
      fetcher: async () => {
        await blocked.wait();
        return Response.json({ id: 1, name: 'private' });
      },
    });
    await reads.select(f.one.id, actor.userId, conversationId, { accountId, expectedVersion: 0 });
    const sent = await store.send(f.one.id, actor.userId, conversationId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Read the repository.' }],
    });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
      [sent.turnId],
    );
    const pending = reads.read(
      f.one.id,
      actor,
      { conversationId, turnId: sent.turnId },
      { kind: 'repository.read', owner: 'octocat', repo: 'private' },
    );
    const rejected = assert.rejects(pending, AccessDenied);
    try {
      await blocked.ready;
      await promptly(f.runtime.transaction(f.one.id, githubCompatibility, tx => lockAuthorization(tx, 'write')));
      await f.db.platform.query(
        `UPDATE ${f.table('tf_github_chat_selection')} SET version=version+1 WHERE conversation_id=$1`,
        [conversationId],
      );
    } finally {
      blocked.release();
    }
    await rejected;
    assert.equal(
      (
        await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_conversation_results')} WHERE conversation_id=$1`, [
          conversationId,
        ])
      ).rowCount,
      0,
    );
    await t.test('unchanged selection returns the fetched read', async () => {
      const result = await reads.read(
        f.one.id,
        actor,
        { conversationId, turnId: sent.turnId },
        { kind: 'repository.read', owner: 'octocat', repo: 'private' },
      );
      assert.equal(result.result.data.id, 1);
    });
  } finally {
    await f.close();
  }
});

test('corpus provider fetch releases authority locks and discards data after disconnect', async () => {
  const f = await githubFixture();
  try {
    const accountId = await f.connect();
    const blocked = gate();
    const provider = createGitHubCorpusProvider({
      accounts: f.service,
      fetcher: async () => {
        await blocked.wait();
        return Response.json([]);
      },
    });
    const pending = provider.discover(f.one.id, f.member.userId, accountId);
    const rejected = assert.rejects(pending, /reconnect-required/);
    try {
      await blocked.ready;
      await promptly(f.runtime.transaction(f.one.id, githubCompatibility, tx => lockAuthorization(tx, 'write')));
      await promptly(f.service.disconnect(f.one.id, f.member.userId, accountId));
    } finally {
      blocked.release();
    }
    await rejected;
  } finally {
    await f.close();
  }
});

test('prepared and served downloads fetch bytes outside authority locks and discard revoked access', async () => {
  const f = await githubFixture();
  const originalFetch = globalThis.fetch;
  try {
    const actor = { kind: 'human', ...f.member };
    const conversationId = randomUUID(),
      messageId = randomUUID(),
      callId = randomUUID();
    const store = createConversations(f.runtime);
    await store.create(f.one.id, actor.userId, { chatId: conversationId, commandId: randomUUID() });
    const accountId = await f.connect();
    const metadata = { id: 1, name: 'fixture.zip', size: 4 };
    globalThis.fetch = async () => Response.json(metadata);
    const runtime = withGitHubSourceAuthorization(f.runtime, {
      INTEGRATION_CREDENTIAL_KEY_ID: 'test',
      INTEGRATION_CREDENTIAL_KEY: f.keyring.keys.test,
      GITHUB_OAUTH_CLIENT_ID: f.configuration.clientId,
      GITHUB_OAUTH_CLIENT_SECRET: f.configuration.clientSecret,
      GITHUB_OAUTH_REDIRECT_URI: f.configuration.redirectUri,
      GITHUB_OAUTH_SCOPES: f.configuration.scopes.join(' '),
    });
    let blocked = gate();
    const reads = createGitHubReads({
      runtime,
      accounts: f.makeService({ runtime }),
      fetcher: async (_url, init) => {
        if (new Headers(init.headers).get('accept') !== 'application/octet-stream') return Response.json(metadata);
        await blocked.wait();
        return new Response('data');
      },
    });
    await reads.select(f.one.id, actor.userId, conversationId, { accountId, expectedVersion: 0 });
    const sent = await store.send(f.one.id, actor.userId, conversationId, {
      commandId: randomUUID(),
      messageId,
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Download the release.' }],
    });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
      [sent.turnId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'github.personal.download','running')`,
      [callId, conversationId, sent.turnId],
    );
    const prepare = () =>
      reads.prepareDownload(f.one.id, actor, { conversationId, turnId: sent.turnId }, callId, {
        kind: 'release.download',
        owner: 'octocat',
        repo: 'private',
        id: 1,
      });
    const authority = () => f.runtime.transaction(f.one.id, githubCompatibility, tx => lockAuthorization(tx, 'write'));
    const pending = prepare();
    try {
      await blocked.ready;
      await promptly(authority());
    } finally {
      blocked.release();
    }
    const prepared = await pending;
    assert.equal(prepared.result.size, 4);
    assert.equal(prepared.result.filename, 'fixture.zip');

    blocked = gate();
    const stale = prepare();
    const staleRejected = assert.rejects(stale, AccessDenied);
    try {
      await blocked.ready;
      await promptly(authority());
      await f.db.platform.query(
        `UPDATE ${f.table('tf_github_chat_selection')} SET version=version+1 WHERE conversation_id=$1`,
        [conversationId],
      );
    } finally {
      blocked.release();
    }
    await staleRejected;
    const current = await prepare();
    const responseId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind) VALUES ($1,$2,2,'assistant')`,
      [responseId, conversationId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_results')} (conversation_id,turn_id,message_id,sources) VALUES ($1,$2,$3,$4)`,
      [conversationId, sent.turnId, responseId, JSON.stringify(current.sources)],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_tool_calls')} SET status='completed' WHERE id=$1`, [
      callId,
    ]);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET status='completed',lease_until=NULL,response_message_id=$2 WHERE id=$1`,
      [sent.turnId, responseId],
    );
    assert.equal((await reads.download(f.one.id, actor.userId, conversationId, callId)).bytes.toString(), 'data');

    blocked = gate();
    const download = reads.download(f.one.id, actor.userId, conversationId, callId);
    const rejected = assert.rejects(download, AccessDenied);
    try {
      await blocked.ready;
      await promptly(authority());
      await promptly(f.service.disconnect(f.one.id, actor.userId, accountId));
    } finally {
      blocked.release();
    }
    await rejected;
  } finally {
    globalThis.fetch = originalFetch;
    await f.close();
  }
});
