import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { slackUserCall } from '../../slack/test/web-api-fixture.mjs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskProgress } from '../src/task-progress.ts';
import { createSlackActions, createSlackActionDecision } from '../src/slack-actions.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createSlackChannelAgents } from '../src/slack-channels.ts';
import { createSlackInbox } from '../../slack/src/inbox.ts';
import { syntheticContinuity } from './continuity-fixture.mjs';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createChatTools } from '../src/tools.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createSlackDefault } from '../src/slack-default.ts';
import { createSlackDirectMessages } from '../../slack/src/direct-messages.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { outboundFixture } from './slack-actions-fixture.mjs';

export { outboundFixture };

test('outbound fixture binds supplied actors before Slack identities and grants', async () => {
  const aliceUserId = randomUUID(),
    bobUserId = randomUUID();
  let closed = 0;
  const f = await outboundFixture({
    prepareActors: async () => ({
      aliceUserId,
      bobUserId,
      close: async () => {
        closed++;
      },
    }),
  });
  try {
    assert.equal(f.alice.userId, aliceUserId);
    assert.equal(f.bob.userId, bobUserId);
    const identities = (
      await f.db.platform.query(`SELECT user_id,membership_id FROM ${f.table('tf_slack_identities')}`)
    ).rows;
    for (const actor of [f.alice, f.bob])
      assert.ok(identities.some(row => row.user_id === actor.userId && row.membership_id === actor.membershipId));
    const commands = (
      await f.db.platform.query(`SELECT user_id,membership_id FROM ${f.table('tf_agent_commands')} WHERE agent_id=$1`, [
        f.agentId,
      ])
    ).rows;
    assert.ok(commands.length);
    assert.ok(commands.every(row => row.user_id === aliceUserId && row.membership_id === f.alice.membershipId));
  } finally {
    await f.close();
  }
  assert.equal(closed, 1);
});

test('shared executor sends all three bounded operations with isolated requester tokens and durable restart receipts', async () => {
  const f = await outboundFixture();
  try {
    for (const [actor, tool] of [
      [f.alice, 'slack.message.send'],
      [f.bob, 'slack.thread.reply'],
      [f.bob, 'slack.reaction.add'],
    ]) {
      const { ids } = await f.queue(actor, tool);
      assert.equal(await f.executor.execute(ids), 'completed');
      assert.equal((await f.service.read(f.workspace.id, actor.userId, ids.callId)).status, 'sent');
      const restarted = createAgentExecutor({
        runtime: f.runtime,
        slack: runtime => createSlackActions({ ...f.settings, runtime }),
      });
      assert.equal(await restarted.execute(ids), 'completed');
    }
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-alice', name: 'send', channel: 'CHR', text: 'Approved HR update' },
      { token: 'Bearer xoxp-bob', name: 'reply', channel: 'CHR', text: 'Thread update', ts: '1.000001' },
      { token: 'Bearer xoxp-bob', name: 'react', channel: 'CHR', reaction: 'white_check_mark', ts: '1.000001' },
    ]);
  } finally {
    await f.close();
  }
});

test('agent Slack actions send directly even when stored destination and agent flags still ask for approval', async () => {
  const f = await outboundFixture();
  try {
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_destinations')} SET approval_required=true`);
    await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET slack_approval='required' WHERE id=$1`, [f.agentId]);
    for (const tool of ['slack.message.send', 'slack.thread.reply', 'slack.reaction.add']) {
      const { ids } = await f.queue(f.alice, tool);
      assert.equal(await f.executor.execute(ids), 'completed');
      const action = await f.service.read(f.workspace.id, f.alice.userId, ids.callId);
      assert.equal(action.approvalRequired, false);
      assert.equal(action.status, 'sent');
      await assert.rejects(
        f.decide(f.workspace.id, f.alice.userId, ids.callId, { digest: action.digest, decision: 'approve' }),
        /slack-decision-conflict/,
      );
    }
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_slack_action_decisions')}`)).rows[0].n,
      0,
    );
    assert.equal(f.effects.length, 3);
    assert.equal(f.cards.length, 0);
    const version = (
      await f.db.platform.query(`SELECT policy_version FROM ${f.table('tf_agents')} WHERE id=$1`, [f.agentId])
    ).rows[0].policy_version;
    await assert.rejects(
      f.executor.configure(
        f.workspace.id,
        { kind: 'human', ...f.alice },
        { agentId: f.agentId, version, enabled: true, teamIds: [f.teamId], limits: f.scope, slackApproval: 'required' },
      ),
      { name: 'ZodError' },
    );
  } finally {
    await f.close();
  }
});

test('legacy pending action: preapproval membership 429 recovers the original proposal, waits for consent and sends once across restart', async () => {
  const f = await outboundFixture();
  let throttled = false;
  const settings = {
    ...f.settings,
    fetcher: async (url, init) => {
      if (!throttled && slackUserCall(url, init) === 'conversations.members') {
        throttled = true;
        return new Response('', { status: 429, headers: { 'retry-after': '1' } });
      }
      return f.settings.fetcher(url, init);
    },
  };
  const executor = createAgentExecutor({
    runtime: f.runtime,
    slack: runtime => createSlackActions({ ...settings, runtime }),
  });
  try {
    await f.legacyApproval();
    const { ids } = await f.queue();
    assert.equal(await executor.execute(ids), 'waiting');
    const original = await f.service.read(f.workspace.id, f.alice.userId, ids.callId);
    assert.equal(original.status, 'retry');
    assert.equal(f.effects.length, 0);
    assert.equal(f.cards.length, 0);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_action_effects')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE action_id=$1`,
      [ids.callId],
    );
    assert.equal(await executor.execute(ids), 'waiting');
    const recovered = await f.service.read(f.workspace.id, f.alice.userId, ids.callId);
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.digest, original.digest);
    assert.deepEqual(recovered.action, original.action);
    assert.equal(f.cards.length, 1);
    assert.equal(f.effects.length, 0);
    assert.equal(
      (await f.decide(f.workspace.id, f.alice.userId, ids.callId, { digest: original.digest, decision: 'approve' }))
        .status,
      'approved',
    );
    assert.equal(await executor.execute(ids), 'completed');
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-alice', name: 'send', channel: 'CHR', text: 'Approved HR update' },
    ]);
    const runtime = f.createRuntime();
    try {
      const restarted = createAgentExecutor({
        runtime,
        slack: runtime => createSlackActions({ ...settings, runtime }),
      });
      assert.equal(await restarted.execute(ids), 'completed');
    } finally {
      await runtime.close();
    }
    assert.equal(f.effects.length, 1);
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, ids.callId)).status, 'sent');
  } finally {
    await f.close();
  }
});

