import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { outboundFixture } from './slack-actions.integration.mjs';
import { createSlackActions } from '../src/slack-actions.ts';
import { createChatTools } from '../src/tools.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';

test('Slack name lookup creates a send destination for each visible channel', async () => {
  const f = await outboundFixture();
  try {
    const service = createSlackActions({ ...f.settings, runtime: f.runtime });
    const actor = { kind: 'human', ...f.bob };
    const channel = await service.resolve(f.workspace.id, actor, {
      tool: 'slack.resolve',
      kind: 'channel',
      name: '#slack-bot-test',
    });
    assert.equal(channel.status, 'resolved');
    assert.deepEqual(channel.matches, [{ id: 'CHR', name: 'slack-bot-test', destinationId: f.destinationId }]);
    const user = await service.resolve(f.workspace.id, actor, { tool: 'slack.resolve', kind: 'user', name: '@Bob' });
    assert.equal(user.status, 'resolved');
    assert.deepEqual(user.matches, [{ id: 'UBOB', name: 'Bob' }]);
    const chatId = randomUUID();
    await f.store.create(f.workspace.id, f.bob.userId, { chatId, commandId: randomUUID() });
    const tools = createChatTools(f.runtime, { slack: runtime => createSlackActions({ ...f.settings, runtime }) });
    const privateUser = await tools.invokeWithSources(
      {
        workspaceId: f.workspace.id,
        actor,
        callId: randomUUID(),
        origin: { conversationId: chatId, turnId: randomUUID(), sources: [] },
      },
      { tool: 'slack.resolve', kind: 'user', name: 'Bob' },
    );
    assert.deepEqual(privateUser.sources, [{ kind: 'private-conversation', conversationId: chatId }]);
    await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1`, [f.destinationId]);
    const allowed = await service.resolve(f.workspace.id, actor, {
      tool: 'slack.resolve',
      kind: 'channel',
      name: 'slack-bot-test',
    });
    assert.deepEqual(allowed.matches, [{ id: 'CHR', name: 'slack-bot-test', destinationId: f.destinationId }]);
    assert.equal(allowed.instruction, 'Use destinationId to send.');
    await f.db.platform.query(`DELETE FROM ${f.table('tf_slack_destinations')} WHERE id=$1`, [f.destinationId]);
    const created = await service.resolve(f.workspace.id, actor, {
      tool: 'slack.resolve',
      kind: 'channel',
      name: 'slack-bot-test',
    });
    assert.equal(created.matches[0]?.id, 'CHR');
    assert.ok(created.matches[0]?.destinationId);
    assert.notEqual(created.matches[0]?.destinationId, f.destinationId);
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT count(*)::int AS count FROM ${f.table('tf_slack_destinations')} WHERE channel='CHR' AND enabled`,
        )
      ).rows[0].count,
      1,
    );
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

test('Slack lookup completes pagination before resolving and asks about ambiguous users', async () => {
  const f = await outboundFixture();
  try {
    const service = createSlackActions({ ...f.settings, runtime: f.runtime });
    const actor = { kind: 'human', ...f.bob },
      call = { tool: 'slack.resolve', kind: 'user', name: 'Alex' };
    const pages = [],
      alex = (id, name) => ({ id, name: id.toLowerCase(), profile: { display_name: name } });
    f.setDirectoryResponse((_method, args) => {
      pages.push(args.cursor ?? '');
      return args.cursor
        ? { members: [alex('UALEX2', 'Alex')], response_metadata: { next_cursor: '' } }
        : { members: [alex('UALEX1', 'Alex')], response_metadata: { next_cursor: 'next' } };
    });
    const result = await service.resolve(f.workspace.id, actor, call);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.matches.length, 2);
    assert.deepEqual(pages, ['', 'next']);
    f.setDirectoryResponse(() => ({ members: [alex('UALEX1', 'Alex')], response_metadata: { next_cursor: 'loop' } }));
    assert.equal((await service.resolve(f.workspace.id, actor, call)).error, 'lookup-incomplete');
    f.setDirectoryResponse(() => ({ members: [], response_metadata: { next_cursor: '' } }));
    assert.equal((await service.resolve(f.workspace.id, actor, call)).status, 'not-found');
    f.setDirectoryResponse(() => ({ members: [alex('UALEX1', 'Alexandra')], response_metadata: { next_cursor: '' } }));
    assert.equal((await service.resolve(f.workspace.id, actor, call)).status, 'ambiguous');
    f.setDirectoryResponse(() => ({
      members: [
        alex('UALEX1', 'Alex'),
        { ...alex('UBOTX', 'Alex'), is_bot: true },
        { ...alex('UGONE', 'Alex'), deleted: true },
      ],
      response_metadata: { next_cursor: '' },
    }));
    assert.deepEqual((await service.resolve(f.workspace.id, actor, call)).matches, [{ id: 'UALEX1', name: 'Alex' }]);
  } finally {
    await f.close();
  }
});

