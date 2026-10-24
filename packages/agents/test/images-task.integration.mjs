import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { png } from '../../memory-core/test/fixtures/parser-media.mjs';

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.OPENAI_API_KEY ||= 'test-key';
delete process.env.MODEL_CATALOG_FILE;
delete process.env.FEATURE_FLAG_IMAGES;
process.env.MODEL_CATALOG = JSON.stringify({
  version: 1,
  models: [
    {
      id: 'acme-chat',
      name: 'Acme Chat',
      vendor: 'acme',
      routes: [{ provider: 'anthropic', model: 'acme-chat-1' }],
      default: true,
      imageModel: 'gpt-image',
      limits: { maxInputTokens: 100000, maxOutputTokens: 4096 },
      pricing: [{ usdPerMillionTokens: { input: 1, output: 2 } }],
    },
  ],
  imageModels: [
    {
      id: 'gpt-image',
      name: 'GPT Image',
      vendor: 'openai',
      routes: [{ provider: 'openai', model: 'gpt-image-1', api: 'openai-images' }],
      default: true,
      edits: true,
      maxSources: 4,
      aspects: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
      pricing: {
        usdPerImage: {
          standard: { square: 0.04, portrait: 0.06, landscape: 0.06 },
          high: { square: 0.17, portrait: 0.25, landscape: 0.25 },
        },
      },
    },
  ],
});

const { createWorkspaceRuntime } = await import('@tulipfarm/workspace-storage/runtime');
const { workspaceTableMigrations } = await import('@tulipfarm/workspaces/table-migrations');
const { fixture } = await import('../../workspace-storage/test/integration/fixture.mjs');
const { createFiles } = await import('../../files/dist/index.js');
const { savedTaskAgent } = await import('./task-fixture.mjs');
const { createAgentTasks } = await import('../src/tasks.ts');
const { createTaskRuntime } = await import('../src/task-runtime.ts');
const { createModelRouteHealth } = await import('../src/model-health.ts');
const { createAgentExecutor } = await import('../src/executor.ts');
const { modelEnvironment } = await import('../src/model-environment.ts');
const { modelNativeTools } = await import('../src/model.ts');
const { runImageChoice } = await import('../src/image-generation.ts');
const { creditUnitsForProviderCost } = await import('@tulipfarm/workspace-storage/credits');

/** A PNG with an ancillary `caBX` chunk after IHDR, standing in for a C2PA manifest the provider signed. */
async function signedPng() {
  const image = Buffer.from(await png(8, 6));
  const type = Buffer.from('caBX'),
    data = Buffer.from('c2pa-manifest-standin'),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const afterHeader = 8 + 4 + 4 + 13 + 4;
  assert.equal(image.subarray(12, 16).toString(), 'IHDR');
  return Buffer.concat([image.subarray(0, afterHeader), length, type, data, crc, image.subarray(afterHeader)]);
}

/**
 * A workspace with a member who owns a task agent that lists images.generate, a Posters folder, and a task engine whose
 * model answers with `decisions` in order. Image requests go to `state.draw(signal, n)`, which answers one signed PNG.
 */
async function setup(t, { choose = runImageChoice } = {}) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    delete process.env.FEATURE_FLAG_IMAGES;
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations()),
    table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, ['100000000000000']);
  const user = randomUUID(),
    member = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['images.generate']);
  await createAgentExecutor({ runtime }).configure(
    w.id,
    { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const objects = new Map();
  const files = createFiles(runtime, {
    putIfAbsent: async (key, value) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(value));
    },
    read: async key => objects.get(key),
    remove: async key => {
      objects.delete(key);
    },
  });
  const folder = await files.createFolder(w.id, user, randomUUID(), { name: 'Posters', parentId: null });

  const signed = await signedPng();
  const providerCalls = [];
  const realFetch = globalThis.fetch;
  const answer = () =>
    Response.json({ data: [{ b64_json: signed.toString('base64') }], usage: { input_tokens: 10, output_tokens: 100 } });
  const state = { draw: async () => answer() };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input) !== 'https://api.openai.com/v1/images/generations') return realFetch(input, init);
    providerCalls.push({ headers: init.headers, body: JSON.parse(init.body) });
    return state.draw(init.signal, providerCalls.length);
  });

  const decisions = [];
  const inputs = [];
  const model = {
    ...modelEnvironment().continuity(key => createModelRouteHealth(db.platform, key)),
    infer: async (_resolution, input) => {
      inputs.push(input);
      return {
        kind: 'success',
        decision: decisions.shift() ?? { kind: 'answer', text: 'Done.' },
        actualModel: 'acme-chat-1',
        requestId: randomUUID(),
        usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      };
    },
  };
  const tasks = createAgentTasks(runtime);
  const engine = createTaskRuntime(
    runtime,
    model,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { files, choose },
  );
  const start = (text, limits = {}) =>
    tasks.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope: [],
      text,
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000, ...limits },
    });
  const run = async id => {
    for (let n = 0; n < 16 && ['pending', 'waiting-approval'].includes((await tasks.read(w.id, user, id)).status); n++)
      await engine.process(w.id, id);
    return tasks.read(w.id, user, id);
  };
  const imageCredits = async () =>
    (
      await db.platform.query(
        `SELECT id,flow_id,activity,agent_id,provider_pico_usd::text,charged::text FROM ${table('tf_credit_usage')} WHERE id LIKE 'image:%'`,
      )
    ).rows;

  return {
    db,
    w,
    table,
    runtime,
    user,
    member,
    agent,
    files,
    objects,
    folder,
    signed,
    answer,
    state,
    providerCalls,
    decisions,
    inputs,
    tasks,
    engine,
    start,
    run,
    imageCredits,
  };
}

