import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { creditSummary } from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createTokenPlan } from '@tulipfarm/integrations/token-plans';
import { planSessionsForTest } from '@tulipfarm/agents/plan-sessions';
import { useModelCatalog } from './model-catalog-fixture.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

function useEnv(values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
}

test(
  'a Claude plan reply resumes one vendor session across its tool round and spends no credits',
  { timeout: 120000 },
  async t => {
    t.after(
      useEnv({
        CLAUDE_PLAN: 'on',
        INTEGRATION_CREDENTIAL_KEY: randomBytes(32).toString('hex'),
        INTEGRATION_CREDENTIAL_KEY_ID: 'plan-chat',
      }),
    );
    t.after(useModelCatalog(['claude-haiku', 'claude-sonnet', 'claude-plan-sonnet']));
    const requests = [];
    t.mock.method(globalThis, 'fetch', async url => {
      requests.push(String(url));
      throw new Error('Unexpected fetch');
    });
    const token = `sk-ant-oat01-${'p1an_T0ken-'.repeat(4)}`;
    const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
    const sessions = [];
    planSessionsForTest.useVendors(async (provider, used, model, _system, tools) => {
      const log = [];
      sessions.push({ provider, token: used, model, tools: tools.map(tool => tool.name), log });
      const read = tools.find(tool => tool.name === 'tables_definitions');
      const select = tools.find(tool => tool.name === 'select_action');
      assert.ok(read || select, 'a reply or completion-check session');
      return {
        send: async () => {
          log.push('send');
          if (select)
            return {
              kind: 'calls',
              text: '',
              calls: [
                { id: 'check', name: select.name, input: { decision: { status: 'completed', reason: 'Answered.' } } },
              ],
              usage,
            };
          return {
            kind: 'calls',
            text: '',
            calls: [{ id: 'read', name: read.name, input: { activity: 'Checking your tables' } }],
            usage,
          };
        },
        resume: async results => {
          log.push('resume');
          assert.deepEqual(
            results.map(result => [result.id, result.error]),
            [['read', false]],
          );
          return { kind: 'answer', text: 'You have no tables yet.', usage };
        },
        close: () => {},
      };
    });
    t.after(() => {
      planSessionsForTest.useVendors();
      planSessionsForTest.sessions.clear();
    });
    const f = await conversationFixture();
    try {
      const w = f.workspace;
      const plan = createTokenPlan({
        provider: 'claude',
        runtime: f.runtime,
        keyring: integrationCredentialKeyring(),
        verify: async () => ({ models: [{ slug: 'claude-sonnet-5', label: 'Claude Sonnet' }] }),
      });
      await plan.connectToken(w.id, w.userId, token);
      const chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const turn = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: 'claude-plan-sonnet',
        parts: [{ kind: 'text', text: 'Which tables do I have?' }],
      });
      const outcome = await createConversationActivities(f.runtime).processConversationReply({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: turn.turnId,
        generation: 0,
      });
      assert.equal(outcome, 'completed');
      const [asked, answered] = (await f.store.history(w.id, w.userId, chatId)).messages;
      assert.equal(asked.turn.status, 'completed');
      assert.deepEqual(
        asked.tools.map(tool => [tool.tool, tool.status]),
        [['tables.definitions', 'completed']],
      );
      assert.equal(answered.parts[0].text, 'You have no tables yet.');
      const [chatSession, ...checks] = sessions;
      assert.equal(chatSession.provider, 'claude');
      assert.equal(chatSession.token, token);
      assert.equal(chatSession.model, 'claude-sonnet-5');
      assert.ok(chatSession.tools.includes('tables_definitions'));
      assert.deepEqual(chatSession.log, ['send', 'resume']);
      assert.ok(checks.every(check => check.provider === 'claude' && check.token === token));
      assert.deepEqual(requests, []);
      const summary = await f.runtime.transaction(w.id, commonCompatibility, creditSummary);
      assert.equal(summary.used, 0);
      assert.equal(summary.held, 0);
    } finally {
      await f.close();
    }
  },
);
