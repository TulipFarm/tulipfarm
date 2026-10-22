import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createChatTools } from '../src/tools.ts';
import { googleRuntimeFixture } from './google-fixture.mjs';
import { meteredReply } from '../../../apps/worker/src/conversation-activities.ts';
import { anthropicChat, anthropicText, isTitleRequest } from '../../../apps/worker/test/native-chat-fixture.mjs';
import { useModelFamilies } from '../../../apps/worker/test/model-families-fixture.mjs';

for (const mode of ['lease', 'omitted-rewrite'])
  test(`Calendar request boundary: ${mode}`, { timeout: 100000 }, async t => {
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
      const text =
        mode === 'lease'
          ? 'Create an event titled "QA." with description "Initial QA event."'
          : 'Update event qa. Keep title "QA.". Rewrite the description "team sync" in title case.';
      const sent = await f.store.send(w, f.member.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text }],
      });
      let requests = 0,
        corrections = 0,
        titles = 0;
      t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(options.body);
        if (isTitleRequest(body)) {
          titles++;
          return Response.json(anthropicText('QA event'));
        }
        assert.ok(++requests <= 4);
        const checking = body.system[0].text.startsWith('Independently identify');
        if (mode === 'lease' && (requests === 1 || checking)) await delay(31000);
        const correcting = JSON.stringify(body.messages.at(-1).content).includes('rejected before execution or review');
        if (correcting) corrections++;
        const decision = checking
          ? {
              summary: { mode: 'literal', source: { message: 0, text: 'QA.' } },
              description:
                mode === 'lease'
                  ? { mode: 'literal', source: { message: 0, text: 'Initial QA event.' } }
                  : {
                      mode: 'rewrite',
                      source: { message: 0, text: 'Rewrite the description "team sync" in title case.' },
                    },
            }
          : requests > 1 && !correcting
            ? { kind: 'answer', text: 'Ready for review.' }
            : {
                kind: 'tool',
                call: {
                  tool: 'google.propose',
                  operation: {
                    kind: mode === 'lease' ? 'calendar.events.create' : 'calendar.events.update',
                    calendarId: 'primary',
                    ...(mode === 'lease' ? {} : { eventId: 'qa' }),
                    event: {
                      summary: 'QA.',
                      ...(mode === 'lease'
                        ? { description: 'Initial QA event.' }
                        : correcting
                          ? { description: 'Team Sync' }
                          : {}),
                      start: { date: '2026-10-05' },
                      end: { date: '2026-10-06' },
                    },
                  },
                },
              };
        return Response.json(
          checking
            ? {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'toolu_check', name: 'select_action', input: { decision } }],
                usage: {
                  input_tokens: 100,
                  output_tokens: 20,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              }
            : anthropicChat(decision),
        );
      });
      const reply = meteredReply(f.runtime, { mcp: null });
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
      assert.equal(await executor.process(work), 'completed');
      const proposals = (await f.db.platform.query(`SELECT id FROM ${f.table('tf_google_proposals')}`)).rows;
      assert.equal(proposals.length, 1);
      const reviewed = await f.factory(f.runtime).proposal(w, f.member.userId, proposals[0].id);
      assert.equal(reviewed.operation.event.description, mode === 'lease' ? 'Initial QA event.' : 'Team Sync');
      assert.equal(corrections, mode === 'lease' ? 0 : 1);
      const credits = (
        await f.db.platform.query(`SELECT provider_pico_usd FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1`, [
          chatId,
        ])
      ).rows;
      assert.equal(titles, 1);
      assert.deepEqual(
        credits.map(row => row.provider_pico_usd),
        Array(mode === 'lease' ? 4 : 5).fill('400000000'),
        'tool-loop steps, the Calendar check, and the metered title request',
      );
      assert.equal(
        (await f.store.history(w, f.member.userId, chatId)).messages.at(-1).parts[0].text,
        'Ready for review.',
      );
      assert.equal(await executor.process(work), 'idle');
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  });
