import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { githubFixture } from './fixture.mjs';
import { savedTaskAgent } from '../../agents/test/task-fixture.mjs';
import { createAgentTasks } from '../../agents/dist/tasks.js';
import { createTaskApprovals } from '../../agents/dist/task-approvals.js';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { createAgentExecutor } from '../../agents/dist/executor.js';
import { createGitHubTaskTools } from '../../agents/dist/github-tasks.js';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { createTaskRuntime } from '../../agents/dist/task-runtime.js';
import { createTaskProgress } from '../../agents/dist/task-progress.js';
import { createMemoryRouteHealth } from '../../agents/dist/model-health.js';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '../../config/dist/index.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { requireDraftSources } from '../../agents/dist/draft-sources.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { encryptCredential } from '../../workspaces/dist/credentials.js';
import { provisionTableRegistry } from '../../workspaces/dist/table-registry.js';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { modelCatalogOf } from '../../../apps/worker/test/model-catalog-fixture.mjs';

const change = { kind: 'issue.create', owner: 'octocat', repo: 'private', title: 'Task issue', body: 'Reviewed body' };
const repositoryRead = {
  tool: 'github.personal.read',
  operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
};
const resetText =
  'GitHub account selection changed. Earlier context and pending approvals cannot be reused. Describe what to do with this account.';