for (const rotating of [false, true])
  test(`outbound HTTP 401 exposes same-identity reconnect for ${rotating ? 'unexpired rotating' : 'nonrotating'} credentials and fences old approval`, async () => {
    const f = await outboundFixture();
    try {
      await f.legacyApproval();
      const old = await f.queue();
      assert.equal(await f.executor.execute(old.ids), 'waiting');
      const proposed = await f.service.read(f.workspace.id, f.alice.userId, old.ids.callId);
      assert.equal(
        (
          await f.decide(f.workspace.id, f.alice.userId, old.ids.callId, {
            digest: proposed.digest,
            decision: 'approve',
          })
        ).status,
        'approved',
      );
      const identity = (
        await f.db.platform.query(`SELECT * FROM ${f.table('tf_slack_identities')} WHERE user_id=$1`, [f.alice.userId])
      ).rows[0];
      if (rotating)
        await f.db.platform.query(`UPDATE ${f.table('tf_slack_identities')} SET credential=$2 WHERE id=$1`, [
          identity.id,
          {
            ...identity.credential,
            rotation: {
              state: 'ready',
              expiresAt: Date.now() + 3600000,
              refresh: f.settings.cipher.encrypt(
                {
                  workspaceId: f.workspace.id,
                  installationId: f.installationId,
                  generation: 1,
                  kind: 'user',
                  identityId: identity.id,
                  membershipId: f.alice.membershipId,
                  slackUserId: 'UALICE',
                },
                'xoxe-unused',
              ),
            },
          },
        ]);
      const untouched = (
        await f.db.platform.query(`SELECT credential FROM ${f.table('tf_slack_identities')} WHERE user_id=$1`, [
          f.bob.userId,
        ])
      ).rows[0].credential;
      f.setMode('auth');
      await f.executor.execute(old.ids);
      assert.equal(
        (await f.service.read(f.workspace.id, f.alice.userId, old.ids.callId)).status,
        'reauthorization-required',
      );
      const eventId = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_events')}(id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition)VALUES($1::uuid,$2,1,$1::text,'reconnect',1,$3,'held')`,
        [
          eventId,
          f.installationId,
          { type: 'message', channel: 'DALICE', user: 'UALICE', ts: '8.000001', text: 'renew Slack access' },
        ],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_continuations')}(event_id,identity_id,state)VALUES($1,$2,'dispatch-held')`,
        [eventId, identity.id],
      );
      const { createSlackMemberLinking, createSlackInstallations, createSlackRecovery } =
        await import('../../slack/src/index.ts');
      const { memberProviderFixture } = await import('../../slack/test/member-provider-fixture.mjs');
      const config = {
        appId: 'ATEST',
        clientId: 'client',
        clientSecret: 'synthetic',
        signingSecret: 'synthetic-signing-secret',
        redirectUri: 'https://api.example.test/oauth',
        scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
        memberLinking: {
          identityRedirectUri: 'https://api.example.test/identity',
          operationalRedirectUri: 'https://api.example.test/operational',
          distribution: 'internal',
          scopeApproval: {
            reference: 'test',
            userScopes: [
              'channels:history',
              'groups:history',
              'im:history',
              'mpim:history',
              'chat:write',
              'reactions:write',
            ],
          },
        },
      };
      const provider = await memberProviderFixture(config);
      const linker = createSlackMemberLinking({
        runtime: f.runtime,
        config,
        cipher: f.settings.cipher,
        installations: {
          route: async () => ({ workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 }),
        },
        fetcher: provider.fetcher,
      });
      const installations = createSlackInstallations({
        runtime: f.runtime,
        config,
        cipher: f.settings.cipher,
        pool: {
          query: async () => ({
            rows: [
              {
                workspace_id: f.workspace.id,
                installation_id: f.installationId,
                app_id: 'ATEST',
                generation: 1,
                state: 'active',
                team_id: 'TTEST',
                session_id: 'session',
                user_id: f.alice.userId,
                membership_id: f.alice.membershipId,
              },
            ],
          }),
        },
      });
      assert.equal((await installations.status(f.workspace.id, f.alice.userId)).recoveryEventId, eventId);
      assert.deepEqual(await linker.status(f.workspace.id, eventId, f.alice.userId), {
        state: 'reconnect-required',
        execution: 'disabled',
      });
      assert.equal((await installations.status(f.workspace.id, f.bob.userId)).recoveryEventId, undefined);
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT credential FROM ${f.table('tf_slack_identities')} WHERE user_id=$1`, [
            f.bob.userId,
          ])
        ).rows[0].credential,
        untouched,
      );
      assert.deepEqual(
        await createSlackRecovery({
          runtime: f.runtime,
          config,
          cipher: f.settings.cipher,
          fetcher: async () => assert.fail('auth rejection must require consent, not refresh'),
        }).refresh(f.workspace.id),
        [],
      );
      f.setMode('success');
      const flow = await linker.begin(f.workspace.id, eventId, f.alice.userId, 'session'),
        url = new URL(flow.url),
        state = url.searchParams.get('state');
      provider.set({ nonce: url.searchParams.get('nonce'), team: 'TTEST', user: 'UALICE', token: 'xoxe.xoxp-alice' });
      await linker.proveIdentity(state, flow.browser, 'identity');
      await linker.consent(state, flow.browser, f.alice.userId, 'session');
      await linker.complete(state, flow.browser, 'operational', f.alice.userId, 'session');
      assert.equal((await f.service.read(f.workspace.id, f.alice.userId, old.ids.callId)).status, 'stale');
      await f.executor.execute(old.ids);
      assert.equal(f.effects.length, 0);
      await f.legacyApproval(false);
      const renewed = await f.queue();
      assert.equal(await f.executor.execute(renewed.ids), 'completed');
      assert.equal((await f.service.read(f.workspace.id, f.alice.userId, renewed.ids.callId)).approvalRequired, false);
      assert.equal((await installations.status(f.workspace.id, f.alice.userId)).recoveryEventId, undefined);
      assert.deepEqual(f.effects, [
        { token: 'Bearer xoxe.xoxp-alice', name: 'send', channel: 'CHR', text: 'Approved HR update' },
      ]);
    } finally {
      await f.close();
    }
  });

test('rotated user credentials execute a Slack operation after expired bot and user recovery', async () => {
  const f = await outboundFixture();
  try {
    const { createSlackRecovery } = await import('../../slack/src/index.ts');
    const identities = (await f.db.platform.query(`SELECT * FROM ${f.table('tf_slack_identities')}`)).rows;
    for (const row of identities) {
      const binding = {
        workspaceId: f.workspace.id,
        installationId: f.installationId,
        generation: 1,
        kind: 'user',
        identityId: row.id,
        membershipId: row.membership_id,
        slackUserId: row.slack_user_id,
      };
      await f.db.platform.query(`UPDATE ${f.table('tf_slack_identities')} SET credential=$2 WHERE id=$1`, [
        row.id,
        {
          ...row.credential,
          rotation: {
            state: 'ready',
            expiresAt: Date.now() - 1000,
            refresh: f.settings.cipher.encrypt(binding, `xoxe-${row.slack_user_id}`),
          },
        },
      ]);
    }
    const bot = (await f.db.platform.query(`SELECT bot_credential FROM ${f.table('tf_slack_installations')}`)).rows[0]
      .bot_credential;
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET bot_credential=$1`, [
      {
        ...bot,
        rotation: {
          state: 'ready',
          expiresAt: Date.now() - 1000,
          refresh: f.settings.cipher.encrypt(
            { workspaceId: f.workspace.id, installationId: f.installationId, generation: 1, kind: 'bot' },
            'xoxe-UBOT',
          ),
        },
      },
    ]);
    const recovery = createSlackRecovery({
      runtime: f.runtime,
      cipher: f.settings.cipher,
      config: { appId: 'ATEST', clientId: 'fixture', clientSecret: 'fixture' },
      fetcher: async (url, init) => {
        if (String(url).endsWith('/auth.test')) {
          const token = new Headers(init.headers).get('authorization'),
            user = { 'Bearer xoxe.xoxp-alice': 'UALICE', 'Bearer xoxe.xoxp-bob': 'UBOB' }[token],
            row = identities.find(row => row.slack_user_id === user);
          return Response.json(
            { ok: true, team_id: 'TTEST', user_id: user },
            { headers: { 'x-oauth-scopes': row.scopes.join(',') } },
          );
        }
        const user = new URLSearchParams(init.body).get('refresh_token').slice(5),
          bot = user === 'UBOT';
        return Response.json({
          ok: true,
          team: { id: 'TTEST' },
          access_token: bot ? 'xoxe.xoxb-renewed' : `xoxe.xoxp-${user === 'UALICE' ? 'alice' : 'bob'}`,
          refresh_token: `xoxe-${user}-new`,
          expires_in: 43200,
          ...(bot
            ? { app_id: 'ATEST', token_type: 'bot', bot_user_id: user, scope: 'chat:write,im:write' }
            : { token_type: 'bearer' }),
        });
      },
    });
    assert.equal((await recovery.refresh(f.workspace.id)).length, 3);
    const { ids } = await f.queue();
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxe.xoxp-alice', name: 'send', channel: 'CHR', text: 'Approved HR update' },
    ]);
  } finally {
    await f.close();
  }
});

