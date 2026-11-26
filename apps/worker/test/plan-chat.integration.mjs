import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { creditSummary } from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createTokenPlan } from '@tulipfarm/integrations/token-plans';
import { PlanSessionError, planSessionsForTest } from '@tulipfarm/agents/plan-sessions';
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
  'a Claude plan reply resumes one vendor session across its tool round, spends no credits and clears its usage limit',
  { timeout: 120000 },
  async t => {
    t.after(
      useEnv({
        ANTHROPIC_API_KEY: 'synthetic-only',
        INTEGRATION_CREDENTIAL_KEY: randomBytes(32).toString('hex'),
        INTEGRATION_CREDENTIAL_KEY_ID: 'plan-chat',
      }),
    );
    t.after(useModelCatalog(['claude-haiku', 'claude-sonnet']));
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
      // The plan refused an earlier reply for its usage limit; answering this one shows it is available again.
      const limitedAt = async () =>
        (await f.db.platform.query(`SELECT usage_limited_at FROM ${f.table('tf_subscription_connections')}`)).rows.map(
          row => row.usage_limited_at,
        );
      await f.db.platform.query(`UPDATE ${f.table('tf_subscription_connections')} SET usage_limited_at = now()`);
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
      assert.deepEqual(await limitedAt(), [null]);
      // Each plan call is recorded for the Usage page against the plan, under the metered model it stands in for.
      const [connection] = (await f.db.platform.query(`SELECT id FROM ${f.table('tf_subscription_connections')}`)).rows;
      const recorded = (
        await f.db.platform.query(
          `SELECT model_id, model_provider, paid_by, connection_id, input_tokens, output_tokens, list_pico_usd, fallback
          FROM ${f.table('tf_model_usage')} WHERE flow_id = $1`,
          [chatId],
        )
      ).rows;
      assert.ok(recorded.length >= 2, 'the reply’s send and resume are both recorded');
      for (const row of recorded) {
        assert.deepEqual(
          { ...row, list_pico_usd: undefined },
          {
            model_id: 'claude-sonnet-5',
            model_provider: 'claude',
            paid_by: 'plan',
            connection_id: connection.id,
            input_tokens: '40',
            output_tokens: '10',
            list_pico_usd: undefined,
            fallback: false,
          },
        );
        assert.ok(BigInt(row.list_pico_usd) > 0n, 'a plan call is valued at the model’s list price');
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'a reply moves off the picked Claude account at its usage limit and the turn shows the switch',
  { timeout: 120000 },
  async t => {
    t.after(
      useEnv({
        ANTHROPIC_API_KEY: 'synthetic-only',
        INTEGRATION_CREDENTIAL_KEY: randomBytes(32).toString('hex'),
        INTEGRATION_CREDENTIAL_KEY_ID: 'plan-chat',
      }),
    );
    t.after(useModelCatalog(['claude-haiku', 'claude-sonnet']));
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Unexpected fetch');
    });
    const work = `sk-ant-oat01-${'w0rk_T0ken-'.repeat(4)}`;
    const home = `sk-ant-oat01-${'h0me_T0ken-'.repeat(4)}`;
    const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
    planSessionsForTest.useVendors(async (_provider, used, _model, _system, tools) => {
      const select = tools.find(tool => tool.name === 'select_action');
      return {
        send: async () => {
          if (used === work) throw new PlanSessionError(429, 'plan_usage_limit', 'Claude usage limit reached', 60);
          if (select)
            return {
              kind: 'calls',
              text: '',
              calls: [
                { id: 'check', name: select.name, input: { decision: { status: 'completed', reason: 'Answered.' } } },
              ],
              usage,
            };
          return { kind: 'answer', text: 'Answered on the other plan.', usage };
        },
        resume: async () => ({ kind: 'answer', text: 'Answered on the other plan.', usage }),
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
        verify: async token => ({
          models: [{ slug: 'claude-sonnet-5', label: 'Claude Sonnet' }],
          account: token === work ? 'work@example.com' : 'home@example.com',
        }),
      });
      await plan.connectToken(w.id, w.userId, work);
      const { connections } = await plan.connectToken(w.id, w.userId, home);
      const idOf = account => connections.find(connection => connection.account === account).connectionId;
      const [workId, homeId] = [idOf('work@example.com'), idOf('home@example.com')];
      const chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const turn = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: 'claude-plan-sonnet',
        planConnectionId: workId,
        parts: [{ kind: 'text', text: 'Hello?' }],
      });
      const outcome = await createConversationActivities(f.runtime).processConversationReply({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: turn.turnId,
        generation: 0,
      });
      assert.equal(outcome, 'completed');
      const [asked] = (await f.store.history(w.id, w.userId, chatId)).messages;
      assert.deepEqual(asked.turn.planSwitch, {
        fromConnectionId: workId,
        fromAccount: 'work@example.com',
        toConnectionId: homeId,
        toAccount: 'home@example.com',
        reason: 'usage-limit',
      });
    } finally {
      await f.close();
    }
  },
);