const route = {
  id: 'github-task-test',
  modelId: 'claude-opus-5-5',
  provider: 'anthropic',
  deployment: 'claude-opus-5-5',
  location: 'test',
  adapterVersion: 1,
  qualification: 'local scripted protocol only',
  lifecycle: 'current',
  maxInputTokens: 1000000,
  maxOutputTokens: 4096,
  boundedDecision: true,
};
const bundle = modelBundleSchema.parse({
  format: 1,
  id: 'github-task-test',
  mapping: {
    ...initialModelMapping,
    revision: 'github-task-test',
    families: initialModelMapping.families.filter(family => family.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});
const scripted = decide => ({
  activeBundle: () => ({ bundle, activationRevision: 1 }),
  restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
  trustedBundle: () => bundle,
  allowed: () => true,
  actualModelIds: () => [route.modelId],
  health: createMemoryRouteHealth(() => route.id),
  budgetPicoUsd: () => '10000000000000',
  defaultFamily: () => 'claude-opus',
  infer: async (_resolution, input) => ({
    kind: 'success',
    decision: decide(JSON.parse(input.prompt)),
    actualModel: route.modelId,
    requestId: randomUUID(),
    usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  }),
});
const unusedMcp = () => {
  throw new Error('The task agent has no MCP tools');
};
const emptyCatalogMcp = () => ({
  recover: async () => {},
  catalog: async () => ({ model: { discovery: false, tools: [] }, sources: [] }),
  execute: async () => {
    throw new Error('No MCP tool is offered');
  },
  resume: async () => {
    throw new Error('No MCP tool is offered');
  },
});
async function setup(t, mcpSlots) {
  const f = await githubFixture();
  t.after(() => f.close());
  const actor = { kind: 'human', ...f.member };
  const agent = await savedTaskAgent(
    f.db,
    f.one,
    f.runtime,
    actor.userId,
    actor.membershipId,
    [],
    ['github.personal.account', 'github.personal.read', 'github.personal.propose', 'github.personal.download'],
    mcpSlots,
  );
  await createAgentExecutor({ runtime: f.runtime }).configure(
    f.one.id,
    { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  let tasks = createAgentTasks(f.runtime);
  const task = await tasks.start(f.one.id, actor.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Read and create an issue',
    limits: { toolCalls: 20, credits: 1000, activeMilliseconds: 600000 },
  });
  const run = await createTaskApprovals(f.runtime).bindRun(f.one.id, actor.userId, task.id, { generation: 0 });
  const accountId = await f.connect();
  const effects = [];
  const fetcher = async (_url, init) => {
    if (init.method === 'GET') return Response.json({ id: 1, name: 'private' });
    const result = { id: 10, number: 1, ...JSON.parse(init.body), user: { id: 123 } };
    effects.push(result);
    return Response.json(result, { status: 201 });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    String(url).startsWith('https://api.github.com/') ? fetcher(url, init) : originalFetch(url, init);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  f.runtime = withGitHubSourceAuthorization(f.runtime, {
    INTEGRATION_CREDENTIAL_KEY_ID: 'test',
    INTEGRATION_CREDENTIAL_KEY: f.keyring.keys.test,
    GITHUB_OAUTH_CLIENT_ID: f.configuration.clientId,
    GITHUB_OAUTH_CLIENT_SECRET: f.configuration.clientSecret,
    GITHUB_OAUTH_REDIRECT_URI: f.configuration.redirectUri,
    GITHUB_OAUTH_SCOPES: f.configuration.scopes.join(' '),
  });
  tasks = createAgentTasks(f.runtime);
  const options = {
    runtime: f.runtime,
    accounts: f.makeService({ runtime: f.runtime }),
    fetcher,
    requireSources: requireDraftSources,
  };
  const reads = createGitHubReads(options),
    batches = createGitHubBatches(options);
  const decide = createGitHubBatchDecision({
    ...options,
    resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
  });
  const executor = createAgentExecutor({
    runtime: f.runtime,
    github: runtime => createGitHubTaskTools({ ...options, runtime, accounts: f.makeService({ runtime }) }),
  });
  let sequence = 0;
  const queue = async call => {
    const callId = randomUUID();
    await executor.queueCall(f.one.id, actor, { runId: run.runId, callId, sequence: sequence++, call });
    return { workspaceId: f.one.id, runId: run.runId, callId };
  };
  const select = async () => {
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='waiting-clarification' WHERE id=$1`, [
      task.id,
    ]);
    await reads.select(f.one.id, actor.userId, { taskId: task.id }, { accountId, expectedVersion: 0 });
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
  };
  const engine = (decide, mcp) =>
    createTaskRuntime(f.runtime, scripted(decide), undefined, undefined, mcp, runtime =>
      createGitHubTaskTools({ ...options, runtime, accounts: f.makeService({ runtime }) }),
    );
  return {
    ...f,
    actor,
    agent,
    task,
    run,
    tasks,
    reads,
    batches,
    decide,
    executor,
    queue,
    select,
    engine,
    effects,
    accountId,
    options,
  };
}

async function readAccountAThenSwitch(f, engine) {
  await f.select();
  for (let step = 0; step < 3; step++) await engine.process(f.one.id, f.task.id);
  const before = (
    await f.db.platform.query(
      `SELECT sequence,text,jsonb_path_query_array(sources,'$[*] ? (@.kind == "github-personal").accountId') AS github FROM ${f.table('tf_agent_task_messages')} WHERE task_id=$1 AND role='agent' ORDER BY sequence`,
      [f.task.id],
    )
  ).rows;
  assert.deepEqual(before, [
    { sequence: 1, text: 'Read the repository.', github: [] },
    { sequence: 2, text: 'Account A private roadmap.', github: [f.accountId] },
  ]);
  const second = await f.connect(456);
  await f.reads.select(f.one.id, f.actor.userId, { taskId: f.task.id }, { accountId: second, expectedVersion: 1 });
  return second;
}

test('task account is explicitly selected and exact GitHub batch survives a resumed executor', async t => {
  const f = await setup(t);
  const request = await f.queue({
    tool: 'github.personal.read',
    operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
  });
  assert.equal(await f.executor.execute(request), 'completed');
  assert.equal((await f.executor.readResult(request, f.actor)).result.state, 'selection-required');
  assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).status, 'waiting-clarification');
  await f.select();
  const read = await f.queue({
    tool: 'github.personal.read',
    operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
  });
  assert.equal(await f.executor.execute(read), 'completed');
  assert.equal((await f.executor.readResult(read, f.actor)).result.data.data.name, 'private');
  const proposal = await f.queue({ tool: 'github.personal.propose', actions: [change] });
  assert.equal(await f.executor.execute(proposal), 'waiting');
  const batch = (await f.batches.list(f.one.id, f.actor.userId, { taskId: f.task.id })).batches[0];
  assert.equal(batch.snapshot.origin.kind, 'task');
  assert.equal(batch.snapshot.actions[0].title, 'Task issue');
  const before = await f.tasks.read(f.one.id, f.actor.userId, f.task.id);
  assert.equal(await f.executor.execute(proposal), 'waiting');
  assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).activeMilliseconds, before.activeMilliseconds);
  await assert.rejects(
    f.decide(f.one.id, f.one.userId, { taskId: f.task.id }, batch.snapshot.id, {
      digest: batch.digest,
      decision: 'approve',
    }),
  );
  await assert.rejects(
    f.runtime.transaction(f.one.id, commonCompatibility, tx =>
      tx.client.query(
        `INSERT INTO ${f.table('tf_github_batch_decisions')} (batch_id,membership_id,digest,decision) VALUES ($1,$2,$3,'approve')`,
        [batch.snapshot.id, f.actor.membershipId, batch.digest],
      ),
    ),
    error => error.code === '42501',
  );
  await f.decide(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id, {
    digest: batch.digest,
    decision: 'approve',
  });
  assert.equal(await f.executor.execute(proposal), 'completed');
  assert.equal((await f.executor.readResult(proposal, f.actor)).result.data.actions[0].status, 'succeeded');
  assert.equal(f.effects[0].title, 'Task issue');
  assert.equal(await f.executor.execute(proposal), 'completed');
  assert.equal(f.effects.length, 1);
});

test('task cancellation, changed account generation, and cross-origin access reject pending batches', async t => {
  const f = await setup(t);
  await f.select();
  const proposal = await f.queue({ tool: 'github.personal.propose', actions: [change] });
  assert.equal(await f.executor.execute(proposal), 'waiting');
  const batch = (await f.batches.list(f.one.id, f.actor.userId, { taskId: f.task.id })).batches[0];
  await assert.rejects(f.batches.read(f.one.id, f.actor.userId, f.task.id, batch.snapshot.id));
  await f.decide(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id, {
    digest: batch.digest,
    decision: 'approve',
  });
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='paused' WHERE id=$1`, [f.task.id]);
  await assert.rejects(f.batches.execute(f.one.id, f.actor, { taskId: f.task.id }, batch.snapshot.id));
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [f.task.id]);
  await f.service.disconnect(f.one.id, f.actor.userId, f.accountId);
  await assert.rejects(f.batches.execute(f.one.id, f.actor, { taskId: f.task.id }, batch.snapshot.id));
  assert.deepEqual(f.effects, []);
});

test('account switch starts a new task context and never reuses pending approval', async t => {
  const f = await setup(t);
  await f.select();
  const read = await f.queue({
    tool: 'github.personal.read',
    operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
  });
  assert.equal(await f.executor.execute(read), 'completed');
  const proposal = await f.queue({ tool: 'github.personal.propose', actions: [change] });
  assert.equal(await f.executor.execute(proposal), 'waiting');
  const batch = (await f.batches.list(f.one.id, f.actor.userId, { taskId: f.task.id })).batches[0];
  const second = await f.connect(456);
  await assert.rejects(
    f.reads.select(f.one.id, f.actor.userId, { taskId: f.task.id }, { accountId: second, expectedVersion: 1 }),
    /selection-conflict/,
  );
  await f.tasks.pause(f.one.id, f.actor.userId, f.task.id, { expectedGeneration: 0 });
  assert.equal(
    (await f.reads.select(f.one.id, f.actor.userId, { taskId: f.task.id }, { accountId: second, expectedVersion: 1 }))
      .accountId,
    second,
  );
  assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).generation, 1);
  const history = await f.tasks.history(f.one.id, f.actor.userId, f.task.id);
  assert.equal(history.messages.length, 1);
  assert.match(history.messages[0].text, /Earlier context and pending approvals cannot be reused/);
  await assert.rejects(
    f.decide(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id, {
      digest: batch.digest,
      decision: 'approve',
    }),
  );
  assert.equal(f.effects.length, 0);
});