test('Slack channel names work through the conversation send path and missing app membership is actionable', async () => {
  const f = await outboundFixture();
  try {
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    for (const appPresent of [true, false]) {
      f.setAudience(appPresent ? ['UALICE', 'UBOB', 'UBOT'] : ['UALICE', 'UBOB']);
      const chatId = randomUUID();
      await f.store.create(f.workspace.id, f.bob.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(f.workspace.id, f.bob.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Send hey to #HR' }],
      });
      const engine = createConversationExecutor(
        f.runtime,
        async ({ executeTool }) => {
          const { result: output } = await executeTool('slack.resolve', true, context =>
            createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
              tool: 'slack.resolve',
              kind: 'channel',
              name: '#HR',
            }),
          );
          if (!appPresent) {
            assert.equal(output.error, 'app-not-in-channel');
            assert.match(output.instruction, /Add the TulipFarm app/);
            return { text: output.instruction, sources: [] };
          }
          assert.equal(output.matches[0].destinationId, f.destinationId);
          await executeTool('slack.message.send', true, context =>
            createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
              tool: 'slack.message.send',
              destinationId: output.matches[0].destinationId,
              text: 'hey',
            }),
          );
          return { text: 'Sent hey.', sources: [] };
        },
        undefined,
        factory(f.runtime).resumeConversation,
      );
      assert.equal(
        await engine.process({
          workspaceId: f.workspace.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 0,
        }),
        'completed',
      );
    }
    assert.deepEqual(f.effects, [{ token: 'Bearer xoxp-bob', name: 'send', channel: 'CHR', text: 'hey' }]);
  } finally {
    await f.close();
  }
});

test('Slack direct sends report a missing app before persisting an action and recover after invitation', async () => {
  const f = await outboundFixture();
  try {
    f.setAudience(['UALICE', 'UBOB']);
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    const chatId = randomUUID();
    await f.store.create(f.workspace.id, f.bob.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(f.workspace.id, f.bob.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Send hey' }],
    });
    const engine = createConversationExecutor(
      f.runtime,
      async ({ executeTool }) => {
        const { result } = await executeTool('slack.message.send', true, context =>
          createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
            tool: 'slack.message.send',
            destinationId: f.destinationId,
            text: 'hey',
          }),
        );
        assert.equal(result.error, 'app-not-in-channel');
        assert.match(result.instruction, /Add the TulipFarm app/);
        return { text: result.instruction, sources: [] };
      },
      undefined,
      factory(f.runtime).resumeConversation,
    );
    assert.equal(
      await engine.process({ workspaceId: f.workspace.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_slack_conversation_actions')}`)).rows[0]
        .n,
      0,
    );
    assert.equal(f.effects.length, 0);
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    const resolved = await f.service.resolve(
      f.workspace.id,
      { kind: 'human', ...f.bob },
      { tool: 'slack.resolve', kind: 'channel', name: 'HR' },
    );
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.matches[0].destinationId, f.destinationId);
  } finally {
    await f.close();
  }
});

test('Slack directory requires a current linked identity and a valid Slack credential', async () => {
  const f = await outboundFixture();
  try {
    const actor = { kind: 'human', ...f.bob },
      call = { tool: 'slack.resolve', kind: 'user', name: 'Bob' };
    f.setDirectoryResponse(() => ({ ok: false, error: 'missing_scope' }));
    assert.equal((await f.service.resolve(f.workspace.id, actor, call)).error, 'slack-access-required');
    f.setDirectoryResponse(() => ({ ok: false, error: 'token_revoked' }));
    assert.equal((await f.service.resolve(f.workspace.id, actor, call)).error, 'provider-auth-rejected');
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT credential->'rotation'->>'state' AS state FROM ${f.table('tf_slack_identities')} WHERE user_id=$1`,
          [f.bob.userId],
        )
      ).rows[0].state,
      'reconnect-required',
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE user_id=$1`,
      [f.bob.userId],
    );
    assert.equal((await f.service.resolve(f.workspace.id, actor, call)).error, 'slack-access-required');
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

test('Slack sends classify requester denials with actionable codes before persisting an action', async () => {
  const f = await outboundFixture();
  try {
    const factory = runtime => createSlackActions({ ...f.settings, runtime });
    const send = async () => {
      const chatId = randomUUID();
      await f.store.create(f.workspace.id, f.bob.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(f.workspace.id, f.bob.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Send hey' }],
      });
      let output;
      const engine = createConversationExecutor(
        f.runtime,
        async ({ executeTool }) => {
          output = (
            await executeTool('slack.message.send', true, context =>
              createChatTools(context.runtime, { slack: factory }).invokeWithSources(context, {
                tool: 'slack.message.send',
                destinationId: f.destinationId,
                text: 'hey',
              }),
            )
          ).result;
          return { text: output.instruction, sources: [] };
        },
        undefined,
        factory(f.runtime).resumeConversation,
      );
      assert.equal(
        await engine.process({
          workspaceId: f.workspace.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 0,
        }),
        'completed',
      );
      return output;
    };
    f.setAudience(['UALICE', 'UBOT']);
    const outside = await send();
    assert.equal(outside.error, 'requester-not-in-channel');
    assert.match(outside.instruction, /Join the channel/);
    const resolved = await f.service.resolve(
      f.workspace.id,
      { kind: 'human', ...f.bob },
      { tool: 'slack.resolve', kind: 'channel', name: 'HR' },
    );
    assert.equal(resolved.error, 'requester-not-in-channel');
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    await f.db.platform.query(`DELETE FROM ${f.table('tf_slack_installation_grants')} WHERE membership_id=$1`, [
      f.bob.membershipId,
    ]);
    const ungranted = await send();
    assert.equal(ungranted.error, 'slack-access-required');
    assert.match(ungranted.instruction, /nothing was posted/);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_slack_actions')}`)).rows[0].n,
      0,
    );
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});