for (const fence of ['credential', 'generation'])
  test(`late Slack 401 cannot mark a replacement ${fence} for reconnect`, async () => {
    const f = await outboundFixture();
    try {
      const { createChannelProvider } = await import('../../slack/src/index.ts');
      const actor = { kind: 'human', ...f.alice };
      const identity = (
        await f.db.platform.query(`SELECT * FROM ${f.table('tf_slack_identities')} WHERE user_id=$1`, [actor.userId])
      ).rows[0];
      const replacement = f.settings.cipher.encrypt(
        {
          workspaceId: f.workspace.id,
          installationId: f.installationId,
          generation: 1,
          kind: 'user',
          identityId: identity.id,
          membershipId: actor.membershipId,
          slackUserId: 'UALICE',
        },
        'xoxe.xoxp-alice',
      );
      await f.runtime.transaction(f.workspace.id, commonCompatibility, async tx => {
        const provider = createChannelProvider({
          ...f.settings,
          fetcher: async (url, init) => {
            if (slackUserCall(url, init) === 'chat.postMessage') {
              if (fence === 'credential')
                await tx.client.query(`UPDATE ${f.table('tf_slack_identities')} SET credential=$2 WHERE id=$1`, [
                  identity.id,
                  replacement,
                ]);
              else
                await tx.client.query(`UPDATE ${f.table('tf_slack_installations')} SET generation=2 WHERE id=$1`, [
                  f.installationId,
                ]);
              return new Response('', { status: 401 });
            }
            return f.settings.fetcher(url, init);
          },
        });
        await assert.rejects(
          provider.dispatch(
            tx,
            f.workspace.id,
            actor,
            { installationId: f.installationId, generation: 1, channel: 'CHR', rootTs: '0.000000' },
            { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Fenced request' },
            async () => {},
          ),
          error => error.code === 'provider-auth-rejected',
        );
      });
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT credential FROM ${f.table('tf_slack_identities')} WHERE id=$1`, [
            identity.id,
          ])
        ).rows[0].credential,
        fence === 'credential' ? replacement : identity.credential,
      );
      assert.equal(f.effects.length, 0);
    } finally {
      await f.close();
    }
  });

test('default conversation sends directly despite a stored destination flag, and a legacy pending action resumes without earlier tools', async () => {
  const f = await outboundFixture();
  try {
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    for (const legacy of [false, true]) {
      if (legacy) await f.legacyApproval();
      else
        await f.db.platform.query(
          `UPDATE ${f.table('tf_slack_destinations')} SET approval_required=true,version=version+1`,
        );
      const chatId = randomUUID();
      await f.store.create(f.workspace.id, f.bob.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(f.workspace.id, f.bob.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Send this exact public HR update' }],
      });
      let priorCalls = 0;
      const reply = async ({ executeTool }) => {
        await executeTool('skills.list', false, async () => {
          priorCalls++;
          return { result: { skills: [] }, sources: [] };
        });
        const result = await executeTool('slack.message.send', true, context =>
          createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
            tool: 'slack.message.send',
            destinationId: f.destinationId,
            text: 'Public update from Bob',
          }),
        );
        assert.equal(result.result.status, 'sent');
        return { text: 'Slack confirmed the action.', sources: [] };
      };
      const engine = createConversationExecutor(f.runtime, reply, undefined, factory(f.runtime).resumeConversation);
      const work = { workspaceId: f.workspace.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      assert.equal(await engine.process(work), legacy ? 'idle' : 'completed');
      assert.equal(priorCalls, 1);
      const id = (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_conversation_actions')} WHERE turn_id=$1`, [
          sent.turnId,
        ])
      ).rows[0].id;
      assert.equal((await factory(f.runtime).read(f.workspace.id, f.bob.userId, id)).approvalRequired, legacy);
      if (legacy) {
        const proposal = await factory(f.runtime).read(f.workspace.id, f.bob.userId, id);
        assert.equal(proposal.status, 'pending');
        await assert.rejects(
          f.decide(f.workspace.id, f.alice.userId, id, { digest: proposal.digest, decision: 'approve' }),
        );
        await f.decide(f.workspace.id, f.bob.userId, id, { digest: proposal.digest, decision: 'approve' });
        const runtime = f.createRuntime();
        try {
          const resumed = createConversationExecutor(
            runtime,
            async () => assert.fail('must not replay earlier tools'),
            undefined,
            factory(runtime).resumeConversation,
          );
          assert.equal(await resumed.process(work), 'completed');
          assert.equal(await resumed.process(work), 'idle');
        } finally {
          await runtime.close();
        }
      }
      assert.equal(priorCalls, 1);
    }
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-bob', name: 'send', channel: 'CHR', text: 'Public update from Bob' },
      { token: 'Bearer xoxp-bob', name: 'send', channel: 'CHR', text: 'Public update from Bob' },
    ]);
  } finally {
    await f.close();
  }
});

test('admin web chat sends when no other channel account has TulipFarm access', async () => {
  const f = await outboundFixture();
  try {
    await f.db.platform.query(`DELETE FROM ${f.table('tf_slack_installation_grants')} WHERE membership_id=$1`, [
      f.bob.membershipId,
    ]);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE membership_id=$1`,
      [f.bob.membershipId],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.bob.membershipId,
    ]);
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    for (const storedFlag of [false, true]) {
      await f.db.platform.query(
        `UPDATE ${f.table('tf_slack_destinations')} SET approval_required=$1,version=version+1`,
        [storedFlag],
      );
      const chatId = randomUUID();
      await f.store.create(f.workspace.id, f.alice.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(f.workspace.id, f.alice.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Send hey to HR on Slack' }],
      });
      const engine = createConversationExecutor(
        f.runtime,
        async ({ executeTool }) => {
          const resolved = await executeTool('slack.resolve', false, context =>
            createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
              tool: 'slack.resolve',
              kind: 'channel',
              name: 'HR',
            }),
          );
          assert.equal(resolved.result.status, 'resolved');
          await executeTool('slack.message.send', true, context =>
            createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
              tool: 'slack.message.send',
              destinationId: resolved.result.matches[0].destinationId,
              text: 'hey',
            }),
          );
          return { text: 'Sent', sources: [] };
        },
        undefined,
        factory(f.runtime).resumeConversation,
      );
      const work = { workspaceId: f.workspace.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      assert.equal(await engine.process(work), 'completed');
      const id = (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_conversation_actions')} WHERE turn_id=$1`, [
          sent.turnId,
        ])
      ).rows[0].id;
      const action = await f.service.read(f.workspace.id, f.alice.userId, id);
      assert.equal(action.status, 'sent');
      assert.equal(action.approvalRequired, false);
      assert.equal(await engine.process(work), 'idle');
    }
    assert.equal(f.effects.length, 2);
    assert.ok(f.effects.every(effect => effect.name === 'send' && effect.channel === 'CHR' && effect.text === 'hey'));
  } finally {
    await f.close();
  }
});

