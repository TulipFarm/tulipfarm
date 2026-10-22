import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { createGitHubTaskTools } from '@tulipfarm/agents/github-tasks';
import { createAgentExecutor } from '@tulipfarm/agents';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { createTaskApprovals } from '@tulipfarm/agents/task-approvals';
import { githubChatFixture } from './github-read-fixture.mjs';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { addInvestigationIntegration } from './github-investigation-fixture.mjs';
import { githubChatReads, githubTaskTools } from '../src/github-composition.ts';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';

test('worker composition does not require team credentials until a team read', () => {
  const runtime = { transaction: async () => assert.fail('construction must not access storage') };
  assert.doesNotThrow(() => githubChatReads(runtime, {}));
  assert.doesNotThrow(() => githubTaskTools(runtime, {}));
});

test('private task investigation requires owner choice and blocks alternate tools before dispatch', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const actor = { kind: 'human', ...f.member };
  const tools = [
    'github.investigation.account',
    'github.investigation.repositories',
    'github.investigation.read',
    'github.personal.account',
    'github.personal.read',
    'github.personal.download',
    'github.personal.propose',
  ];
  const agent = await savedTaskAgent(
    f.db,
    f.one,
    f.runtime,
    actor.userId,
    actor.membershipId,
    [{ id: 'github-investigation', revision: 'latest' }],
    tools,
  );
  await createAgentExecutor({ runtime: f.runtime }).configure(
    f.one.id,
    { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const tasks = createAgentTasks(f.runtime);
  const task = await tasks.start(f.one.id, actor.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Investigate the web repository. Make no changes.',
  });
  await createTaskApprovals(f.runtime).bindRun(f.one.id, actor.userId, task.id, { generation: 0 });
  const options = { runtime: f.runtime, accounts: f.service, keyring: f.keyring, requireSources: async () => {} };
  const investigation = createGitHubInvestigation(options),
    taskTools = createGitHubTaskTools(options);
  const call = tool => ({
    workspaceId: f.one.id,
    actor,
    taskId: task.id,
    generation: 0,
    callId: randomUUID(),
    call: tool,
  });
  const accountId = await f.connect();
  const waiting = await taskTools.execute(call({ tool: 'github.investigation.account' }));
  assert.equal(waiting.state, 'selection-required');
  assert.equal(f.providerCalls.length, 0);
  await assert.rejects(
    taskTools.execute(call({ tool: 'github.personal.account' })),
    'no-selection intent blocks ordinary account tools',
  );
  const choice = {
    choice: { kind: 'personal', id: accountId, generation: 1 },
    expectedVersion: (await investigation.choices(f.one.id, actor.userId, { taskId: task.id })).version,
  };
  await assert.rejects(investigation.select(f.one.id, actor.userId, { taskId: task.id }, choice), /selection-conflict/);
  await tasks.pause(f.one.id, actor.userId, task.id, { expectedGeneration: 0 });
  await assert.rejects(investigation.select(f.one.id, f.one.userId, { taskId: task.id }, choice));
  await investigation.select(f.one.id, actor.userId, { taskId: task.id }, choice);
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
  const response = await taskTools.execute(
    call({ tool: 'github.investigation.read', operation: { kind: 'repository.read', owner: 'example', repo: 'web' } }),
  );
  assert.equal(response.state, 'completed');
  assert.equal(response.sources[0].origin, 'task');
  const count = f.providerCalls.length;
  await assert.rejects(
    taskTools.execute(
      call({ tool: 'github.personal.read', operation: { kind: 'repository.read', owner: 'example', repo: 'other' } }),
    ),
  );
  await assert.rejects(taskTools.execute(call({ tool: 'github.personal.account' })));
  await assert.rejects(
    taskTools.execute(
      call({
        tool: 'github.personal.propose',
        actions: [{ kind: 'issue.comment', owner: 'example', repo: 'web', issueNumber: 1, body: 'Blocked' }],
      }),
    ),
  );
  assert.equal(f.providerCalls.length, count);
});

test('worker team-only configuration executes and rechecks persisted private task evidence', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const keyring = { activeKeyId: 'team-only', keys: { 'team-only': 'cd'.repeat(32) } };
  const env = {
    INTEGRATION_CREDENTIAL_KEY_ID: keyring.activeKeyId,
    INTEGRATION_CREDENTIAL_KEY: keyring.keys['team-only'],
  };
  const integration = await addInvestigationIntegration(f, { keyring });
  const runtime = withGitHubSourceAuthorization(f.runtime, env);
  const actor = integration.actor;
  const tools = [
    'github.investigation.account',
    'github.investigation.repositories',
    'github.investigation.read',
    'github.personal.read',
  ];
  const agent = await savedTaskAgent(
    f.db,
    f.one,
    runtime,
    actor.userId,
    actor.membershipId,
    [{ id: 'github-investigation', revision: 'latest' }],
    tools,
  );
  const executor = createAgentExecutor({ runtime, github: bound => githubTaskTools(bound, env) });
  await executor.configure(
    f.one.id,
    { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const tasks = createAgentTasks(runtime);
  const task = await tasks.start(f.one.id, actor.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Read the selected team repository.',
  });
  const run = await createTaskApprovals(runtime).bindRun(f.one.id, actor.userId, task.id, { generation: 0 });
  const investigation = githubChatReads(runtime, env).investigation;
  await tasks.pause(f.one.id, actor.userId, task.id, { expectedGeneration: 0 });
  await investigation.select(
    f.one.id,
    actor.userId,
    { taskId: task.id },
    { choice: integration.choice, expectedVersion: 0 },
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
  f.setProvider(async () => Response.json({ name: 'team-only-web' }));
  const ids = { workspaceId: f.one.id, runId: run.runId, callId: randomUUID() };
  await executor.queueCall(f.one.id, actor, {
    runId: run.runId,
    callId: ids.callId,
    sequence: 0,
    call: { tool: 'github.investigation.read', operation: { kind: 'repository.read', owner: 'example', repo: 'web' } },
  });
  assert.equal(await executor.execute(ids), 'completed');
  const retained = await executor.readResult(ids, actor);
  assert.equal(retained.result.state, 'completed');
  assert.equal(retained.result.data.data.name, 'team-only-web');
  assert.equal(retained.result.sources[0].investigation.origin.taskId, task.id);
  assert.ok(f.providerCalls.some(call => call.init.headers.Authorization === 'Bearer synthetic-team-token'));
  assert.equal(await executor.execute(ids), 'completed');
  assert.deepEqual(await executor.readResult(ids, actor), retained);
  const before = f.providerCalls.length;
  const fallback = { ...ids, callId: randomUUID() };
  await executor.queueCall(f.one.id, actor, {
    runId: run.runId,
    callId: fallback.callId,
    sequence: 1,
    call: { tool: 'github.personal.read', operation: { kind: 'repository.read', owner: 'example', repo: 'fallback' } },
  });
  assert.equal(await executor.execute(fallback), 'blocked');
  assert.equal(
    f.providerCalls.slice(before).some(call => call.url.includes('/fallback')),
    false,
  );
  f.setProvider(async () => Response.json({ message: 'Access revoked' }, { status: 403 }));
  await assert.rejects(executor.readResult(ids, actor));
  f.setProvider(async () => Response.json({ name: 'team-only-web' }));
  assert.deepEqual(await executor.readResult(ids, actor), retained);
  await integration.service.setGrants(f.one.id, actor, integration.id, {
    ...integration.grants,
    expectedGrantsVersion: 2,
    investigationGrants: [],
  });
  await assert.rejects(executor.readResult(ids, actor));
});
