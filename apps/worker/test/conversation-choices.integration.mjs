import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { nativeChatTools } from '../../../packages/agents/src/native-tools.ts';
import { createChatTools } from '@tulipfarm/agents/tools';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { respondToConversation } from '../src/conversation-responder.ts';
import { anthropicTools, anthropicText } from './native-chat-fixture.mjs';
import { selectReply } from '../../../packages/agents/test/native-fixture.mjs';

test(
  'native choices persist, fence stale work, and resume the same model after answer, typed answer, skip or expiry',
  { timeout: 55000 },
  async t => {
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace;
    const choice = {
      tool: 'present.choice',
      prompt: 'Who should send the Slack message?',
      choices: [
        { id: 'app', label: 'TulipFarm app (Recommended)' },
        { id: 'personal', label: 'My personal Slack account' },
      ],
    };
    assert.ok(nativeChatTools(undefined, false, new Set()).tools.some(tool => tool.name === 'present_choice'));
    const route = {
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/',
      model: 'fixture',
      apiKey: 'synthetic',
    };
    let responses = [],
      calls = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls.push(JSON.parse(options.body));
      assert.ok(responses.length, 'no model call while waiting');
      return Response.json(responses.shift());
    });
    const reply = input => {
      assert.equal(input.model, 'claude-sonnet');
      return respondToConversation(
        route,
        input.messages,
        (call, sources, activity) =>
          input.executeTool(
            call.tool,
            false,
            context => createChatTools(context.runtime).invokeWithSources(context, call),
            sources,
            call,
            activity,
          ),
        undefined,
        undefined,
        false,
        null,
        { priorCalls: input.priorCalls, sources: () => [] },
      );
    };
    for (const mode of ['choice', 'text', 'cancel', 'expire']) {
      await t.test(mode, async () => {
        const chatId = randomUUID();
        await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
        const sent = await f.store.send(w.id, w.userId, chatId, {
          messageId: randomUUID(),
          commandId: randomUUID(),
          model: 'claude-sonnet',
          parts: [{ kind: 'text', text: 'Set up the Slack workflow.' }],
        });
        const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
        responses = [anthropicTools([{ tool: 'tables.definitions' }]), anthropicTools([choice])];
        calls = [];
        const executor = createConversationExecutor(f.runtime, reply);
        assert.equal(await executor.process(work), 'idle');
        assert.equal(calls.length, 2);
        const history = await f.store.history(w.id, w.userId, chatId);
        const requestId = history.messages
          .flatMap(message => message.parts)
          .find(part => part.kind === 'request').requestId;
        assert.equal(history.messages[0].turn.status, 'waiting');
        assert.equal(await executor.process(work), 'idle');
        const restarted = f.createRuntime();
        try {
          const requests = createConversationRequests(restarted);
          const view = await requests.read(w.id, w.userId, chatId, requestId);
          assert.deepEqual(view.answerSchema, {
            kind: 'choices',
            choices: choice.choices,
            multiple: false,
            allowText: true,
          });
          const input = { commandId: randomUUID(), expectedRevision: 1 };
          if (mode === 'choice') {
            const stored = (
              await f.db.platform.query(
                `SELECT s.call_id,s.output FROM ${f.table('tf_conversation_execution_steps')} s JOIN ${f.table('tf_conversation_requests')} r ON r.producer_id=s.call_id WHERE r.id=$1`,
                [requestId],
              )
            ).rows[0];
            await f.db.platform.query(
              `UPDATE ${f.table('tf_conversation_execution_steps')} SET output=$2 WHERE call_id=$1`,
              [
                stored.call_id,
                {
                  ...stored.output,
                  sources: [{ kind: 'table-rows', tableId: randomUUID(), revision: 'a'.repeat(40) }],
                },
              ],
            );
            await assert.rejects(requests.read(w.id, w.userId, chatId, requestId));
            await assert.rejects(
              requests.answer(w.id, w.userId, chatId, requestId, randomUUID(), {
                ...input,
                answer: { kind: 'choices', choiceIds: ['app'] },
              }),
            );
            await f.db.platform.query(
              `UPDATE ${f.table('tf_conversation_execution_steps')} SET output=$2 WHERE call_id=$1`,
              [stored.call_id, stored.output],
            );
          }
          if (mode === 'cancel') await requests.cancel(w.id, w.userId, chatId, requestId, input);
          else if (mode === 'expire') {
            await f.db.platform.query(
              `UPDATE ${f.table('tf_conversation_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
              [requestId],
            );
            await requests.expire(w.id);
          } else {
            const answer =
              mode === 'text'
                ? { kind: 'text', text: 'Use a different channel first.' }
                : { kind: 'choices', choiceIds: ['app'] };
            const responseId = randomUUID();
            await assert.rejects(
              requests.answer(w.id, w.userId, chatId, requestId, randomUUID(), {
                ...input,
                expectedRevision: 2,
                answer,
              }),
            );
            await assert.rejects(
              requests.answer(w.id, w.userId, chatId, requestId, randomUUID(), {
                ...input,
                answer: { kind: 'choices', choiceIds: ['invented'] },
              }),
            );
            const outcome = await requests.answer(w.id, w.userId, chatId, requestId, responseId, { ...input, answer });
            assert.deepEqual(
              await requests.answer(w.id, w.userId, chatId, requestId, responseId, { ...input, answer }),
              outcome,
            );
          }
          const resumed = createConversationExecutor(restarted, reply);
          assert.equal(await resumed.process(work), 'idle');
          responses =
            mode === 'choice'
              ? [
                  anthropicText('I will check existing workflows before setting up the workflow.'),
                  selectReply('anthropic', { status: 'continue', reason: 'The reply only promises work.' }),
                  anthropicTools([{ tool: 'tools.search', query: 'workflows list' }]),
                  anthropicTools([{ tool: 'workflows.list' }]),
                  anthropicText(
                    'I checked existing workflows. Which Slack channel should this workflow use? No Slack action was approved or sent.',
                  ),
                  selectReply('anthropic', {
                    status: 'waiting',
                    reason: 'The workflow needs a Slack destination not supplied by the user.',
                  }),
                ]
              : [
                  anthropicText('I have your response. No Slack action was approved or sent.'),
                  selectReply('anthropic', {
                    status: 'blocked',
                    reason: 'No action was approved; the reply states the incomplete outcome.',
                  }),
                ];
          assert.equal(await resumed.process({ ...work, generation: 1 }), 'completed');
          const replay = JSON.stringify(calls.at(-1));
          assert.match(replay, /not action approval/);
          assert.match(
            replay,
            mode === 'choice'
              ? /choiceIds/
              : mode === 'text'
                ? /different channel/
                : mode === 'cancel'
                  ? /cancelled/
                  : /expired/,
          );
          assert.equal(
            (
              await f.db.platform.query(
                `SELECT count(*)::int AS count FROM ${f.table('tf_conversation_requests')} WHERE turn_id=$1`,
                [sent.turnId],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await f.db.platform.query(
                `SELECT count(*)::int AS count FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 AND tool='tables.definitions'`,
                [sent.turnId],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await f.db.platform.query(
                `SELECT count(*)::int AS count FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 AND tool='workflows.list'`,
                [sent.turnId],
              )
            ).rows[0].count,
            mode === 'choice' ? 1 : 0,
          );
          assert.equal(
            (await f.store.history(w.id, w.userId, chatId)).messages.at(-1).parts[0].text,
            mode === 'choice'
              ? 'I checked existing workflows. Which Slack channel should this workflow use? No Slack action was approved or sent.'
              : 'I have your response. No Slack action was approved or sent.',
          );
          assert.equal(await resumed.process({ ...work, generation: 1 }), 'idle');
          assert.equal(responses.length, 0);
        } finally {
          await restarted.close();
        }
      });
    }
  },
);