const accountReader = context =>
  !context.results.length
    ? { kind: 'tool', text: 'Read the repository.', call: repositoryRead }
    : {
        kind: 'clarify',
        text: context.history.some(message => message.text === resetText)
          ? 'Account B summary.'
          : 'Account A private roadmap.',
      };

for (const mcp of [undefined, unusedMcp])
  test(`a referenced task gives the model only its context after an account switch ${mcp ? 'with' : 'without'} an MCP factory`, async t => {
    const f = await setup(t);
    await readAccountAThenSwitch(f, f.engine(accountReader, mcp));
    const start = throughSequence =>
      f.tasks.start(f.one.id, f.actor.userId, {
        requestId: randomUUID(),
        agentId: f.agent.agentId,
        text: 'Continue from the referenced task.',
        sources: [{ kind: 'task', taskId: f.task.id, throughSequence }],
        limits: { toolCalls: 20, credits: 1000, activeMilliseconds: 600000 },
      });
    await assert.rejects(start(2), AccessDenied);
    const referencing = await start(3);
    const prompts = [];
    await f
      .engine(context => {
        prompts.push(context);
        return { kind: 'answer', text: 'Used the referenced task.' };
      }, mcp)
      .process(f.one.id, referencing.id);
    assert.deepEqual(
      prompts.map(prompt =>
        prompt.references.map(reference => reference.messages.map(message => `${message.sequence}:${message.text}`)),
      ),
      [[[`3:${resetText}`]]],
    );
    assert.equal((await f.tasks.read(f.one.id, f.actor.userId, referencing.id)).status, 'completed');
  });

for (const mcp of [undefined, unusedMcp])
  test(`fresh GitHub reads run after an account switch ${mcp ? 'with' : 'without'} an MCP factory`, async t => {
    const f = await setup(t);
    const prompts = [];
    const engine = f.engine(context => {
      prompts.push(context);
      return accountReader(context);
    }, mcp);
    const second = await readAccountAThenSwitch(f, engine);
    await f.tasks.continueTask(f.one.id, f.actor.userId, f.task.id, {
      requestId: randomUUID(),
      expectedGeneration: 1,
      expectedSequence: 3,
      text: 'Read it with the selected account.',
    });
    await engine.process(f.one.id, f.task.id);
    await engine.process(f.one.id, f.task.id);
    const calls = (
      await f.db.platform.query(
        `SELECT b.generation,c.status,c.result->'data'->>'accountId' AS account FROM ${f.table('tf_agent_tool_calls')} c JOIN ${f.table('tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1 ORDER BY b.generation,c.sequence`,
        [f.task.id],
      )
    ).rows;
    assert.deepEqual(calls, [
      { generation: 0, status: 'completed', account: f.accountId },
      { generation: 1, status: 'completed', account: second },
    ]);
    await engine.process(f.one.id, f.task.id);
    const latest = (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1);
    assert.equal(latest.text, 'Account B summary.');
    assert.deepEqual(
      prompts.map(prompt => [
        prompt.history.map(message => message.sequence),
        JSON.stringify(prompt).includes('Account A private roadmap'),
      ]),
      [
        [[0], false],
        [[0, 1], false],
        [[3, 4], false],
        [[3, 4, 5], false],
      ],
    );
    await f.tasks.continueTask(f.one.id, f.actor.userId, f.task.id, {
      requestId: randomUUID(),
      expectedGeneration: 1,
      expectedSequence: latest.sequence,
      text: 'Read it again.',
    });
    await f.service.disconnect(f.one.id, f.actor.userId, second);
    const run = (
      await f.db.platform.query(
        `SELECT run_id FROM ${f.table('tf_agent_task_runs')} WHERE task_id=$1 AND generation=1`,
        [f.task.id],
      )
    ).rows[0].run_id;
    const revoked = { workspaceId: f.one.id, runId: run, callId: randomUUID() };
    await f.executor.queueCall(f.one.id, f.actor, {
      runId: run,
      callId: revoked.callId,
      sequence: 1,
      call: repositoryRead,
    });
    assert.equal(await f.executor.execute(revoked), 'blocked');
  });