test('multi-step task resumes a legacy pending Slack approval using its original call and preserves prior completed steps', async () => {
  const f = await outboundFixture();
  try {
    await f.legacyApproval();
    let selections = 0;
    const model = syntheticContinuity(async input => {
      selections++;
      const context = JSON.parse(input.prompt);
      return context.results.length
        ? { kind: 'answer', text: 'The HR update is complete.' }
        : {
            kind: 'tool',
            text: 'Send HR update',
            call: { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Task HR update' },
          };
    });
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    const tasks = createAgentTasks(f.runtime),
      engine = createTaskRuntime(f.runtime, model, undefined, factory);
    const task = await tasks.start(f.workspace.id, f.bob.userId, {
      requestId: randomUUID(),
      agentId: f.agentId,
      activationId: f.activationId,
      scope: f.scope,
      text: 'Send the update',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
    });
    await engine.process(f.workspace.id, task.id);
    await engine.process(f.workspace.id, task.id);
    assert.equal((await tasks.read(f.workspace.id, f.bob.userId, task.id)).status, 'waiting-approval');
    assert.equal(selections, 1);
    const waiting = await tasks.read(f.workspace.id, f.bob.userId, task.id);
    assert.equal(waiting.toolCalls, 1);
    assert.deepEqual(await createTaskProgress(f.runtime)(f.workspace.id, task.id), { kind: 'waiting' });
    const activityCount = (
      await f.db.platform.query(
        `SELECT count(*)::int AS n FROM ${f.table('tf_agent_task_activity')} WHERE task_id=$1`,
        [task.id],
      )
    ).rows[0].n;
    await delay(150);
    for (let n = 0; n < 3; n++) await engine.process(f.workspace.id, task.id);
    assert.equal(
      (await tasks.read(f.workspace.id, f.bob.userId, task.id)).activeMilliseconds,
      waiting.activeMilliseconds,
    );
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT count(*)::int AS n FROM ${f.table('tf_agent_task_activity')} WHERE task_id=$1`,
          [task.id],
        )
      ).rows[0].n,
      activityCount,
    );
    const id = (
      await f.db.platform.query(
        `SELECT a.id FROM ${f.table('tf_slack_actions')} a JOIN ${f.table('tf_agent_runs')} r ON r.id=a.run_id WHERE r.task_id=$1`,
        [task.id],
      )
    ).rows[0].id;
    const proposal = await f.service.read(f.workspace.id, f.bob.userId, id);
    await f.decide(f.workspace.id, f.bob.userId, id, { digest: proposal.digest, decision: 'approve' });
    assert.deepEqual(await createTaskProgress(f.runtime)(f.workspace.id, task.id), { kind: 'runnable' });
    const runtime = f.createRuntime();
    try {
      const resumed = createTaskRuntime(runtime, model, undefined, factory);
      await resumed.process(f.workspace.id, task.id);
      assert.equal(selections, 1);
      await resumed.process(f.workspace.id, task.id);
    } finally {
      await runtime.close();
    }
    assert.equal((await tasks.read(f.workspace.id, f.bob.userId, task.id)).status, 'completed');
    assert.equal(selections, 2);
    assert.equal((await tasks.read(f.workspace.id, f.bob.userId, task.id)).toolCalls, 1);
    assert.deepEqual(
      (
        await f.db.platform.query(`SELECT status FROM ${f.table('tf_agent_task_action_receipts')} WHERE call_id=$1`, [
          id,
        ])
      ).rows,
      [{ status: 'completed' }],
    );
    assert.deepEqual(f.effects, [{ token: 'Bearer xoxp-bob', name: 'send', channel: 'CHR', text: 'Task HR update' }]);
  } finally {
    await f.close();
  }
});

test('slow actual Slack task effect charges outbound duration once and cannot resume inference after exhaustion', async () => {
  const f = await outboundFixture();
  try {
    let selections = 0;
    const model = syntheticContinuity(async () => {
      selections++;
      return {
        kind: 'tool',
        text: 'Send',
        call: { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Slow task update' },
      };
    });
    const tasks = createAgentTasks(f.runtime);
    const task = await tasks.start(f.workspace.id, f.bob.userId, {
      requestId: randomUUID(),
      agentId: f.agentId,
      activationId: f.activationId,
      scope: f.scope,
      text: 'Send slow update',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 },
    });
    const factory = runtime =>
      createSlackActions({
        ...f.settings,
        runtime,
        fetcher: async (url, init) => {
          const response = await f.settings.fetcher(url, init);
          if (slackUserCall(url, init) === 'chat.postMessage') await delay(1300);
          return response;
        },
      });
    const engine = createTaskRuntime(f.runtime, model, undefined, factory);
    await engine.process(f.workspace.id, task.id);
    const before = await tasks.read(f.workspace.id, f.bob.userId, task.id);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_agent_tasks')} SET limits=jsonb_set(limits,'{activeMilliseconds}',to_jsonb(active_milliseconds+1000)) WHERE id=$1`,
      [task.id],
    );
    await engine.process(f.workspace.id, task.id);
    const after = await tasks.read(f.workspace.id, f.bob.userId, task.id);
    assert.equal(after.status, 'paused');
    assert.equal(after.toolCalls, 1);
    assert.ok(Number(after.activeMilliseconds) - Number(before.activeMilliseconds) >= 1300);
    assert.equal(selections, 1);
    assert.deepEqual(f.effects, [{ token: 'Bearer xoxp-bob', name: 'send', channel: 'CHR', text: 'Slow task update' }]);
    await createTaskRuntime(f.runtime, model, undefined, factory).process(f.workspace.id, task.id);
    assert.equal(
      (await tasks.read(f.workspace.id, f.bob.userId, task.id)).activeMilliseconds,
      after.activeMilliseconds,
    );
    assert.equal(selections, 1);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test('Slack task Retry-After polls do not reserve more time or dispatch before the original action is due', async () => {
  const f = await outboundFixture();
  try {
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_destinations')} SET approval_required=true`);
    const model = syntheticContinuity(async input =>
      JSON.parse(input.prompt).results.length
        ? { kind: 'answer', text: 'Sent' }
        : {
            kind: 'tool',
            text: 'Send',
            call: { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Retry task update' },
          },
    );
    const tasks = createAgentTasks(f.runtime),
      factory = runtime => createSlackActions({ ...f.settings, runtime });
    const engine = createTaskRuntime(f.runtime, model, undefined, factory);
    const task = await tasks.start(f.workspace.id, f.bob.userId, {
      requestId: randomUUID(),
      agentId: f.agentId,
      activationId: f.activationId,
      scope: f.scope,
      text: 'Retry update',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 },
    });
    await engine.process(f.workspace.id, task.id);
    f.setMode('retry');
    await engine.process(f.workspace.id, task.id);
    const before = await tasks.read(f.workspace.id, f.bob.userId, task.id);
    assert.equal(before.status, 'waiting-approval');
    assert.equal(before.toolCalls, 1);
    assert.deepEqual(await createTaskProgress(f.runtime)(f.workspace.id, task.id), { kind: 'waiting' });
    for (let n = 0; n < 3; n++) await engine.process(f.workspace.id, task.id);
    assert.equal(
      (await tasks.read(f.workspace.id, f.bob.userId, task.id)).activeMilliseconds,
      before.activeMilliseconds,
    );
    assert.equal(f.effects.length, 0);
    await delay(1100);
    f.setMode('success');
    assert.deepEqual(await createTaskProgress(f.runtime)(f.workspace.id, task.id), { kind: 'runnable' });
    await engine.process(f.workspace.id, task.id);
    await engine.process(f.workspace.id, task.id);
    assert.equal((await tasks.read(f.workspace.id, f.bob.userId, task.id)).status, 'completed');
    assert.equal((await tasks.read(f.workspace.id, f.bob.userId, task.id)).toolCalls, 1);
    assert.equal(f.effects.length, 1);
    const [action] = (await factory(f.runtime).taskActions(f.workspace.id, f.bob.userId, task.id)).actions;
    assert.equal(action.status, 'sent');
    assert.equal(action.approvalRequired, false);
    assert.equal(f.cards.length, 0);
  } finally {
    await f.close();
  }
});

test('Slack preflight cannot dispatch after its durable task reservation expires', async () => {
  const f = await outboundFixture();
  try {
    const tasks = createAgentTasks(f.runtime);
    const model = syntheticContinuity(async () => ({
      kind: 'tool',
      text: 'Send',
      call: { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Must not dispatch' },
    }));
    const task = await tasks.start(f.workspace.id, f.bob.userId, {
      requestId: randomUUID(),
      agentId: f.agentId,
      activationId: f.activationId,
      scope: f.scope,
      text: 'Bound preflight',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 },
    });
    let delayed = false;
    const factory = runtime =>
      createSlackActions({
        ...f.settings,
        runtime,
        fetcher: async (url, init) => {
          if (!delayed && slackUserCall(url, init) === 'conversations.members') {
            delayed = true;
            await delay(1100);
          }
          return f.settings.fetcher(url, init);
        },
      });
    const engine = createTaskRuntime(f.runtime, model, undefined, factory);
    await engine.process(f.workspace.id, task.id);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_agent_tasks')} SET limits=jsonb_set(limits,'{activeMilliseconds}',to_jsonb(active_milliseconds+1000)) WHERE id=$1`,
      [task.id],
    );
    await engine.process(f.workspace.id, task.id);
    const actual = await tasks.read(f.workspace.id, f.bob.userId, task.id);
    assert.equal(actual.status, 'paused');
    assert.equal(actual.toolCalls, 1);
    assert.equal(f.effects.length, 0);
    assert.deepEqual(
      (
        await f.db.platform.query(
          `SELECT e.state FROM ${f.table('tf_slack_action_effects')} e JOIN ${f.table('tf_agent_tool_calls')} c ON c.id=e.action_id JOIN ${f.table('tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1`,
          [task.id],
        )
      ).rows,
      [{ state: 'unknown' }],
    );
  } finally {
    await f.close();
  }
});

test('Slack task outcome rollback retains the send claim and never duplicates the effect on recovery', async () => {
  const f = await outboundFixture();
  try {
    const tasks = createAgentTasks(f.runtime);
    const model = syntheticContinuity(async () => ({
      kind: 'tool',
      text: 'Send',
      call: { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Once despite rollback' },
    }));
    const task = await tasks.start(f.workspace.id, f.bob.userId, {
      requestId: randomUUID(),
      agentId: f.agentId,
      activationId: f.activationId,
      scope: f.scope,
      text: 'Send once',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 },
    });
    let rollback = false;
    const failing = {
      transaction: (workspaceId, range, operation) =>
        f.runtime.transaction(workspaceId, range, async tx => {
          const result = await operation(tx);
          if (
            !rollback &&
            (await tx.client.query(`SELECT 1 FROM ${f.table('tf_slack_action_effects')} WHERE state='sent'`)).rowCount
          ) {
            rollback = true;
            throw new Error('injected Slack outcome rollback');
          }
          return result;
        }),
    };
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    const engine = createTaskRuntime(failing, model, undefined, factory);
    await engine.process(f.workspace.id, task.id);
    await assert.rejects(engine.process(f.workspace.id, task.id), /Agent tool execution unavailable/);
    const call = (
      await f.db.platform.query(
        `SELECT c.id,c.run_id FROM ${f.table('tf_agent_tool_calls')} c JOIN ${f.table('tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1`,
        [task.id],
      )
    ).rows[0];
    assert.deepEqual(
      (
        await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_action_effects')} WHERE action_id=$1`, [
          call.id,
        ])
      ).rows,
      [{ state: 'sending' }],
    );
    const before = await tasks.read(f.workspace.id, f.bob.userId, task.id);
    assert.equal(before.toolCalls, 1);
    assert.equal(f.effects.length, 1);
    const executor = createAgentExecutor({ runtime: f.runtime, slack: factory });
    assert.equal(
      await executor.execute({ workspaceId: f.workspace.id, runId: call.run_id, callId: call.id }),
      'waiting',
    );
    assert.equal(
      (await tasks.read(f.workspace.id, f.bob.userId, task.id)).activeMilliseconds,
      before.activeMilliseconds,
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_action_effects')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE action_id=$1`,
      [call.id],
    );
    assert.equal(
      await executor.execute({ workspaceId: f.workspace.id, runId: call.run_id, callId: call.id }),
      'failed',
    );
    assert.deepEqual(
      (
        await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_action_effects')} WHERE action_id=$1`, [
          call.id,
        ])
      ).rows,
      [{ state: 'unknown' }],
    );
    assert.equal((await tasks.read(f.workspace.id, f.bob.userId, task.id)).toolCalls, 1);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test('default Slack channel pauses a legacy pending action for original-requester consent and resumes without model replay', async () => {
  const f = await outboundFixture();
  try {
    await f.legacyApproval();
    const channels = createSlackChannelAgents({ ...f.settings, runtime: f.runtime, model: null });
    await channels.attach(f.workspace.id, f.bob.userId, { channel: 'CHR', agentId: null, expectedVersion: 0 });
    let selections = 0;
    const defaults = createSlackDefault({
      ...f.settings,
      runtime: f.runtime,
      model: null,
      channels,
      reply:
        (_guard, slack) =>
        async ({ executeTool }) => {
          selections++;
          await executeTool('slack.message.send', true, context =>
            createChatTools(context.runtime, { slack }).invokeWithSources(context, {
              tool: 'slack.message.send',
              destinationId: f.destinationId,
              text: 'Default Slack update',
            }),
          );
          return { text: 'Done', sources: [] };
        },
    });
    const inbox = createSlackInbox(f.runtime, channels.freeze),
      text = '<@UBOT> Send update';
    f.setMessages([{ user: 'UBOB', text, ts: '1.000001' }]);
    await inbox.accept(
      { workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 },
      {
        type: 'event_callback',
        api_app_id: 'ATEST',
        team_id: 'TTEST',
        event_id: 'DEFAULT1',
        event_time: 100,
        event: { type: 'app_mention', user: 'UBOB', channel: 'CHR', ts: '1.000001', text },
      },
    );
    const [work] = await defaults.due(f.workspace.id);
    assert.ok(work);
    assert.equal(await defaults.process(work), 'waiting');
    const origin = (
      await f.db.platform.query(
        `SELECT c.id,c.turn_id FROM ${f.table('tf_slack_conversation_actions')} c JOIN ${f.table('tf_slack_default_turns')} s ON s.turn_id=c.turn_id WHERE s.event_id=$1`,
        [work.eventId],
      )
    ).rows[0];
    const service = createSlackActions({ ...f.settings, runtime: f.runtime, audienceSources: defaults.actionSources });
    const proposal = await service.read(f.workspace.id, f.bob.userId, origin.id);
    assert.equal(proposal.status, 'pending');
    assert.equal(f.effects.length, 0);
    const decide = createSlackActionDecision({
      ...f.settings,
      runtime: f.runtime,
      audienceSources: defaults.actionSources,
      resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
    });
    await decide(f.workspace.id, f.bob.userId, origin.id, { digest: proposal.digest, decision: 'approve' });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_default_turns')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE event_id=$1`,
      [work.eventId],
    );
    assert.equal(await defaults.process(work), 'sent');
    assert.equal(selections, 1);
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-bob', name: 'send', channel: 'CHR', text: 'Default Slack update' },
    ]);
  } finally {
    await f.close();
  }
});

