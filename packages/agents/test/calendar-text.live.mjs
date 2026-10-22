import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createChatTools } from '../src/tools.ts';
import { googleRuntimeFixture } from './google-fixture.mjs';
import { meteredReply } from '../../../apps/worker/src/conversation-activities.ts';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';

const scenarios = [
  {
    name: 'dropped-period-correction',
    text: 'Create a Calendar event titled "QA." with description "Initial QA event."',
    summary: 'QA.',
    description: 'Initial QA event.',
    inject: true,
  },
  {
    name: 'apostrophe-unicode-whitespace',
    text: "Create a Calendar event. Use exactly the content between these delimiters. Title: <<<We're ready 🌷!>>> Description: <<<  Café e\u0301.\nWe're ready.  >>>",
    summary: "We're ready 🌷!",
    description: "  Café e\u0301.\nWe're ready.  ",
  },
  {
    name: 'replacement',
    text: 'Update event qa-event. Keep title "QA.". Replace description "Old." with "New.".',
    summary: 'QA.',
    description: 'New.',
    update: true,
  },
  {
    name: 'explicit-rewrite',
    text: 'Create a Calendar event titled "QA.". Rewrite the description "team sync" in title case.',
    summary: 'QA.',
    description: 'Team Sync',
  },
];

test('bounded live Calendar text checks with disposable proposals and credit rows', async t => {
  assert.ok(
    process.env.AZURE_FOUNDRY_API_KEY && process.env.AZURE_FOUNDRY_ENDPOINT,
    'Launch with the documented Foundry key and endpoint injection',
  );
  const f = await googleRuntimeFixture();
  const realFetch = globalThis.fetch;
  let totalRequests = 0;
  try {
    for (const scenario of scenarios.filter(
      scenario =>
        !process.env.CALENDAR_LIVE_CASES || process.env.CALENDAR_LIVE_CASES.split(',').includes(scenario.name),
    ))
      await t.test(scenario.name, async t => {
        await delay(65000);
        let requests = 0,
          checks = 0,
          injected = false;
        const observations = [];
        t.mock.method(globalThis, 'fetch', async (url, options) => {
          assert.ok(++requests <= 6 && ++totalRequests <= 24, 'live request budget exhausted');
          assert.equal(new URL(url).hostname, new URL(process.env.AZURE_FOUNDRY_ENDPOINT).hostname);
          const body = JSON.parse(options.body);
          const check = body.messages[0].content.startsWith('Independently identify');
          if (check) checks++;
          const response = await realFetch(url, options);
          const payload = await response.json();
          if (!response.ok) {
            observations.push({ check, status: response.status, retryAfter: response.headers.get('retry-after') });
            return Response.json(payload, { status: response.status, headers: response.headers });
          }
          const selected = payload.choices?.[0]?.message?.tool_calls?.[0]?.function;
          const parsed = selected ? JSON.parse(selected.arguments) : null;
          if (scenario.inject && !injected && parsed?.decision?.call?.operation?.kind === 'calendar.events.create') {
            parsed.decision.call.operation.event.description = 'Initial QA event';
            selected.arguments = JSON.stringify(parsed);
            injected = true;
          }
          observations.push({ check, decision: parsed?.decision ?? null, usage: payload.usage });
          return Response.json(payload);
        });
        const w = f.workspace.id,
          chatId = randomUUID();
        await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
        const sent = await f.store.send(w, f.member.userId, chatId, {
          messageId: randomUUID(),
          commandId: randomUUID(),
          model: 'deepseek-flash',
          timeZone: 'UTC',
          parts: [
            {
              kind: 'text',
              text: `${scenario.text} Use calendar primary, all-day start 2026-10-05 and end 2026-10-06. ${scenario.update ? 'The event identity and current fields above are already known. ' : ''}Propose only, do not execute or read other data.`,
            },
          ],
        });
        const reply = meteredReply(f.runtime, { mcp: null });
        const factory = runtime =>
          createGoogleOperations({
            runtime,
            integrations: createGoogleWorkspaceService({ ...f.serviceOptions, runtime }),
            fetcher: async (url, init) => {
              assert.equal(init.method, 'GET');
              assert.equal(String(url), 'https://www.googleapis.com/calendar/v3/calendars/primary');
              return Response.json({ id: 'primary', summary: 'Disposable QA calendar', timeZone: 'UTC' });
            },
          });
        const executor = createConversationExecutor(f.runtime, input =>
          reply({
            ...input,
            executeTool: (name, external, _action, sources, call, activity) => {
              assert.ok(
                name === 'google.propose' ||
                  (name === 'google.read' && call.operation.kind === 'calendar.calendars.get'),
                'live fixture permits proposals and fixture calendar metadata only',
              );
              return input.executeTool(
                name,
                external,
                context => createChatTools(context.runtime, { google: factory }).invokeWithSources(context, call),
                sources,
                call,
                activity,
              );
            },
          }),
        );
        const outcome = await executor.process({
          workspaceId: w,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 0,
        });
        const proposals = (
          await f.db.platform.query(
            `SELECT p.operation FROM ${f.table('tf_google_proposals')} p JOIN ${f.table('tf_conversation_tool_calls')} c ON c.id=p.command_id WHERE c.turn_id=$1`,
            [sent.turnId],
          )
        ).rows;
        const credits = (
          await f.db.platform.query(
            `SELECT id,provider_pico_usd FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1 ORDER BY id`,
            [chatId],
          )
        ).rows;
        process.stdout.write(
          `${JSON.stringify({ scenario: scenario.name, outcome, requests, checks, injected, proposals, credits, observations })}\n`,
        );
        assert.equal(outcome, 'completed');
        assert.equal(proposals.length, 1);
        assert.equal(proposals[0].operation.event.summary, scenario.summary);
        assert.equal(proposals[0].operation.event.description, scenario.description);
        assert.equal(checks, 1);
        assert.equal(credits.length, requests);
        assert.ok(credits.every(row => BigInt(row.provider_pico_usd) > 0n));
        assert.equal(injected, Boolean(scenario.inject));
        assert.equal(f.calls.length, 0);
      });
  } finally {
    await f.close();
  }
});
