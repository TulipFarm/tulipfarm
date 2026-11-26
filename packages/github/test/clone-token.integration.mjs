import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createConversations } from '../../conversations/dist/index.js';
import { githubFixture } from './fixture.mjs';

test('an approved coding run gets its clone token while its turn waits on it', async t => {
  const f = await githubFixture();
  try {
    const actor = { kind: 'human', ...f.member };
    const store = createConversations(f.runtime);
    const conversationId = randomUUID();
    await store.create(f.one.id, actor.userId, { chatId: conversationId, commandId: randomUUID() });
    await f.connect();
    const reads = createGitHubReads({
      runtime: f.runtime,
      accounts: f.service,
      fetcher: async () => Response.json({}),
    });
    const { turnId } = await store.send(f.one.id, actor.userId, conversationId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Fix the README.' }],
    });
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET status='waiting' WHERE id=$1`, [turnId]);
    const runId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_coding_runs')} (id,membership_id,user_id,conversation_id,turn_id,generation,agent,repository,task,plan_owner_membership_id,digest,expires_at)
       VALUES ($1,$2,$3,$4,$5,0,'claude-code','octocat/hello','Fix the README.',$2,$6,clock_timestamp()+interval '1 day')`,
      [runId, actor.membershipId, actor.userId, conversationId, turnId, 'a'.repeat(64)],
    );
    const origin = { conversationId, turnId, runId };
    const setRun = (sets, where = '') =>
      f.db.platform.query(`UPDATE ${f.table('tf_coding_runs')} SET ${sets} WHERE id=$1 ${where}`, [runId]);

    await t.test('a waiting turn without a run is refused', async () => {
      await assert.rejects(reads.cloneToken(f.one.id, actor, { conversationId, turnId }), AccessDenied);
    });
    await t.test('an undecided run is refused', async () => {
      await assert.rejects(reads.cloneToken(f.one.id, actor, origin), AccessDenied);
    });
    await t.test('the approved run, once running, gets the token', async () => {
      await setRun(
        `decision='approved',decision_command_id=gen_random_uuid(),decided_at=clock_timestamp(),status='running',started_at=clock_timestamp(),deadline_at=clock_timestamp()+interval '1 hour'`,
      );
      const result = await reads.cloneToken(f.one.id, actor, origin);
      assert.deepEqual(result, { token: 'synthetic-access-token', login: 'person-123' });
    });
    await t.test('a run of another turn is refused', async () => {
      await assert.rejects(reads.cloneToken(f.one.id, actor, { ...origin, turnId: randomUUID() }), AccessDenied);
    });
    await t.test('a finished run is refused', async () => {
      await setRun(`status='interrupted',finished_at=clock_timestamp()`);
      await assert.rejects(reads.cloneToken(f.one.id, actor, origin), AccessDenied);
    });
  } finally {
    await f.close();
  }
});

test('an active code session gets its clone token and refuses terminal or foreign sessions', async t => {
  const f = await githubFixture();
  try {
    const actor = { kind: 'human', ...f.member };
    await f.connect();
    const reads = createGitHubReads({
      runtime: f.runtime,
      accounts: f.service,
      fetcher: async () => Response.json({}),
    });
    const sessionId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_code_sessions')} (id, owner_membership_id, title, request, agent, repository, base_branch, session_branch, stage, reviewers, open_pull_requests, open_as_draft, budget_ms, workflow_id)
       VALUES ($1,$2,'Fix border','Change border to purple','copilot','octocat/hello','main','tulipfarm/fix-border','brainstorm','[]'::jsonb,true,false,14400000,$3)`,
      [sessionId, actor.membershipId, `code-session-${sessionId}`],
    );

    await t.test('an active code session gets the token even without a conversation origin', async () => {
      const result = await reads.codeSessionToken(f.one.id, actor, sessionId);
      assert.deepEqual(result, { token: 'synthetic-access-token', login: 'person-123' });
    });

    await t.test('an unknown session is refused', async () => {
      await assert.rejects(reads.codeSessionToken(f.one.id, actor, randomUUID()), AccessDenied);
    });

    await t.test('a terminal code session is refused', async () => {
      await f.db.platform.query(`UPDATE ${f.table('tf_code_sessions')} SET stage='failed' WHERE id=$1`, [sessionId]);
      await assert.rejects(reads.codeSessionToken(f.one.id, actor, sessionId), AccessDenied);
    });
  } finally {
    await f.close();
  }
});