test('default Slack reply retries at the current generation after a transient model failure, delivers once, and frees its branch', async () => {
  const f = await outboundFixture();
  try {
    const channels = createSlackChannelAgents({ ...f.settings, runtime: f.runtime, model: null });
    await channels.attach(f.workspace.id, f.bob.userId, { channel: 'CHR', agentId: null, expectedVersion: 0 });
    let calls = 0;
    const defaults = createSlackDefault({
      ...f.settings,
      runtime: f.runtime,
      model: null,
      channels,
      reply: () => async () => {
        if (++calls === 1) throw new Error('model-overload');
        return { text: `Answer ${calls}`, sources: [] };
      },
    });
    const inbox = createSlackInbox(f.runtime, channels.freeze),
      route = { workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 };
    const mention = { user: 'UBOB', text: '<@UBOT> Summarize the thread', ts: '1.000001' },
      followUp = { user: 'UBOB', text: 'And the next step?', ts: '1.000002', thread_ts: '1.000001' };
    f.setMessages([mention]);
    await inbox.accept(route, {
      type: 'event_callback',
      api_app_id: 'ATEST',
      team_id: 'TTEST',
      event_id: 'RETRY1',
      event_time: 100,
      event: { type: 'app_mention', channel: 'CHR', ...mention },
    });
    const [work] = await defaults.due(f.workspace.id);
    assert.ok(work);
    const turn = async () =>
      (
        await f.db.platform.query(
          `SELECT s.state,c.status,c.generation,c.error_code,s.conversation_id,s.turn_id FROM ${f.table('tf_slack_default_turns')} s JOIN ${f.table('tf_conversation_turns')} c ON c.id=s.turn_id WHERE s.event_id=$1`,
          [work.eventId],
        )
      ).rows[0];
    const schedule = retry =>
      f.db.platform.query(
        `WITH s AS (UPDATE ${f.table('tf_slack_default_turns')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE event_id=$1 RETURNING turn_id)
      UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp()+$2*interval '1 second' WHERE id=(SELECT turn_id FROM s)`,
        [work.eventId, retry],
      );
    assert.equal(await defaults.process(work), 'waiting');
    const failed = await turn();
    assert.deepEqual(
      { state: failed.state, status: failed.status, generation: failed.generation, errorCode: failed.error_code },
      { state: 'pending', status: 'queued', generation: 1, errorCode: 'model-overload' },
    );
    assert.deepEqual(
      await createConversationExecutor(f.runtime).due(f.workspace.id),
      [],
      'ordinary discovery leaves the queued default turn to the Slack path',
    );
    const stale = createConversationExecutor(
      f.runtime,
      async () => assert.fail('a stale generation reached the model'),
      async () => ({ kind: 'channel', sources: [] }),
    );
    assert.equal(
      await stale.process({
        workspaceId: f.workspace.id,
        conversationId: failed.conversation_id,
        turnId: failed.turn_id,
        generation: 0,
      }),
      'idle',
    );
    await schedule(3600);
    assert.equal(await defaults.process(work), 'waiting');
    assert.equal(calls, 1, 'the executor backoff still applies');
    await schedule(-1);
    assert.deepEqual((await Promise.all([defaults.process(work), defaults.process(work)])).sort(), ['idle', 'sent']);
    const delivered = await turn();
    assert.deepEqual(
      {
        state: delivered.state,
        status: delivered.status,
        generation: delivered.generation,
        errorCode: delivered.error_code,
      },
      { state: 'sent', status: 'completed', generation: 1, errorCode: null },
    );
    assert.equal(calls, 2);
    f.setMessages([mention, followUp]);
    await inbox.accept(route, {
      type: 'event_callback',
      api_app_id: 'ATEST',
      team_id: 'TTEST',
      event_id: 'RETRY2',
      event_time: 101,
      event: { type: 'message', channel: 'CHR', ...followUp },
    });
    const next = await defaults.due(f.workspace.id);
    assert.equal(next.length, 1);
    assert.notEqual(next[0].eventId, work.eventId);
    assert.equal(await defaults.process(next[0]), 'sent');
    assert.deepEqual(
      f.cards.map(card => [card.channel, card.text]),
      [
        ['DBOB', 'Answer 2'],
        ['DBOB', 'Answer 3'],
      ],
    );
  } finally {
    await f.close();
  }
});

