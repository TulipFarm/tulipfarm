import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { shippedModelCatalogPath } from '@tulipfarm/config';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { createAgentPlans } from '../../../packages/agents/src/plans.ts';
import { createPlanRuntime } from '../../../packages/agents/src/plan-runtime.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createFiles } from '../../../packages/files/src/index.ts';
import { png } from '../../../packages/memory-core/test/fixtures/parser-media.mjs';
import { createPlanComposition } from '../src/plan-composition.ts';
import { anthropicText, anthropicTools } from './native-chat-fixture.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const chatModel = (id, imageModel, extra = {}) => ({
  ...shipped.models.find(entry => entry.id === id),
  default: false,
  imageModel,
  ...extra,
});
const aspects = { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' };
const perImage = usd => ({
  usdPerImage: {
    standard: { square: usd, portrait: usd, landscape: usd },
    high: { square: usd, portrait: usd, landscape: usd },
  },
});
// Sonnet, the plan role's model, draws with OpenAI; Haiku draws with xAI.
const catalog = JSON.stringify({
  ...shipped,
  models: [
    chatModel('claude-sonnet', 'gpt-image', { default: true }),
    chatModel('claude-haiku', 'grok-image'),
    chatModel('claude-opus', null),
  ],
  imageModels: [
    {
      id: 'gpt-image',
      name: 'GPT Image',
      vendor: 'openai',
      routes: [{ provider: 'openai', model: 'gpt-image-1', api: 'openai-images' }],
      edits: true,
      maxSources: 4,
      aspects,
      pricing: perImage(0.04),
    },
    {
      id: 'grok-image',
      name: 'Grok Imagine',
      vendor: 'xai',
      routes: [{ provider: 'xai', model: 'grok-imagine-image', api: 'xai-images' }],
      edits: true,
      maxSources: 1,
      aspects: { square: '1:1', portrait: '3:4', landscape: '16:9' },
      pricing: perImage(0.07),
    },
  ],
});
const imageHosts = ['api.openai.com', 'api.x.ai'];

/**
 * A chat with one message, a Posters folder, and a fetch whose chat model answers with `state.script` in order (a list
 * of images.generate calls or text) and whose image providers answer one PNG.
 */
async function setup(t) {
  const f = await conversationFixture();
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'MODEL_CATALOG', 'MODEL_CATALOG_FILE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'synthetic-test-key',
    OPENAI_API_KEY: 'openai-test-key',
    XAI_API_KEY: 'xai-test-key',
    MODEL_CATALOG: catalog,
    FEATURE_FLAG_IMAGES: 'true',
  });
  delete process.env.MODEL_CATALOG_FILE;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    delete process.env.FEATURE_FLAG_IMAGES;
    await f.close();
  });
  const w = f.workspace;
  await f.db.platform.query(
    `UPDATE ${f.table('tf_credit_account')} SET available=1000000000000000,granted=1000000000000000`,
  );
  const objects = new Map();
  const files = createFiles(f.runtime, {
    putIfAbsent: async (key, value) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(value));
    },
    read: async key => objects.get(key),
    remove: async key => void objects.delete(key),
  });
  const folder = await files.createFolder(w.id, w.userId, randomUUID(), { name: 'Posters', parentId: null });
  const chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w.id, w.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Make a poster.' }],
  });
  const drawn = Buffer.from(await png(16, 16, '#2a7'));
  const state = { script: [], chat: [], images: [] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const host = new URL(url).host;
    if (imageHosts.includes(host)) {
      state.images.push({ host, body: JSON.parse(options.body) });
      return Response.json({ data: [{ b64_json: drawn.toString('base64'), mime_type: 'image/png' }] });
    }
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(options.body);
    state.chat.push(body);
    const next = state.script.shift() ?? 'Done.';
    return Response.json(
      typeof next === 'string'
        ? anthropicText(next)
        : anthropicTools(next.map(call => ({ tool: 'images.generate', ...call }))),
    );
  });
  const plans = createAgentPlans(f.runtime);
  const create = specialist =>
    plans.create(
      w.id,
      w.userId,
      chatId,
      randomUUID(),
      {
        title: 'Poster',
        specialists: [
          {
            key: 'artist',
            name: 'Artist',
            role: 'Draws posters',
            instructions: 'Draw what the task asks.',
            ...specialist,
          },
        ],
        tasks: [{ key: 'poster', title: 'Draw the poster', assignee: { kind: 'specialist', specialist: 'artist' } }],
        budget: { toolCalls: 16, activeMilliseconds: 120000, credits: 100 },
      },
      sent.turnId,
    );
  const disable = familyId =>
    f.db.platform.query(
      `INSERT INTO ${f.table('tf_model_availability')} (family_id,enabled,revision,last_disabled_revision,editor_membership_id) VALUES ($1,false,1,1,$2)`,
      [familyId, w.membershipId],
    );
  const run = async plan => {
    const [attemptId] = (await createPlanRuntime(f.runtime).step(w.id, plan.id)).specialists;
    assert.ok(attemptId);
    await createPlanComposition({
      runtime: f.runtime,
      discover: async () => [],
      wakePlan: async () => {},
      wakeTask: async () => {},
      files,
    }).activities.runPlanSpecialist(w.id, attemptId);
    const attempt = (
      await f.db.platform.query(
        `SELECT status,failure_code,result FROM ${f.table('tf_agent_plan_attempts')} WHERE id=$1`,
        [attemptId],
      )
    ).rows[0];
    return { attemptId, attempt };
  };
  return { f, w, plans, folder, state, create, disable, run };
}