test('a task with MCP slots stays readable and runs fresh reads after an account switch', async t => {
  const f = await setup(t, [
    { id: 'fixture', serverIdentity: 'a'.repeat(64), tools: [{ name: 'lookup', revision: 'b'.repeat(64) }] },
  ]);
  const prompts = [];
  const engine = f.engine(context => {
    prompts.push(context);
    return accountReader(context);
  }, emptyCatalogMcp);
  const second = await readAccountAThenSwitch(f, engine);
  const recorded = (
    await f.db.platform.query(
      `SELECT step,jsonb_path_query_array(mcp_sources,'$[*].kind') AS kinds FROM ${f.table('tf_agent_task_steps')} WHERE task_id=$1 AND generation=0 ORDER BY step`,
      [f.task.id],
    )
  ).rows;
  assert.deepEqual(recorded, [
    { step: 0, kinds: ['private-task', 'agent-definition'] },
    { step: 1, kinds: ['private-task', 'agent-definition', 'github-personal'] },
  ]);
  assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).status, 'waiting-clarification');
  await f.tasks.continueTask(f.one.id, f.actor.userId, f.task.id, {
    requestId: randomUUID(),
    expectedGeneration: 1,
    expectedSequence: 3,
    text: 'Read it with the selected account.',
  });
  for (let step = 0; step < 3; step++) await engine.process(f.one.id, f.task.id);
  const reads = (
    await f.db.platform.query(
      `SELECT b.generation,c.status,c.result->'data'->>'accountId' AS account FROM ${f.table('tf_agent_tool_calls')} c JOIN ${f.table('tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1 ORDER BY b.generation,c.sequence`,
      [f.task.id],
    )
  ).rows;
  assert.deepEqual(reads, [
    { generation: 0, status: 'completed', account: f.accountId },
    { generation: 1, status: 'completed', account: second },
  ]);
  const latest = (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1);
  assert.deepEqual(
    [latest.text, latest.sources.filter(source => source.kind === 'github-personal').map(source => source.accountId)],
    ['Account B summary.', [second]],
  );
  assert.deepEqual(
    prompts.map(prompt => [
      prompt.history.map(message => message.sequence),
      JSON.stringify(prompt).includes('Account A private roadmap'),
    ]),
    [
      [[0], false],
      [[0, 1], false],
      [[3, 4], false],
      [[3, 4, 5], false],
    ],
  );
});

test('task budget caps individual batch effects and a removed owner incarnation cannot inherit results', async t => {
  const f = await setup(t);
  await f.select();
  await f.db.platform.query(
    `UPDATE ${f.table('tf_agent_tasks')} SET limits=jsonb_set(limits,'{toolCalls}','2') WHERE id=$1`,
    [f.task.id],
  );
  const proposal = await f.queue({
    tool: 'github.personal.propose',
    actions: [change, { ...change, title: 'Over budget' }],
  });
  assert.equal(await f.executor.execute(proposal), 'waiting');
  const batch = (await f.batches.list(f.one.id, f.actor.userId, { taskId: f.task.id })).batches[0];
  await f.decide(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id, {
    digest: batch.digest,
    decision: 'approve',
  });
  await f.executor.execute(proposal);
  assert.deepEqual(
    f.effects.map(effect => effect.title),
    ['Task issue'],
  );
  assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).toolCalls, 2);
  await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
    f.actor.membershipId,
  ]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
    randomUUID(),
    f.actor.userId,
  ]);
  await assert.rejects(f.tasks.read(f.one.id, f.actor.userId, f.task.id));
  await assert.rejects(f.batches.read(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id));
});

const batchReporter = context => {
  const proposal = context.results.find(
    row => row.call.tool === 'github.personal.propose' && row.status === 'completed',
  );
  return proposal
    ? { kind: 'answer', text: `GitHub batch ${proposal.result.state}.` }
    : {
        kind: 'tool',
        text: 'Propose two issues.',
        call: { tool: 'github.personal.propose', actions: [change, { ...change, title: 'Over budget' }] },
      };
};

async function pauseAtToolLimit(f, engine) {
  await f.select();
  await f.db.platform.query(
    `UPDATE ${f.table('tf_agent_tasks')} SET limits=jsonb_set(limits,'{toolCalls}','2') WHERE id=$1`,
    [f.task.id],
  );
  await engine.process(f.one.id, f.task.id);
  await engine.process(f.one.id, f.task.id);
  const batch = (await f.batches.list(f.one.id, f.actor.userId, { taskId: f.task.id })).batches[0];
  assert.ok(
    batch,
    `Expected an approval batch, not a ${JSON.stringify((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).pauseReason)} pause`,
  );
  await f.decide(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id, {
    digest: batch.digest,
    decision: 'approve',
  });
  await engine.process(f.one.id, f.task.id);
  const task = await f.tasks.read(f.one.id, f.actor.userId, f.task.id);
  const latest = (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1);
  assert.deepEqual(
    [task.status, task.toolCalls, latest.text, f.effects.map(effect => effect.title)],
    [
      'paused',
      2,
      'The task reached its tool limit before every approved GitHub change ran. Increase the tool limit before the approved batch expires to run the remaining changes.',
      ['Task issue'],
    ],
  );
  assert.equal(task.pauseReason, 'limit.toolCalls');
  assert.deepEqual(
    (await f.batches.status(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id)).actions.map(
      action => action.status,
    ),
    ['succeeded', 'unattempted'],
  );
  return batch;
}