test('new default Slack DM retains its requesting identity through legacy approval and final bot delivery', async () => {
  const f = await outboundFixture();
  try {
    await f.legacyApproval();
    const direct = createSlackDirectMessages({ ...f.settings, runtime: f.runtime }),
      inbox = createSlackInbox(f.runtime);
    await inbox.accept(
      { workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 },
      {
        type: 'event_callback',
        api_app_id: 'ATEST',
        team_id: 'TTEST',
        event_id: 'DIRECTOUT',
        event_time: 100,
        event: { type: 'message', user: 'UBOB', channel: 'DBOB', ts: '2.000001', text: 'Send public HR update' },
      },
    );
    await direct.admitPending(f.workspace.id);
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    let selections = 0;
    const engine = createConversationExecutor(
      f.runtime,
      async ({ executeTool }) => {
        selections++;
        await executeTool('slack.message.send', true, context =>
          createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
            tool: 'slack.message.send',
            destinationId: f.destinationId,
            text: 'Public HR update',
          }),
        );
        return { text: 'Done', sources: [] };
      },
      undefined,
      factory(f.runtime).resumeConversation,
    );
    const [work] = await engine.due(f.workspace.id);
    assert.ok(work);
    assert.equal(await engine.process(work), 'idle');
    const id = (
      await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_conversation_actions')} WHERE turn_id=$1`, [
        work.turnId,
      ])
    ).rows[0].id;
    const proposal = await f.service.read(f.workspace.id, f.bob.userId, id);
    assert.equal(proposal.status, 'pending');
    await f.decide(f.workspace.id, f.bob.userId, id, { digest: proposal.digest, decision: 'approve' });
    assert.equal(await engine.process(work), 'completed');
    assert.equal(selections, 1);
    const [delivery] = await direct.due(f.workspace.id);
    assert.equal(await direct.process(delivery), 'sent');
    assert.equal(f.effects[0].token, 'Bearer xoxp-bob');
    assert.equal(f.cards.at(-1).channel, 'DBOB');
    assert.match(f.cards.at(-1).text, /Slack confirmed/);
  } finally {
    await f.close();
  }
});