test('a plan step naming a family the workspace turned off, or one not served, is refused when composed', async t => {
  const { plans, create, disable, w } = await setup(t);
  await disable('claude-haiku');
  for (const modelFamilyId of ['claude-haiku', 'claude-unknown'])
    await assert.rejects(
      create({ modelFamilyId, tools: ['knowledge.search'] }),
      error => error.code === 'model-unavailable' && /artist/.test(error.message),
      modelFamilyId,
    );
  // An update adding such a specialist is refused the same way.
  const plan = await create({ tools: ['knowledge.search'] });
  await assert.rejects(
    plans.update(w.id, w.userId, plan.id, randomUUID(), {
      expectedVersion: plan.version,
      specialists: [
        {
          key: 'other',
          name: 'Other',
          role: 'Draws',
          instructions: 'Draw.',
          modelFamilyId: 'claude-haiku',
          tools: ['web.search'],
        },
      ],
      mutations: [
        { op: 'add', task: { key: 'other', title: 'Other', assignee: { kind: 'specialist', specialist: 'other' } } },
      ],
    }),
    error => error.code === 'model-unavailable',
  );
});

test('a specialist whose step family was turned off after the plan was composed fails without a model call', async t => {
  const { create, disable, run, state } = await setup(t);
  const plan = await create({ modelFamilyId: 'claude-haiku', tools: ['knowledge.search'] });
  await disable('claude-haiku');
  const { attempt } = await run(plan);
  assert.equal(attempt.failure_code, 'model-unavailable');
  assert.equal(state.chat.length, 0);
});

test("a specialist generates images with its step family's paired image model, into a folder, billed to its attempt", async t => {
  const { f, create, run, state, folder } = await setup(t);
  const plan = await create({ modelFamilyId: 'claude-haiku', tools: ['images.generate'] });
  state.script.push([{ prompt: 'A spring poster' }], [{ prompt: 'A spring poster', folderId: folder.id }], 'Drew it.');
  const { attemptId, attempt } = await run(plan);
  assert.equal(attempt.failure_code, null, JSON.stringify(attempt));
  // The specialist runs on Haiku, and its images on Haiku's paired model, not the plan role's.
  assert.equal(state.chat[0].model, shipped.models.find(m => m.id === 'claude-haiku').routes[0].model);
  assert.deepEqual(
    state.images.map(image => [image.host, image.body.model]),
    [['api.x.ai', 'grok-imagine-image']],
  );
  // Autonomous work names a folder: the first call, without one, was refused before anything was generated.
  assert.match(JSON.stringify(state.chat[1].messages), /folder/);
  const rows = (
    await f.db.platform.query(
      `SELECT g.origin_kind,g.origin_id,g.state,g.image_model_id,u.flow_id,u.charged FROM ${f.table('tf_image_generations')} g JOIN ${f.table('tf_credit_usage')} u ON u.id=g.usage_id`,
    )
  ).rows;
  assert.deepEqual(
    rows.map(row => [row.origin_kind, row.origin_id, row.state, row.image_model_id, row.flow_id, row.charged !== null]),
    [['run', attemptId, 'saved', 'grok-image', attemptId, true]],
  );
});