test(
  'a private task generates images with images.generate only into a folder its owner names, billed in the task flow',
  { timeout: 180000 },
  async t => {
    const {
      db,
      w,
      table,
      user,
      member,
      agent,
      files,
      objects,
      folder,
      signed,
      providerCalls,
      decisions,
      inputs,
      tasks,
      start,
      run,
      imageCredits,
    } = await setup(t);
    const prompt = 'A watercolour poster of tulips at dawn';
    decisions.push(
      { kind: 'tool', text: 'Draw the poster', call: { tool: 'images.generate', prompt } },
      {
        kind: 'tool',
        text: 'Draw the poster into Posters',
        call: { tool: 'images.generate', prompt, folderId: folder.id },
      },
      { kind: 'answer', text: 'The poster is in Posters.' },
    );
    const task = await start('Make a poster of tulips.');
    const finished = await run(task.id);
    assert.equal(finished.status, 'completed');
    assert.equal(inputs.length, 3, 'the task carries on after each images.generate result');
    assert.equal(inputs[0].images, true, 'the flag is on and the agent lists images.generate');
    assert.ok(modelNativeTools(inputs[0]).tools.some(tool => tool.name === 'images_generate'));

    const runId = (
      await db.platform.query(`SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1`, [task.id])
    ).rows[0].run_id;
    const calls = (
      await db.platform.query(
        `SELECT call,status,result FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1 ORDER BY sequence`,
        [runId],
      )
    ).rows;
    assert.equal(calls.length, 2);

    // 1. No folder: refused before anything is generated or charged.
    assert.equal(calls[0].status, 'completed');
    assert.equal(calls[0].result.error, 'destination-required');
    assert.match(calls[0].result.instruction, /folder/);

    // 2. A folder the owner can add to: one image, saved byte for byte.
    assert.equal(calls[1].status, 'completed');
    assert.equal(calls[1].result.error, undefined);
    assert.equal(providerCalls.length, 1, 'only the call with a destination reaches the provider');
    assert.deepEqual(providerCalls[0].body, {
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    });
    const generations = (
      await db.platform.query(
        `SELECT id,origin_kind,origin_id,state,prompt,image_model_id,catalog_revision,creator_membership_id FROM ${table('tf_image_generations')}`,
      )
    ).rows;
    assert.equal(generations.length, 1);
    const [generation] = generations;
    assert.equal(generation.origin_kind, 'run');
    assert.equal(generation.origin_id, runId);
    assert.equal(generation.state, 'saved');
    assert.equal(generation.prompt, prompt);
    assert.equal(generation.image_model_id, 'gpt-image');
    assert.equal(generation.creator_membership_id, member);
    assert.ok(generation.catalog_revision);
    assert.deepEqual(
      calls[1].result.images.map(image => [image.id, image.state, image.file?.id, image.file?.parentId]),
      [[generation.id, 'saved', generation.id, folder.id]],
      'the result names the saved file',
    );

    const saved = (
      await db.platform.query(
        `SELECT id,parent_id,kind,media_type,object_key,sha256 FROM ${table('tf_files')} WHERE id=$1`,
        [generation.id],
      )
    ).rows[0];
    assert.ok(saved, 'the file id is the generation id');
    assert.equal(saved.parent_id, folder.id);
    assert.equal(saved.kind, 'file');
    assert.equal(saved.media_type, 'image/png');
    assert.equal(saved.sha256, createHash('sha256').update(signed).digest('hex'));
    const object = objects.get(`${w.id}/files/${saved.object_key}`);
    assert.ok(object && Buffer.compare(object, signed) === 0, 'the saved bytes keep the C2PA chunk unchanged');
    assert.equal((await files.read(w.id, user, generation.id)).parentId, folder.id, 'the owner can open it');

    const pinned = (await db.platform.query(`SELECT image_models FROM ${table('tf_agent_runs')} WHERE id=$1`, [runId]))
      .rows[0].image_models;
    assert.equal(pinned.familyId, 'acme-chat');
    assert.equal(pinned.imageModelId, 'gpt-image');
    assert.equal(pinned.catalogRevision, generation.catalog_revision);

    const credits = await imageCredits();
    assert.equal(credits.length, 1, 'the refused call left no image credit row');
    assert.match(credits[0].id, new RegExp(`^image:${generation.id}:`));
    assert.equal(credits[0].flow_id, finished.flowId, 'the image is billed in the task flow');
    assert.equal(credits[0].activity, 'agent');
    assert.equal(credits[0].agent_id, agent.agentId);
    assert.equal(credits[0].provider_pico_usd, '40000000000', '0.04 USD for one standard square image');
    assert.notEqual(credits[0].charged, null);
    assert.equal((await tasks.history(w.id, user, task.id)).messages.at(-1).text, 'The poster is in Posters.');

    // 3. With the flag off, the task model is not offered images.generate.
    process.env.FEATURE_FLAG_IMAGES = 'false';
    const before = inputs.length;
    const off = await start('Make another poster.');
    assert.equal((await run(off.id)).status, 'completed');
    assert.equal(inputs.length, before + 1);
    const offInput = inputs.at(-1);
    assert.equal(offInput.images, undefined);
    assert.ok(offInput.definition.tools.includes('images.generate'), 'the agent still lists the tool');
    assert.ok(!modelNativeTools(offInput).tools.some(tool => tool.name === 'images_generate'));
    assert.equal(providerCalls.length, 1);
    assert.equal((await imageCredits()).length, 1);
  },
);