test('default conversation revocation after legacy approval blocks effects and never resumes earlier tools', async () => {
  const f = await outboundFixture();
  try {
    await f.legacyApproval();
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    const chatId = randomUUID();
    await f.store.create(f.workspace.id, f.bob.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(f.workspace.id, f.bob.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Publish update' }],
    });
    const engine = createConversationExecutor(
      f.runtime,
      async ({ executeTool }) => {
        await executeTool('slack.message.send', true, context =>
          createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
            tool: 'slack.message.send',
            destinationId: f.destinationId,
            text: 'Revoked update',
          }),
        );
        return { text: 'Done', sources: [] };
      },
      undefined,
      factory(f.runtime).resumeConversation,
    );
    const work = { workspaceId: f.workspace.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    await engine.process(work);
    const id = (
      await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_conversation_actions')} WHERE turn_id=$1`, [
        sent.turnId,
      ])
    ).rows[0].id;
    const proposal = await f.service.read(f.workspace.id, f.bob.userId, id);
    await f.decide(f.workspace.id, f.bob.userId, id, { digest: proposal.digest, decision: 'approve' });
    // Chat Slack actions are not gated by destination grants since #547, so revoke the requester's installation use instead.
    await f.db.platform.query(`DELETE FROM ${f.table('tf_slack_installation_grants')} WHERE membership_id=$1`, [
      f.bob.membershipId,
    ]);
    assert.equal(await engine.process(work), 'completed');
    assert.equal((await f.service.read(f.workspace.id, f.bob.userId, id)).status, 'revoked');
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

test('legacy approval binds exact payload and designated member, rejection and unknown effects never send again', async () => {
  const f = await outboundFixture();
  try {
    await f.legacyApproval();
    const a = await f.queue();
    assert.equal(await f.executor.execute(a.ids), 'waiting');
    const proposal = await f.service.read(f.workspace.id, f.alice.userId, a.ids.callId);
    assert.equal(proposal.status, 'pending');
    assert.equal(f.cards.length, 1);
    assert.equal(f.cards[0].channel, 'DALICE');
    assert.equal(f.cards[0].blocks.at(-1).elements[0].action_id, 'slack_action_approve');
    assert.deepEqual(JSON.parse(f.cards[0].blocks.at(-1).elements[0].value), {
      workspaceId: f.workspace.id,
      actionId: a.ids.callId,
      digest: proposal.digest,
    });
    await assert.rejects(
      f.decide(f.workspace.id, f.bob.userId, a.ids.callId, { digest: proposal.digest, decision: 'approve' }),
    );
    await assert.rejects(
      f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
        tx.client.query(
          `INSERT INTO ${f.table('tf_slack_action_decisions')} (action_id,digest,membership_id,decision) VALUES ($1,$2,$3,'approve')`,
          [a.ids.callId, proposal.digest, f.alice.membershipId],
        ),
      ),
      error => error.code === '42501',
    );
    assert.equal(
      (await f.decide(f.workspace.id, f.alice.userId, a.ids.callId, { digest: proposal.digest, decision: 'approve' }))
        .status,
      'approved',
    );
    assert.equal(await f.executor.execute(a.ids), 'completed');
    assert.equal(f.effects.length, 1);
    assert.equal(
      f.cards.at(-1).blocks.some(block => block.type === 'actions'),
      false,
    );
    assert.match(f.cards.at(-1).text, /Status sent/);
    const b = await f.queue();
    await f.executor.execute(b.ids);
    const rejected = await f.service.read(f.workspace.id, f.alice.userId, b.ids.callId);
    await f.decide(f.workspace.id, f.alice.userId, b.ids.callId, { digest: rejected.digest, decision: 'reject' });
    assert.equal(await f.executor.execute(b.ids), 'failed');
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, b.ids.callId)).status, 'rejected');
    assert.equal(f.effects.length, 1);
    await f.legacyApproval(false);
    const c = await f.queue();
    f.setMode('lost');
    assert.equal(await f.executor.execute(c.ids), 'failed');
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, c.ids.callId)).status, 'unknown');
    f.setMode('success');
    assert.equal(await f.executor.execute(c.ids), 'failed');
    assert.equal(f.effects.length, 2);
  } finally {
    await f.close();
  }
});

test('effect intent survives a failed outcome commit and immutable actions refuse replacement', async () => {
  const f = await outboundFixture();
  try {
    const { ids, call } = await f.queue();
    await f.service.prepare(f.workspace.id, ids.runId, ids.callId, call);
    await assert.rejects(
      f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
        tx.client.query(`UPDATE ${f.table('tf_slack_actions')} SET channel='COTHER' WHERE id=$1`, [ids.callId]),
      ),
      error => error.code === '42501',
    );
    await f.db.platform.query(
      `CREATE FUNCTION ${f.table('reject_slack_receipt')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='sent' THEN RAISE EXCEPTION 'fixture receipt failure'; END IF; RETURN NEW; END $$`,
    );
    await f.db.platform.query(
      `CREATE TRIGGER reject_slack_receipt BEFORE UPDATE ON ${f.table('tf_slack_action_effects')} FOR EACH ROW EXECUTE FUNCTION ${f.table('reject_slack_receipt')}()`,
    );
    await assert.rejects(f.executor.execute(ids));
    assert.equal(f.effects.length, 1);
    await f.db.platform.query(`DROP TRIGGER reject_slack_receipt ON ${f.table('tf_slack_action_effects')}`);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_action_effects')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE action_id=$1`,
      [ids.callId],
    );
    const restarted = f.createRuntime();
    try {
      const executor = createAgentExecutor({
        runtime: restarted,
        slack: runtime => createSlackActions({ ...f.settings, runtime }),
      });
      assert.equal(await executor.execute(ids), 'failed');
    } finally {
      await restarted.close();
    }
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, ids.callId)).status, 'unknown');
    assert.equal(f.effects.length, 1);
    await assert.rejects(
      f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
        tx.client.query(`UPDATE ${f.table('tf_slack_action_effects')} SET state='pending' WHERE action_id=$1`, [
          ids.callId,
        ]),
      ),
      /terminal/,
    );
  } finally {
    await f.close();
  }
});

