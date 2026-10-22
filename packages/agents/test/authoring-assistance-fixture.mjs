import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inferenceRouteSchema } from '../src/inference.ts';
import { modelEnvironment } from '../src/model-environment.ts';
import { createAgentAuthoringAssistance } from '../src/authoring-assistance.ts';
import { creditGate, registerExtension, unlimitedCredits } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests account credits against a workspace balance, as a billing extension would.
export const recordedUsage = [];
if (creditGate() === unlimitedCredits) {
  await registerExtension(creditAccountExtension, { app: 'api', env: {} });
  await registerExtension(
    {
      name: 'usage-recorder',
      register(slots) {
        slots.usageSink({
          record: usage => {
            recordedUsage.push(usage);
          },
        });
      },
    },
    { app: 'api', env: {} },
  );
}

export const workspaceId = '11111111-1111-4111-8111-111111111111';
export const membershipId = '22222222-2222-4222-8222-222222222222';
export const userId = '33333333-3333-4333-8333-333333333333';
export const skillId = '44444444-4444-4444-8444-444444444444';
export const source = { version: 1, fingerprint: 'draft-fingerprint-1' };
export const googleTransportOnlyRoute = inferenceRouteSchema.parse({
  provider: 'google',
  endpoint: 'https://generativelanguage.googleapis.com/',
  model: 'gemini-3.8-flash',
  apiKey: 'fixture',
  maxOutputTokens: 2048,
});
export const improveInput = () => ({
  requestId: randomUUID(),
  source: { ...source },
  instructions: 'Help staff understand the policies they supply. Ask when a policy is missing.',
});
export const previewInput = () => ({
  requestId: randomUUID(),
  source: { ...source },
  definition: {
    name: 'People helper',
    instructions: 'Answer kindly. Ask for missing policy.',
    tools: [],
    modelFamilyId: 'gpt-sol',
  },
  messages: [{ role: 'user', content: 'How would you greet a new hire?' }],
});

export function providerResponse(
  model = 'gpt-6-luna',
  text = 'Help people understand supplied policy. Ask for missing policy.',
) {
  if (model.startsWith('claude-'))
    return {
      model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
  if (model.startsWith('gemini-'))
    return {
      modelVersion: model,
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 },
    };
  if (model === 'gpt-6-astra')
    return {
      model,
      status: 'completed',
      output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50, input_tokens_details: { cached_tokens: 0 } },
    };
  return {
    model,
    choices: [{ finish_reason: 'stop', message: { content: text } }],
    usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
  };
}