/**
 * A provider request that waits for its signal. One left running past `lateMs` answers with an image anyway, as a
 * provider does when nothing cancels the request.
 */
const hang = (signal, answer, aborted, lateMs = 8000) =>
  new Promise((resolve, reject) => {
    const late = setTimeout(() => resolve(answer()), lateMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(late);
        aborted.push(true);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });

test(
  'a task whose active time ends mid-generation aborts its image requests and settles every hold',
  { timeout: 120000 },
  async t => {
    const f = await setup(t);
    const aborted = [];
    f.state.draw = async (signal, n) => {
      // The task's active time runs out while the provider is drawing both images.
      if (n === 2)
        await f.db.platform.query(
          `UPDATE ${f.table('tf_agent_task_activity')} SET expires_at=clock_timestamp() WHERE status='running'`,
        );
      return hang(signal, f.answer, aborted);
    };
    f.decisions.push({
      kind: 'tool',
      text: 'Draw two posters',
      call: { tool: 'images.generate', prompt: 'Two tulip posters', count: 2, folderId: f.folder.id },
    });
    const task = await f.start('Make two posters.');
    await f.run(task.id).catch(() => {});
    const generations = async () =>
      (await f.db.platform.query(`SELECT state FROM ${f.table('tf_image_generations')} ORDER BY ordinal`)).rows.map(
        row => row.state,
      );
    // Long enough for a request nothing cancelled to answer late.
    for (let n = 0; n < 240 && (await generations()).includes('pending'); n++)
      await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(f.providerCalls.length, 2);
    assert.equal(aborted.length, 2, 'both provider requests are aborted');
    assert.deepEqual(await generations(), ['cancelled', 'cancelled']);
    const credits = await f.imageCredits();
    assert.equal(credits.length, 2);
    assert.deepEqual(
      credits.map(row => [row.provider_pico_usd, row.charged]),
      [
        ['0', '0'],
        ['0', '0'],
      ],
      'every hold is released',
    );
  },
);

test('concurrent images of one call never spend past the task allowance', { timeout: 120000 }, async t => {
  const hold = creditUnitsForProviderCost(40000000000n);
  const f = await setup(t, {
    // Earlier spend in the task's flow leaves room for one and a half images when the call runs.
    choose: async (tx, runId) => {
      const flow = (
        await f.db.platform.query(
          `SELECT t.flow_id FROM ${f.table('tf_agent_task_runs')} r JOIN ${f.table('tf_agent_tasks')} t ON t.id=r.task_id WHERE r.run_id=$1`,
          [runId],
        )
      ).rows[0].flow_id;
      const spent = BigInt(
        (
          await f.db.platform.query(
            `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS spent FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1`,
            [flow],
          )
        ).rows[0].spent,
      );
      // Units per pico-USD are linear, so the filler's charge matches its provider cost under the flow's rounding.
      const perPico = hold / 40000000000n;
      const filler = (100n * 1_000_000_000_000n - spent - (hold * 3n) / 2n) / perPico;
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_credit_usage')} (id,flow_id,model_id,activity,reserved,charged,provider_pico_usd,pricing_revision) VALUES ($1,$2,'acme-chat','agent',$3,$3,$4,'test')`,
        [`test:${randomUUID()}`, flow, (filler * perPico).toString(), filler.toString()],
      );
      // Hold the credit lock briefly so the images' allowance checks overlap, as they do across busy connections.
      const key = [`${f.w.names.schema}:credits`];
      await f.db.platform.query('SELECT pg_advisory_lock(hashtextextended($1, 761040))', key);
      setTimeout(() => void f.db.platform.query('SELECT pg_advisory_unlock(hashtextextended($1, 761040))', key), 500);
      return runImageChoice(tx, runId);
    },
  });
  f.decisions.push({
    kind: 'tool',
    text: 'Draw four posters',
    call: { tool: 'images.generate', prompt: 'Four tulip posters', count: 4, folderId: f.folder.id },
  });
  const task = await f.start('Make four posters.');
  await f.run(task.id);
  const result = (
    await f.db.platform.query(`SELECT result FROM ${f.table('tf_agent_tool_calls')} ORDER BY sequence LIMIT 1`)
  ).rows[0].result;
  assert.deepEqual(result.images.map(image => [image.state, image.failure]).sort(), [
    ['failed', 'task-credits'],
    ['failed', 'task-credits'],
    ['failed', 'task-credits'],
    ['saved', undefined],
  ]);
  assert.equal(f.providerCalls.length, 1, 'only the image within the allowance reaches the provider');
  assert.equal((await f.imageCredits()).length, 1);
});