test('agent saved to post as the TulipFarm app sends with the bot token and still fences on the requester', async () => {
  const f = await outboundFixture();
  try {
    const version = (
      await f.db.platform.query(`SELECT policy_version FROM ${f.table('tf_agents')} WHERE id=$1`, [f.agentId])
    ).rows[0].policy_version;
    await f.executor.configure(
      f.workspace.id,
      { kind: 'human', ...f.alice },
      { agentId: f.agentId, version, enabled: true, teamIds: [f.teamId], limits: f.scope, slackSender: 'app' },
    );
    const sent = await f.queue();
    assert.equal(await f.executor.execute(sent.ids), 'completed');
    const view = await f.service.read(f.workspace.id, f.alice.userId, sent.ids.callId);
    assert.equal(view.status, 'sent');
    assert.equal(view.sender, 'app');
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxb-fixture', name: 'send', channel: 'CHR', text: 'Approved HR update' },
    ]);
    const reaction = await f.queue(f.alice, 'slack.reaction.add');
    assert.equal(await f.executor.execute(reaction.ids), 'failed');
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, reaction.ids.callId)).status, 'revoked');
    f.setAudience(['UBOB', 'UGUEST', 'BOTHERBOT', 'UBOT']);
    const removed = await f.queue();
    assert.equal(await f.executor.execute(removed.ids), 'blocked');
    assert.equal(f.effects.length, 1);
    f.setAudience(['UALICE', 'UBOB', 'UGUEST', 'BOTHERBOT', 'UBOT']);
    const off = createAgentExecutor({
      runtime: f.runtime,
      slack: runtime => createSlackActions({ ...f.settings, runtime, appSenderEnabled: async () => false }),
    });
    const fallback = await f.queue();
    assert.equal(await off.execute(fallback.ids), 'completed');
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, fallback.ids.callId)).sender, 'user');
    assert.equal(f.effects.at(-1).token, 'Bearer xoxp-alice');
  } finally {
    await f.close();
  }
});

test('agent actions send directly to unlinked recipients and requester removal blocks a legacy approved dispatch', async () => {
  const f = await outboundFixture();
  try {
    const version = (
      await f.db.platform.query(`SELECT policy_version FROM ${f.table('tf_agents')} WHERE id=$1`, [f.agentId])
    ).rows[0].policy_version;
    await f.executor.configure(
      f.workspace.id,
      { kind: 'human', ...f.alice },
      { agentId: f.agentId, version, enabled: true, teamIds: [f.teamId], limits: f.scope },
    );
    const a = await f.queue();
    assert.equal(await f.executor.execute(a.ids), 'completed');
    const sent = await f.service.read(f.workspace.id, f.alice.userId, a.ids.callId);
    assert.equal(sent.approvalRequired, false);
    assert.equal(sent.status, 'sent');
    assert.equal(f.effects.length, 1);
    assert.equal(f.cards.length, 0);
    await f.legacyApproval();
    const b = await f.queue();
    assert.equal(await f.executor.execute(b.ids), 'waiting');
    const next = await f.service.read(f.workspace.id, f.alice.userId, b.ids.callId);
    await f.decide(f.workspace.id, f.alice.userId, b.ids.callId, { digest: next.digest, decision: 'approve' });
    f.setAudience(['UBOB', 'UGUEST', 'BOTHERBOT', 'UBOT']);
    assert.equal(await f.executor.execute(b.ids), 'failed');
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, b.ids.callId)).status, 'revoked');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test('current destination grants, policy versions, expiry and 429 schedules fence every dispatch', async () => {
  const f = await outboundFixture();
  try {
    const direct = await f.queue();
    f.setMode('retry');
    assert.equal(await f.executor.execute(direct.ids), 'waiting');
    const retry = await f.service.read(f.workspace.id, f.alice.userId, direct.ids.callId);
    assert.equal(retry.status, 'retry');
    assert.equal(await f.executor.execute(direct.ids), 'waiting');
    assert.equal(f.effects.length, 0);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_action_effects')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE action_id=$1`,
      [direct.ids.callId],
    );
    f.setMode('success');
    assert.equal(await f.executor.execute(direct.ids), 'completed');
    assert.equal(f.effects.length, 1);
    await f.legacyApproval();
    for (const state of ['stale', 'policy', 'expired', 'revoked']) {
      const queued = await f.queue();
      assert.equal(await f.executor.execute(queued.ids), 'waiting');
      const proposal = await f.service.read(f.workspace.id, f.alice.userId, queued.ids.callId);
      await f.decide(f.workspace.id, f.alice.userId, queued.ids.callId, {
        digest: proposal.digest,
        decision: 'approve',
      });
      if (state === 'stale')
        await f.db.platform.query(`UPDATE ${f.table('tf_slack_destinations')} SET version=version+1`);
      if (state === 'policy') {
        const version = (
          await f.db.platform.query(`SELECT policy_version FROM ${f.table('tf_agents')} WHERE id=$1`, [f.agentId])
        ).rows[0].policy_version;
        await f.executor.configure(
          f.workspace.id,
          { kind: 'human', ...f.alice },
          { agentId: f.agentId, version, enabled: true, teamIds: [f.teamId], limits: f.scope },
        );
      }
      if (state === 'expired')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_slack_actions')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [queued.ids.callId],
        );
      if (state === 'revoked')
        await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1`, [f.destinationId]);
      assert.equal(await f.executor.execute(queued.ids), 'failed');
      assert.equal(
        (await f.service.read(f.workspace.id, f.alice.userId, queued.ids.callId)).status,
        state === 'policy' ? 'stale' : state,
      );
      assert.equal(f.effects.length, 1);
    }
  } finally {
    await f.close();
  }
});

test('named Slack channel uses the same saved-agent outbound executor for each current requester', async () => {
  const f = await outboundFixture();
  try {
    let inferences = 0;
    const model = syntheticContinuity(async () => {
      inferences++;
      return {
        kind: 'tool',
        text: 'HR update',
        call: { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Shared HR update' },
      };
    });
    const channels = createSlackChannelAgents({ ...f.settings, runtime: f.runtime, model });
    await channels.attach(f.workspace.id, f.alice.userId, { channel: 'CHR', agentId: f.agentId, expectedVersion: 0 });
    const inbox = createSlackInbox(f.runtime, channels.freeze);
    for (const [index, user] of ['UALICE', 'UBOB'].entries()) {
      const ts = `${index + 1}.000001`,
        text = '<@UBOT> Send an HR update';
      f.setMessages([{ user, text, ts }]);
      await inbox.accept(
        { workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 },
        {
          type: 'event_callback',
          api_app_id: 'ATEST',
          team_id: 'TTEST',
          event_id: `OUT${index}`,
          event_time: 100,
          event: { type: 'app_mention', user, channel: 'CHR', ts, text },
        },
      );
      const [work] = await channels.due(f.workspace.id);
      assert.ok(work);
      assert.equal(await channels.process(work), 'sent');
      assert.equal(f.effects[index].token, index === 0 ? 'Bearer xoxp-alice' : 'Bearer xoxp-bob');
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT e.state FROM ${f.table('tf_slack_action_effects')} e JOIN ${f.table('tf_slack_actions')} a ON a.id=e.action_id WHERE a.run_id=$1`,
            [work.eventId],
          )
        ).rows,
        [{ state: 'sent' }],
      );
    }
    assert.equal(inferences, 2);
    assert.deepEqual(
      f.effects.map(item => item.text),
      ['Shared HR update', 'Shared HR update'],
    );
  } finally {
    await f.close();
  }
});