async function raiseToolLimit(f) {
  const { generation } = await f.tasks.read(f.one.id, f.actor.userId, f.task.id);
  const latest = (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1);
  await f.tasks.continueTask(f.one.id, f.actor.userId, f.task.id, {
    requestId: randomUUID(),
    expectedGeneration: generation,
    expectedSequence: latest.sequence,
    text: 'Continue with a higher tool limit.',
    limits: { toolCalls: 4, credits: 1000, activeMilliseconds: 600000 },
  });
}

test('task tool limit pauses an approved GitHub batch and a higher limit resumes only unattempted actions', async t => {
  const f = await setup(t);
  const engine = f.engine(batchReporter);
  const batch = await pauseAtToolLimit(f, engine);
  await raiseToolLimit(f);
  await engine.process(f.one.id, f.task.id);
  await engine.process(f.one.id, f.task.id);
  const task = await f.tasks.read(f.one.id, f.actor.userId, f.task.id);
  assert.deepEqual(
    [task.status, task.toolCalls, f.effects.map(effect => effect.title)],
    ['completed', 3, ['Task issue', 'Over budget']],
  );
  assert.equal(task.pauseReason, null);
  assert.equal(
    (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1).text,
    'GitHub batch completed.',
  );
  assert.equal(
    await f.executor.execute({ workspaceId: f.one.id, runId: f.run.runId, callId: batch.snapshot.commandId }),
    'completed',
  );
  await engine.process(f.one.id, f.task.id);
  assert.deepEqual(
    f.effects.map(effect => effect.title),
    ['Task issue', 'Over budget'],
  );
});