test('knowledge spend in the task flow counts against the image allowance', { timeout: 120000 }, async t => {
  const hold = creditUnitsForProviderCost(40000000000n);
  const f = await setup(t, {
    // Earlier knowledge retrieval in the task's flow leaves room for one and a half images when the call runs.
    choose: async (tx, runId) => {
      const flow = (
        await f.db.platform.query(
          `SELECT t.flow_id FROM ${f.table('tf_agent_task_runs')} r JOIN ${f.table('tf_agent_tasks')} t ON t.id=r.task_id WHERE r.run_id=$1`,
          [runId],
        )
      ).rows[0].flow_id;
      const spent = BigInt(
        (
          await f.db.platform.query(
            `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS spent FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1`,
            [flow],
          )
        ).rows[0].spent,
      );
      const perPico = hold / 40000000000n;
      const retrieval = (100n * 1_000_000_000_000n - spent - (hold * 3n) / 2n) / perPico;
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_knowledge_credit_attempts')} (id,group_version,operation_id,model_id,profile_id,pricing_revision,purpose,attribution_kind,attribution_id,task_flow_id,upper_provider_pico_usd,state) VALUES ($1,1,$1,'acme-embed','default','test','query','member',$2,$3,$4,'reserved')`,
        [randomUUID(), f.member, flow, retrieval.toString()],
      );
      return runImageChoice(tx, runId);
    },
  });
  f.decisions.push({
    kind: 'tool',
    text: 'Draw two posters',
    call: { tool: 'images.generate', prompt: 'Two tulip posters', count: 2, folderId: f.folder.id },
  });
  const task = await f.start('Make two posters.');
  await f.run(task.id);
  const result = (
    await f.db.platform.query(`SELECT result FROM ${f.table('tf_agent_tool_calls')} ORDER BY sequence LIMIT 1`)
  ).rows[0].result;
  assert.deepEqual(result.images.map(image => [image.state, image.failure]).sort(), [
    ['failed', 'task-credits'],
    ['saved', undefined],
  ]);
  assert.equal(f.providerCalls.length, 1, 'only the image within the allowance left by retrieval reaches the provider');
});
