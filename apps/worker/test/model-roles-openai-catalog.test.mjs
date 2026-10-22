import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// An operator catalog of only OpenAI-model families on the Azure route, replacing the shipped catalog. Its families
// declare every role except compaction.
process.env.MODEL_CATALOG_FILE = fileURLToPath(
  new URL('../../../packages/config/test/fixtures/model-catalog-openai-only.json', import.meta.url),
);
process.env.MODEL_CATALOG_MODE = 'replace';
delete process.env.MODEL_CATALOG;

const { modelRoleWarnings } = await import('@tulipfarm/config');
const { inferWithSystem } = await import('@tulipfarm/agents/inference');
const { effectiveCompactionPolicy } = await import('@tulipfarm/agents/compaction-policy');
const { conversationModel, roleModel } = await import('../src/conversation-model.ts');
const { chatTitleModel } = await import('../src/conversation-activities.ts');
const { heartbeatProcessor } = await import('../src/google-heartbeat-activities.ts');

const env = {
  MODEL_FAMILIES: 'openai-mini,openai-main',
  AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/',
  AZURE_FOUNDRY_API_KEY: 'synthetic-key',
};

/** Answers every Azure chat-completions request with `text`, recording the requests. */
function azure(t, text) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    return Response.json({
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
    });
  });
  return requests;
}

async function roundTrip(t, model) {
  const requests = azure(t, 'Synthetic answer');
  assert.equal(await inferWithSystem(model.route, 'Be brief.', [{ role: 'user', text: 'Hello' }]), 'Synthetic answer');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${env.AZURE_FOUNDRY_ENDPOINT}openai/v1/chat/completions`);
  return requests[0].body.model;
}

// The credit meter and model availability of one workspace with no stored policy or availability rows.
function workspace() {
  const usage = new Map();
  const client = {
    async query(sql, values = []) {
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('tf_model_availability') || sql.includes('tf_compaction_policy'))
        return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT 1 FROM')) return { rows: [], rowCount: usage.has(values[0]) ? 1 : 0 };
      if (sql.startsWith('INSERT INTO')) {
        const [id, flow_id, model_id, agent_id, activity, reserved] = values;
        usage.set(id, { flow_id, model_id, agent_id, activity, reserved, charged: null, provider_pico_usd: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT flow_id')) return { rows: [usage.get(values[0])], rowCount: 1 };
      if (sql.includes('COALESCE(sum(provider_pico_usd)')) return { rows: [{ cost: '0', charged: '0' }], rowCount: 1 };
      if (sql.startsWith('UPDATE')) {
        Object.assign(usage.get(values[0]), { charged: values[1], provider_pico_usd: values[2] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const tx = { client, schema: 'workspace' };
  return { tx, usage, runtime: { transaction: async (_workspace, _compatibility, operation) => operation(tx) } };
}

test('titles use the title role of an OpenAI-only catalog', async t => {
  const model = chatTitleModel(env);
  assert.equal(model.price.familyId, 'openai-mini');
  assert.equal(model.route.maxOutputTokens, 256);
  assert.equal(await roundTrip(t, model), 'gpt-6-luna');
});

test('skill review and the plan specialist use the review and plan roles', async t => {
  for (const role of ['review', 'plan']) {
    const model = roleModel(role, env);
    assert.equal(model.price.familyId, 'openai-main', role);
    assert.equal(await roundTrip(t, model), 'gpt-6-sol', role);
  }
});

test('compaction falls back to the default chat family when no family has the compaction role', async t => {
  const { tx } = workspace();
  const previous = process.env.MODEL_FAMILIES;
  process.env.MODEL_FAMILIES = env.MODEL_FAMILIES;
  t.after(() => {
    if (previous === undefined) delete process.env.MODEL_FAMILIES;
    else process.env.MODEL_FAMILIES = previous;
  });
  const policy = await effectiveCompactionPolicy(tx);
  assert.deepEqual(policy.families, ['openai-main']);
  assert.equal(await roundTrip(t, conversationModel(policy.families[0], env)), 'gpt-6-sol');
});

test('the Gmail heartbeat answers with the heartbeat role and meters its tokens', async t => {
  const requests = azure(t, 'Nothing needs your attention.');
  const { tx, usage, runtime } = workspace();
  const processor = heartbeatProcessor(runtime, roleModel('heartbeat', env));
  const result = await processor({
    authorize: async operation => operation(tx),
    dispatch: async operation => operation(),
    work: { workspaceId: '11111111-1111-4111-8111-111111111111' },
    itemId: 'item',
    epoch: 1,
    message: { subject: 'Hello' },
    instructions: 'Summarize.',
  });
  assert.equal(result, 'Nothing needs your attention.');
  assert.equal(requests[0].body.model, 'gpt-6-luna');
  assert.equal(usage.get('gmail:item:1').model_id, 'openai-mini-1');
});

test('startup warns that no family has the compaction role', () => {
  assert.deepEqual(modelRoleWarnings(env, ['title', 'compaction', 'review', 'plan', 'heartbeat']), [
    'No family in MODEL_FAMILIES has the catalog role "compaction"; using openai-main. Add "compaction" to a family\'s roles to choose one.',
  ]);
});