test('an expired GitHub batch stays stopped after the task tool limit is raised', async t => {
  const f = await setup(t);
  const engine = f.engine(batchReporter);
  const batch = await pauseAtToolLimit(f, engine);
  await f.db.platform.query(
    `UPDATE ${f.table('tf_github_batches')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [batch.snapshot.id],
  );
  await raiseToolLimit(f);
  await engine.process(f.one.id, f.task.id);
  await engine.process(f.one.id, f.task.id);
  assert.equal(
    (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1).text,
    'GitHub batch failed.',
  );
  assert.deepEqual(
    f.effects.map(effect => effect.title),
    ['Task issue'],
  );
});

test('an account switch stops a GitHub batch paused at the task tool limit', async t => {
  const f = await setup(t);
  const engine = f.engine(batchReporter);
  const batch = await pauseAtToolLimit(f, engine);
  await f.reads.select(
    f.one.id,
    f.actor.userId,
    { taskId: f.task.id },
    { accountId: await f.connect(456), expectedVersion: 1 },
  );
  assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).pauseReason, null);
  await raiseToolLimit(f);
  await engine.process(f.one.id, f.task.id);
  await engine.process(f.one.id, f.task.id);
  assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).status, 'waiting-approval');
  assert.equal(
    await f.executor.execute({ workspaceId: f.one.id, runId: f.run.runId, callId: batch.snapshot.commandId }),
    'blocked',
  );
  assert.deepEqual(
    f.effects.map(effect => effect.title),
    ['Task issue'],
  );
});

test('provider permission loss hides retained task reads and prevents cross-audience publication', async t => {
  const f = await setup(t);
  await f.select();
  const read = await f.queue({
    tool: 'github.personal.read',
    operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
  });
  assert.equal(await f.executor.execute(read), 'completed');
  const result = (await f.executor.readResult(read, f.actor)).result;
  assert.equal(result.data.data.name, 'private');
  await f.runtime.transaction(f.one.id, commonCompatibility, tx =>
    requireDraftSources(tx, f.actor, result.sources, new Set(), f.run.runId),
  );
  await assert.rejects(
    f.runtime.transaction(f.one.id, commonCompatibility, tx =>
      requireDraftSources(tx, f.actor, result.sources, new Set(), undefined, true),
    ),
  );
  await assert.rejects(
    f.runtime.transaction(f.one.id, commonCompatibility, tx =>
      requireDraftSources(
        tx,
        { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId },
        result.sources,
      ),
    ),
  );
  globalThis.fetch = async () => Response.json({}, { status: 403 });
  await assert.rejects(f.executor.readResult(read, f.actor));
  await assert.rejects(f.tasks.read(f.one.id, f.actor.userId, f.task.id));
});

test('GitHub source reverification separates unavailable GitHub from revoked access', async t => {
  const f = await setup(t);
  await f.select();
  const read = await f.queue({
    tool: 'github.personal.read',
    operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
  });
  assert.equal(await f.executor.execute(read), 'completed');
  const failure = async (respond, code, unavailable) => {
    globalThis.fetch = async () => respond();
    await assert.rejects(
      f.executor.readResult(read, f.actor),
      error =>
        error instanceof AccessDenied &&
        error instanceof SourceAuthorizationUnavailable === unavailable &&
        error.code === code,
    );
  };
  await failure(
    () =>
      Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    'github-rate-limited',
    true,
  );
  await failure(
    () => Response.json({}, { status: 403, headers: { 'retry-after': '60' } }),
    'github-rate-limited',
    true,
  );
  await failure(() => Response.json({}, { status: 429 }), 'github-rate-limited', true);
  await failure(() => Response.json({}, { status: 502 }), 'github-unavailable', true);
  await failure(
    () => {
      throw new TypeError('fetch failed');
    },
    'github-unavailable',
    true,
  );
  await failure(() => Response.json({}, { status: 403 }), 'source-access-revoked', false);
  await failure(() => Response.json({}, { status: 404 }), 'source-access-revoked', false);
  globalThis.fetch = async () => Response.json({ id: 1, name: 'private' });
  assert.equal((await f.executor.readResult(read, f.actor)).result.data.data.name, 'private');
});

test('reconnect requires fresh task selection and invalidates the reviewed batch', async t => {
  const f = await setup(t);
  await f.select();
  const proposal = await f.queue({ tool: 'github.personal.propose', actions: [change] });
  assert.equal(await f.executor.execute(proposal), 'waiting');
  const batch = (await f.batches.list(f.one.id, f.actor.userId, { taskId: f.task.id })).batches[0];
  const started = await f.service.reconnect(f.one.id, f.actor.userId, 'test-session', f.accountId);
  await f.service.complete(
    { code: 'fixture-code', state: new URL(started.url).searchParams.get('state') },
    'test-session',
    f.actor.userId,
  );
  await assert.rejects(
    f.decide(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id, {
      digest: batch.digest,
      decision: 'approve',
    }),
  );
  await f.tasks.pause(f.one.id, f.actor.userId, f.task.id, { expectedGeneration: 0 });
  const selected = await f.reads.select(
    f.one.id,
    f.actor.userId,
    { taskId: f.task.id },
    { accountId: f.accountId, expectedVersion: 1 },
  );
  assert.equal(selected.version, 2);
  assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).generation, 1);
  assert.equal(f.effects.length, 0);
});

test('pause between task read admission and credential dispatch blocks provider IO', async t => {
  const f = await setup(t);
  await f.select();
  const admitted = Promise.withResolvers(),
    release = Promise.withResolvers();
  let calls = 0;
  const accounts = {
    ...f.options.accounts,
    withReadCredential: async (...args) => {
      admitted.resolve();
      await release.promise;
      return f.options.accounts.withReadCredential(...args);
    },
  };
  const reads = createGitHubReads({
    ...f.options,
    accounts,
    fetcher: async () => {
      calls++;
      return Response.json({ id: 1 });
    },
  });
  const pending = reads.read(
    f.one.id,
    f.actor,
    { taskId: f.task.id, generation: 0 },
    { kind: 'repository.read', owner: 'octocat', repo: 'private' },
  );
  await admitted.promise;
  assert.equal((await f.tasks.pause(f.one.id, f.actor.userId, f.task.id, { expectedGeneration: 0 })).status, 'paused');
  release.resolve();
  await assert.rejects(pending);
  assert.equal(calls, 0);
});

test('account selection cannot change while a task provider request is in flight', async t => {
  const f = await setup(t);
  await f.select();
  const second = await f.connect(456);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const executor = createAgentExecutor({
    runtime: f.runtime,
    github: runtime =>
      createGitHubTaskTools({
        ...f.options,
        runtime,
        accounts: f.makeService({ runtime }),
        fetcher: async () => {
          entered.resolve();
          await release.promise;
          return Response.json({ id: 1, name: 'private' });
        },
      }),
  });
  const ids = await f.queue({
    tool: 'github.personal.read',
    operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
  });
  const pending = executor.execute(ids);
  await entered.promise;
  let changed = false;
  const selection = f.reads
    .select(f.one.id, f.actor.userId, { taskId: f.task.id }, { accountId: second, expectedVersion: 1 })
    .then(() => {
      changed = true;
    });
  const rejected = assert.rejects(selection, /selection-conflict/);
  release.resolve();
  assert.equal(await pending, 'completed');
  await rejected;
  assert.equal(changed, false);
  assert.equal((await executor.readResult(ids, f.actor)).result.data.accountId, f.accountId);
});

test('pausing a task during a read fetch completes immediately and discards the fetched result', async t => {
  const f = await setup(t);
  await f.select();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const executor = createAgentExecutor({
    runtime: f.runtime,
    github: runtime =>
      createGitHubTaskTools({
        ...f.options,
        runtime,
        accounts: f.makeService({ runtime }),
        fetcher: async () => {
          entered.resolve();
          await release.promise;
          return Response.json({ id: 1, name: 'must-not-persist' });
        },
      }),
  });
  const ids = await f.queue(repositoryRead);
  const pending = executor.execute(ids);
  let timer;
  try {
    await entered.promise;
    const paused = await Promise.race([
      f.tasks.pause(f.one.id, f.actor.userId, f.task.id, { expectedGeneration: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Pause blocked by provider read')), 1500);
      }),
    ]);
    assert.equal(paused.status, 'paused');
  } finally {
    clearTimeout(timer);
    release.resolve();
  }
  assert.equal(await pending, 'blocked');
  const stored = (
    await f.db.platform.query(`SELECT status,result FROM ${f.table('tf_agent_tool_calls')} WHERE id=$1`, [ids.callId])
  ).rows[0];
  assert.deepEqual(stored, { status: 'blocked', result: { code: 'access-denied' } });
});

test(
  'real Temporal task reads, waits for owner approval, resumes on a new worker, and accepts follow-up',
  { skip: !process.env.TASK_TEST_TEMPORAL_ADDRESS },
  async t => {
    const f = await setup(t);
    const require = createRequire(new URL('../../agents/package.json', import.meta.url));
    const { Worker, NativeConnection } = require('@temporalio/worker');
    const { Client, Connection } = require('@temporalio/client');
    const decide = context =>
      !context.results.some(row => row.call.tool === 'github.personal.read')
        ? { kind: 'tool', text: 'Read the repository.', call: repositoryRead }
        : !context.results.some(row => row.call.tool === 'github.personal.propose')
          ? {
              kind: 'tool',
              text: 'Propose the exact issue.',
              call: { tool: 'github.personal.propose', actions: [change] },
            }
          : {
              kind: 'answer',
              text: context.history.some(message => message.text === 'Follow up.')
                ? 'The retained issue was created.'
                : 'The approved issue was created.',
            };
    await f.select();
    const connection = await Connection.connect({ address: process.env.TASK_TEST_TEMPORAL_ADDRESS });
    const native = await NativeConnection.connect({ address: process.env.TASK_TEST_TEMPORAL_ADDRESS });
    const client = new Client({ connection }),
      taskQueue = `github-${randomUUID()}`;
    const startWorker = async () => {
      const runtime = f.engine(decide);
      const progress = createTaskProgress(f.runtime);
      const worker = await Worker.create({
        connection: native,
        taskQueue,
        workflowsPath: fileURLToPath(new URL('../../../apps/worker/dist/task-workflows.js', import.meta.url)),
        activities: {
          processAgentTaskStep: async (workspaceId, taskId) => {
            await runtime.process(workspaceId, taskId);
            return progress(workspaceId, taskId);
          },
        },
      });
      const running = worker.run();
      return async () => {
        worker.shutdown();
        await running;
      };
    };
    let stop = await startWorker();
    try {
      const execute = () =>
        client.workflow.execute('agentTaskStep', { taskQueue, workflowId: randomUUID(), args: [f.one.id, f.task.id] });
      await execute();
      assert.equal(
        (await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).status,
        'waiting-approval',
        JSON.stringify(
          (
            await f.db.platform.query(`SELECT failure FROM ${f.table('tf_model_generations')} WHERE run_id=$1`, [
              f.run.runId,
            ])
          ).rows,
        ),
      );
      const batch = (await f.batches.list(f.one.id, f.actor.userId, { taskId: f.task.id })).batches[0];
      const active = (await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).activeMilliseconds;
      await stop();
      stop = async () => {};
      await f.decide(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id, {
        digest: batch.digest,
        decision: 'approve',
      });
      assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).activeMilliseconds, active);
      stop = await startWorker();
      await execute();
      assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).status, 'completed');
      assert.equal(f.effects.length, 1);
      assert.equal(
        (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1).text,
        'The approved issue was created.',
      );
      await f.tasks.reopen(f.one.id, f.actor.userId, f.task.id, {
        requestId: randomUUID(),
        expectedGeneration: 0,
        text: 'Follow up.',
      });
      await execute();
      assert.equal(
        (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1).text,
        'The retained issue was created.',
      );
      assert.equal(f.effects.length, 1);
    } finally {
      await stop();
      await native.close();
      await connection.close();
    }
  },
);

test(
  'full worker bootstrap and API dispatcher resume the persisted GitHub task after SIGKILL',
  { skip: !process.env.TASK_TEST_TEMPORAL_ADDRESS, timeout: 180000 },
  async t => {
    const f = await setup(t);
    await f.select();
    const require = createRequire(new URL('../../agents/package.json', import.meta.url));
    const { Client, Connection } = require('@temporalio/client');
    const connection = await Connection.connect({ address: process.env.TASK_TEST_TEMPORAL_ADDRESS });
    const client = new Client({ connection }),
      taskQueue = `github-process-${randomUUID()}`;
    t.after(() => connection.close());
    const effects = [];
    let selections = 0;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      let output;
      if (request.url === '/api.anthropic.com/v1/messages') {
        selections++;
        const context = JSON.parse(body.messages.at(-1).content);
        const decision = !context.results.length
          ? {
              kind: 'tool',
              text: 'Inspect the private repository.',
              call: {
                tool: 'github.personal.read',
                operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
              },
            }
          : context.results.length === 1
            ? {
                kind: 'tool',
                text: 'Review this exact issue.',
                call: { tool: 'github.personal.propose', actions: [change] },
              }
            : { kind: 'answer', text: 'The issue was created after your approval.' };
        output = {
          model: body.model,
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'select_action', input: { decision } }],
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      } else if (request.method === 'GET') output = { id: 1, name: 'private' };
      else {
        output = { id: 10, number: 1, ...body, user: { id: 123 } };
        effects.push(output);
      }
      response.writeHead(request.method === 'POST' && request.url.startsWith('/api.github.com/') ? 201 : 200, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(output));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await f.db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
    await loadPlatformBaseline(f.db.platform);
    await f.db.platform.query(
      `INSERT INTO app.users (id,name,email,email_verified) VALUES ($1,'Local task owner',$2,true)`,
      [f.actor.userId, `${randomUUID()}@example.test`],
    );
    await f.db.platform.query(
      `INSERT INTO app.workspaces(id,request_id,created_by,name,slug) VALUES ($1,$2,$3,'GitHub bootstrap','github-bootstrap')`,
      [f.one.id, randomUUID(), f.actor.userId],
    );
    const runtimeKey = { keyId: 'test-runtime', key: Buffer.alloc(32, 9) };
    const envelope = encryptCredential(
      f.db.login(f.one),
      { workspaceId: f.one.id, generation: 1, capability: 'runtime' },
      runtimeKey,
    );
    await f.db.platform.query(
      `INSERT INTO app.workspace_storage(workspace_id,stage,runtime_credential,migration_credential,confirmation_credential) VALUES ($1,'ready',$2,'{}','{}')`,
      [f.one.id, envelope],
    );
    const registryRole = `github_registry_${randomUUID().replaceAll('-', '')}`,
      registryPassword = randomUUID();
    await provisionTableRegistry(f.db.platform, {
      capability: 'authoring',
      role: registryRole,
      password: registryPassword,
    });
    t.after(async () => {
      const { Client: DatabaseClient } = require('pg');
      const admin = new DatabaseClient({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
      try {
        await admin.connect();
        await admin.query(`DROP ROLE IF EXISTS "${registryRole}"`);
      } finally {
        await admin.end();
      }
    });
    const registryUrl = new URL(f.db.connectionString);
    registryUrl.username = registryRole;
    registryUrl.password = registryPassword;
    let child, dispatcher;
    let workerOutput = '';
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TEMPORAL_ADDRESS: process.env.TASK_TEST_TEMPORAL_ADDRESS,
      TEMPORAL_TASK_QUEUE: taskQueue,
      WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
      WORKSPACE_AUTHORING_DATABASE_URL: registryUrl.href,
      WORKSPACE_RUNTIME_KEY_ID: runtimeKey.keyId,
      WORKSPACE_RUNTIME_KEY: runtimeKey.key.toString('hex'),
      WORKSPACE_RUNTIME_REPLICAS: '1',
      WORKSPACE_DATABASE_CONNECTION_BUDGET: '120',
      R2_ENDPOINT: process.env.R2_ENDPOINT,
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      R2_SOUL_BUCKET: process.env.R2_SOUL_BUCKET,
      TEST_PROVIDER_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      MODEL_CATALOG: modelCatalogOf(['claude-opus']),
      ANTHROPIC_API_KEY: 'synthetic-model-key',
      INTEGRATION_CREDENTIAL_KEY_ID: 'test',
      INTEGRATION_CREDENTIAL_KEY: f.keyring.keys.test,
      GITHUB_OAUTH_CLIENT_ID: f.configuration.clientId,
      GITHUB_OAUTH_CLIENT_SECRET: f.configuration.clientSecret,
      GITHUB_OAUTH_REDIRECT_URI: f.configuration.redirectUri,
      GITHUB_OAUTH_SCOPES: f.configuration.scopes.join(' '),
    };
    const start = async () => {
      child = fork(fileURLToPath(new URL('../../../apps/worker/test/github-task-worker.mjs', import.meta.url)), [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env,
      });
      child.stdout.on('data', bytes => {
        workerOutput += bytes;
      });
      child.stderr.on('data', bytes => {
        workerOutput += bytes;
      });
      assert.equal(
        await Promise.race([
          once(child, 'message').then(([message]) => message),
          once(child, 'exit').then(() => 'exited'),
        ]),
        'ready',
      );
    };
    try {
      await start();
      dispatcher = fork(
        fileURLToPath(new URL('../../../apps/api/test/github-dispatch-process.mjs', import.meta.url)),
        [],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env },
      );
      assert.equal(
        await Promise.race([
          once(dispatcher, 'message').then(([message]) => message),
          once(dispatcher, 'exit').then(() => 'exited'),
        ]),
        'ready',
      );
      const wait = async status => {
        for (let attempt = 0; attempt < 600; attempt++) {
          assert.equal(child.exitCode, null, 'Full worker exited');
          assert.equal(child.signalCode, null, 'Full worker stopped');
          assert.equal(dispatcher.exitCode, null, 'API dispatcher exited');
          if ((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).status === status) return;
          await delay(100);
        }
        assert.fail(`Task did not reach ${status}`);
      };
      await wait('waiting-approval');
      assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).status, 'waiting-approval');
      assert.equal(selections, 2);
      const batch = (await f.batches.list(f.one.id, f.actor.userId, { taskId: f.task.id })).batches[0];
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
      await f.decide(f.one.id, f.actor.userId, { taskId: f.task.id }, batch.snapshot.id, {
        digest: batch.digest,
        decision: 'approve',
      });
      await start();
      await wait('completed');
      assert.equal((await f.tasks.read(f.one.id, f.actor.userId, f.task.id)).status, 'completed');
      assert.equal(
        (await f.tasks.history(f.one.id, f.actor.userId, f.task.id)).messages.at(-1).text,
        'The issue was created after your approval.',
      );
      assert.deepEqual(
        effects.map(effect => effect.title),
        ['Task issue'],
      );
      assert.equal(selections, 3);
      const history = await client.workflow.getHandle(`agent-task-v1-${f.one.id}-${f.task.id}`).fetchHistory();
      const historyText = JSON.stringify(history);
      for (const secret of [
        'synthetic-access-token',
        'synthetic-model-key',
        f.configuration.clientSecret,
        'Reviewed body',
      ]) {
        assert.equal(workerOutput.includes(secret), false);
        assert.equal(historyText.includes(secret), false);
      }
    } finally {
      if (dispatcher && dispatcher.exitCode === null && dispatcher.signalCode === null) {
        const stopped = once(dispatcher, 'exit');
        dispatcher.kill('SIGTERM');
        await stopped;
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill('SIGTERM');
        await stopped;
      }
    }
  },
);
