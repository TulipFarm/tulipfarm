import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createChatTools } from '../src/tools.ts';
import { googleRuntimeFixture } from './google-fixture.mjs';
import { meteredReply } from '../../../apps/worker/src/conversation-activities.ts';
import { anthropicChat, anthropicText, isTitleRequest } from '../../../apps/worker/test/native-chat-fixture.mjs';
import { calendarTextRecovery } from '../src/calendar-text-check.ts';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { useModelFamilies } from '../../../apps/worker/test/model-families-fixture.mjs';

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

for (const mode of ['correct', 'inconclusive', 'credits'])
  test(`Calendar ${mode}: persisted review and real worker credit accounting`, async t => {
    const f = await googleRuntimeFixture();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic';
    t.after(() => {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    });
    t.after(useModelFamilies());
    try {
      const w = f.workspace.id,
        chatId = randomUUID();
      await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w, f.member.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text: 'Create an event titled "We\'re ready!" with description "Initial QA event."' }],
      });
      let requests = 0,
        checks = 0,
        titles = 0;
      t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(options.body);
        if (isTitleRequest(body)) {
          titles++;
          return Response.json(anthropicText('QA event'));
        }
        requests++;
        let decision;
        if (body.system[0].text.startsWith('Independently identify')) {
          checks++;
          decision = {
            summary: { mode: 'literal', source: { message: 0, text: "We're ready!" } },
            description:
              mode === 'inconclusive'
                ? { mode: 'inconclusive' }
                : { mode: 'literal', source: { message: 0, text: 'Initial QA event.' } },
          };
          return Response.json({
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_check', name: 'select_action', input: { decision } }],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          });
        } else if (requests === 4) decision = { kind: 'answer', text: 'Ready for owner review.' };
        else
          decision = {
            kind: 'tool',
            call: {
              tool: 'google.propose',
              operation: {
                kind: 'calendar.events.create',
                calendarId: 'primary',
                event: {
                  summary: requests === 1 ? "We're ready" : "We're ready!",
                  description: requests === 1 ? 'Initial QA event' : 'Initial QA event.',
                  start: { date: '2026-10-05' },
                  end: { date: '2026-10-06' },
                },
              },
            },
          };
        return Response.json(anthropicChat(decision));
      });
      const reply = meteredReply(f.runtime, {
        externalContext:
          mode === 'credits'
            ? async tx => {
                if (requests === 1) await tx.client.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
              }
            : undefined,
        mcp: null,
      });
      const executor = createConversationExecutor(f.runtime, input =>
        reply({
          ...input,
          executeTool: (name, external, _action, sources, call, activity) =>
            input.executeTool(
              name,
              external,
              context => createChatTools(context.runtime, { google: f.factory }).invokeWithSources(context, call),
              sources,
              call,
              activity,
            ),
        }),
      );
      const work = { workspaceId: w, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      assert.equal(await executor.process(work), mode === 'credits' ? 'failed' : 'completed');
      const proposals = (await f.db.platform.query(`SELECT operation FROM ${f.table('tf_google_proposals')}`)).rows;
      const history = await f.store.history(w, f.member.userId, chatId);
      if (mode === 'correct') {
        assert.equal(proposals.length, 1);
        const view = await f.factory(f.runtime).proposals(w, f.member.userId);
        const reviewed = await f.factory(f.runtime).proposal(w, f.member.userId, view.proposals[0].id);
        assert.equal(reviewed.operation.event.summary, "We're ready!");
        assert.equal(reviewed.operation.event.description, 'Initial QA event.');
        assert.equal(history.messages.at(-1).parts[0].text, 'Ready for owner review.');
      } else {
        assert.deepEqual(proposals, []);
        if (mode === 'inconclusive') assert.equal(history.messages.at(-1).parts[0].text, calendarTextRecovery);
        else assert.equal(history.messages[0].turn.errorCode, 'credits-exhausted');
      }
      const expected = mode === 'correct' ? 4 : mode === 'inconclusive' ? 2 : 1;
      const credits = (
        await f.db.platform.query(
          `SELECT provider_pico_usd FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1 ORDER BY id`,
          [chatId],
        )
      ).rows;
      assert.equal(titles, mode === 'correct' ? 1 : 0);
      assert.deepEqual(
        credits.map(row => row.provider_pico_usd),
        Array(expected + titles).fill('400000000'),
        'tool-loop steps, the Calendar check, and any metered title request',
      );
      assert.equal(requests, expected);
      assert.equal(checks, mode === 'credits' ? 0 : 1);
      assert.equal(f.calls.length, 0);
      assert.equal(await executor.process(work), 'idle');
      assert.equal(requests, expected);
    } finally {
      await f.close();
    }
  });
