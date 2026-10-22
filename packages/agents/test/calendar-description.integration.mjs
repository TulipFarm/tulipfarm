import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createChatTools } from '../src/tools.ts';
import { googleRuntimeFixture } from './google-fixture.mjs';
import { respondToConversation } from '../../../apps/worker/src/conversation-responder.ts';
import { azureChat } from '../../../apps/worker/test/native-chat-fixture.mjs';

const cases = [
  { request: "Use description 'We're ready.'", description: "We're ready.", rejected: 'We' },
  { request: 'Replace description "Old." with "New.".', description: 'New.' },
  { request: 'Rewrite the description "team sync" in title case.', description: 'Team Sync' },
  { request: 'The description should be "Initial QA event."', description: 'Initial QA event.' },
  {
    request: 'Use description "  Café e\u0301 🌷.\nWe\'re ready.  "',
    description: "  Café e\u0301 🌷.\nWe're ready.  ",
  },
  {
    request: 'Read the original event and copy its description exactly.',
    description: "Read-back description.\nWe're ready.",
    read: true,
  },
];

test('Calendar descriptions reach persisted owner review without English-regex coercion', async t => {
  const f = await googleRuntimeFixture();
  try {
    for (const kind of ['calendar.events.create', 'calendar.events.update']) {
      for (const scenario of cases)
        await t.test(`${kind}: ${scenario.request}`, async t => {
          const w = f.workspace.id,
            chatId = randomUUID();
          const request = `${kind === 'calendar.events.create' ? 'Create a new event.' : 'Update event qa-event.'} ${scenario.request}`;
          await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
          const sent = await f.store.send(w, f.member.userId, chatId, {
            commandId: randomUUID(),
            messageId: randomUUID(),
            timeZone: 'America/Los_Angeles',
            parts: [{ kind: 'text', text: request }],
          });
          const requests = [],
            reads = [];
          const factory = runtime =>
            createGoogleOperations({
              runtime,
              integrations: createGoogleWorkspaceService({ ...f.serviceOptions, runtime }),
              fetcher: async (url, options) => {
                reads.push({ url: String(url), method: options.method });
                return Response.json({
                  id: 'source',
                  summary: 'Original',
                  description: "Read-back description.\nWe're ready.",
                  start: { date: '2026-10-02' },
                  end: { date: '2026-10-03' },
                });
              },
            });
          t.mock.method(globalThis, 'fetch', async (_url, options) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            const last = body.messages.at(-1).content;
            let decision;
            if (body.messages[0].content.startsWith('Independently identify')) {
              const check = {
                summary: { mode: 'unspecified' },
                description: scenario.read
                  ? { mode: 'unspecified' }
                  : {
                      mode: scenario.request.startsWith('Rewrite') ? 'rewrite' : 'literal',
                      source: {
                        message: 0,
                        text: scenario.request.startsWith('Rewrite') ? scenario.request : scenario.description,
                      },
                    },
              };
              return Response.json({
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      tool_calls: [
                        {
                          id: 'call_check',
                          type: 'function',
                          function: { name: 'select_action', arguments: JSON.stringify({ decision: check }) },
                        },
                      ],
                    },
                  },
                ],
              });
            }
            if (last.startsWith('Untrusted tool result for google.propose:'))
              decision = { kind: 'answer', text: 'The event proposal is ready for owner review.' };
            else if (scenario.read && requests.length === 1)
              decision = {
                kind: 'tool',
                call: {
                  tool: 'google.read',
                  operation: { kind: 'calendar.events.get', calendarId: 'primary', eventId: 'source' },
                },
              };
            else {
              if (scenario.read)
                assert.equal(
                  JSON.parse(last.slice(last.indexOf(': ') + 2)).data.data.description,
                  "Read-back description.\nWe're ready.",
                );
              decision = {
                kind: 'tool',
                call: {
                  tool: 'google.propose',
                  operation: {
                    kind,
                    calendarId: 'primary',
                    ...(kind === 'calendar.events.update' ? { eventId: 'qa-event' } : {}),
                    event: {
                      summary: 'QA',
                      description: last.includes('rejected')
                        ? (scenario.rejected ?? scenario.description)
                        : scenario.description,
                      start: { date: '2026-10-02' },
                      end: { date: '2026-10-03' },
                    },
                  },
                },
              };
            }
            return Response.json(azureChat(decision));
          });
          const executor = createConversationExecutor(f.runtime, async ({ messages, executeTool, timeZone }) =>
            respondToConversation(
              {
                provider: 'azure',
                endpoint: 'https://synthetic.openai.azure.com/',
                model: 'DeepSeek-V4-Flash',
                auth: { kind: 'api-key', value: 'synthetic' },
              },
              messages,
              call =>
                executeTool(call.tool, true, context =>
                  createChatTools(context.runtime, { google: factory }).invokeWithSources(context, call),
                ),
              undefined,
              undefined,
              false,
              timeZone,
            ),
          );
          assert.equal(
            await executor.process({ workspaceId: w, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
            'completed',
          );
          const proposals = (
            await f.db.platform.query(
              `SELECT p.id FROM ${f.table('tf_google_proposals')} p JOIN ${f.table('tf_conversation_tool_calls')} c ON c.id=p.command_id WHERE c.turn_id=$1`,
              [sent.turnId],
            )
          ).rows;
          assert.equal(proposals.length, 1);
          assert.equal(
            (await factory(f.runtime).proposal(w, f.member.userId, proposals[0].id)).operation.event.description,
            scenario.description,
          );
          assert.equal(
            (await f.store.history(w, f.member.userId, chatId)).messages.at(-1).parts[0].text,
            'The event proposal is ready for owner review.',
          );
          assert.equal(requests.length, scenario.read ? 4 : 3);
          assert.deepEqual(
            reads,
            scenario.read
              ? [{ url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events/source', method: 'GET' }]
              : [],
          );
          assert.equal(
            JSON.parse(requests[0].messages[1].content.split('\n')[2]).clock.timeZone,
            'America/Los_Angeles',
          );
        });
    }
  } finally {
    await f.close();
  }
});