export function authoringFixture() {
  const state = {
    allowed: true,
    eligible: true,
    enabled: true,
    skillAllowed: true,
    skillReviewed: true,
    sources: [],
    skillInstructions: 'Follow the reviewed procedure only.',
    settlementFailure: false,
    available: 100000n * 1_000_000_000_000n,
    ledger: new Map(),
    queries: [],
    requests: [],
    response: undefined,
    beforeProvider: undefined,
    afterReserve: undefined,
  };
  const environment = modelEnvironment({
    AZURE_FOUNDRY_ENDPOINT: 'https://fixture.openai.azure.com/',
    AZURE_FOUNDRY_API_KEY: 'fixture',
    ANTHROPIC_API_KEY: 'fixture',
  });
  const rows = values => ({ rowCount: values.length, rows: values });
  const query = async (sql, values = []) => {
    state.queries.push({ sql, values });
    if (sql.includes('tf_authorization_lock')) return rows([{ id: 1 }]);
    if (sql.includes('tf_memberships'))
      return rows(state.allowed ? [{ id: membershipId, user_id: userId, role: 'member' }] : []);
    if (sql.includes('tf_model_availability'))
      return rows(
        state.enabled ? [] : [{ familyId: 'gpt-luna', enabled: false, revision: 1, lastDisabledRevision: 1 }],
      );
    if (sql.startsWith('SELECT 1 FROM') && sql.includes('tf_workspace_skills')) {
      assert.equal(values[2], 'use');
      return rows(state.skillAllowed ? [{ allowed: 1 }] : []);
    }
    if (sql.includes('JOIN "fixture"."tf_workspace_skill_reviews"'))
      return rows(
        state.skillReviewed
          ? [{ definition: { name: 'Reviewed skill', instructions: state.skillInstructions, sources: state.sources } }]
          : [],
      );
    if (sql.includes('tf_workspace_skill_revisions'))
      return rows([
        { definition: { name: 'Reviewed skill', instructions: state.skillInstructions, sources: state.sources } },
      ]);
    if (sql.includes('tf_chat_authoring_drafts')) return rows([]);
    if (sql.startsWith('SELECT to_regclass')) return rows([{ installed: false }]);
    if (sql.includes('tf_table_catalog')) return rows([]);
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return rows([{}]);
    if (sql.includes('tf_credit_account')) {
      if (sql.startsWith('SELECT available')) return rows([{ available: state.available.toString() }]);
      if (sql.includes('available=available-$1')) {
        state.available -= BigInt(values[0]);
        return rows([]);
      }
    }
    if (sql.includes('tf_credit_usage')) {
      if (sql.startsWith('SELECT id FROM') && sql.includes('id LIKE'))
        return rows(
          [...state.ledger.values()]
            .filter(row => row.charged === null && row.created_at < Date.now() - values[1] * 1000)
            .slice(0, 100)
            .map(row => ({ id: row.id })),
        );
      if (sql.startsWith('SELECT flow_id FROM')) {
        const previous = state.ledger.get(values[0]);
        return rows(previous ? [{ flow_id: previous.flow_id }] : []);
      }
      if (sql.startsWith('SELECT count(*)'))
        return rows([
          {
            active: [...state.ledger.values()].filter(row => row.charged === null).length,
            recent: [...state.ledger.values()].filter(row => row.created_at > Date.now() - 60000).length,
          },
        ]);
      if (sql.startsWith('SELECT 1 FROM')) return rows(state.ledger.has(values[0]) ? [{ exists: 1 }] : []);
      if (sql.startsWith('INSERT')) {
        const [id, flow_id, model_id, agent_id, activity, reserved, pricing_revision] = values;
        assert.equal(agent_id, null);
        assert.equal(activity, 'other');
        state.ledger.set(id, {
          id,
          flow_id,
          model_id,
          agent_id,
          activity,
          reserved,
          charged: null,
          provider_pico_usd: null,
          pricing_revision,
          created_at: Date.now(),
        });
        state.afterReserve?.();
        return rows([]);
      }
      if (sql.startsWith('SELECT flow_id,model_id,agent_id,activity,reserved,charged')) {
        const previous = state.ledger.get(values[0]);
        return rows(previous ? [previous] : []);
      }
      if (sql.startsWith('SELECT COALESCE(sum(provider_pico_usd)')) {
        const group = [...state.ledger.values()].filter(row => row.flow_id === values[0]);
        return rows([
          {
            cost: group.reduce((sum, row) => sum + BigInt(row.provider_pico_usd ?? 0), 0n).toString(),
            charged: group.reduce((sum, row) => sum + BigInt(row.charged ?? 0), 0n).toString(),
          },
        ]);
      }
      if (sql.startsWith('UPDATE')) {
        if (state.settlementFailure) throw new Error('fixture settlement outage');
        Object.assign(state.ledger.get(values[0]), { charged: values[1], provider_pico_usd: values[2] });
        return rows([]);
      }
      if (sql.startsWith('SELECT charged FROM')) return rows([{ charged: state.ledger.get(values[0])?.charged }]);
    }
    assert.fail(`Unexpected SQL: ${sql}`);
  };
  let tail = Promise.resolve();
  const runtime = {
    transaction: async (workspace, _compatibility, operation) => {
      assert.equal(workspace, workspaceId);
      const previous = tail;
      let release;
      tail = new Promise(resolve => {
        release = resolve;
      });
      await previous;
      const saved = structuredClone(state.ledger),
        available = state.available;
      try {
        return await operation({ client: { query }, schema: 'fixture', workspaceId, commonVersion: 41 });
      } catch (error) {
        state.ledger = saved;
        state.available = available;
        throw error;
      } finally {
        release();
      }
    },
  };
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    state.requests.push({ url, init, body });
    await state.beforeProvider?.(init);
    const model = body.model ?? /models\/([^:]+):/.exec(String(url))?.[1];
    return state.response ? state.response(model, init) : Response.json(providerResponse(model));
  };
  const eligible = async ({ modelFamilyId }) => state.eligible && environment.resolve(modelFamilyId) !== null;
  const service = () =>
    createAgentAuthoringAssistance({ runtime, environment, eligible, fetcher, defaultFamilyId: 'gpt-luna' });
  return { state, runtime, environment, fetcher, eligible, service: service(), restart: service };
}
