import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { fixture as integrationFixture } from '../../integrations/test/fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';
import { createSoulAgentFixture, policyVersion, soulStorageSkip } from './soul-fixture.mjs';
import { createAgentChat } from '../src/chat.ts';
import { syntheticContinuity } from './continuity-fixture.mjs';

async function fixture() {
  const integration = await integrationFixture();
  let soul;
  try {
    soul = await createSoulAgentFixture({ ...integration, createdBy: integration.actor.userId });
    // The fixture creator manages its agent team explicitly. Admin status grants no team authority.
    await integration.owner.query(
      `INSERT INTO ${integration.table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager') ON CONFLICT (team_id,membership_id) DO UPDATE SET role='manager'`,
      [integration.actor.membershipId, integration.teamId],
    );
    if (integration.otherTeamId)
      await integration.owner.query(
        `INSERT INTO ${integration.table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager') ON CONFLICT (team_id,membership_id) DO UPDATE SET role='manager'`,
        [integration.actor.membershipId, integration.otherTeamId],
      );
    return {
      ...integration,
      saveAgent: soul.save,
      version: agentId => policyVersion(integration.owner, integration.table, agentId),
      async close() {
        try {
          await integration.close();
        } finally {
          await soul.close();
        }
      },
    };
  } catch (error) {
    await integration.close();
    throw error;
  }
}

test(
  'Temporal reruns retryable integration calls and rechecks authorization after its durable wait',
  { timeout: 60000, skip: soulStorageSkip },
  async () => {
    const f = await fixture();
    let connection;
    try {
      const { workspaceId: w, actor: a, input: i } = f;
      await f.service.create(w, a, i);
      await f.service.setGrants(w, a, i.id, {
        expectedGrantsVersion: 1,
        grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
        sourceGrants: [{ teamId: f.teamId, sourceId: i.repositories[0].id }],
      });
      const executor = createAgentExecutor({ runtime: f.runtime, integrations: f.service });
      const agentId = randomUUID();
      const scope = [
        { assetId: i.id, permissions: ['integration.read', 'integration.use'] },
        { assetId: i.repositories[0].id, permissions: ['github.issue.read'] },
      ];
      const definition = await f.saveAgent(w, a, agentId, f.teamId, {
        name: 'Workflow retry',
        instructions: 'Read issue',
        tools: ['github.issue.read'],
      });
      const activation = await executor.activate(w, a, { agentId, revision: definition.revision, scope });
      await executor.configure(w, a, {
        agentId,
        version: await f.version(agentId),
        enabled: true,
        teamIds: [f.teamId],
        limits: scope,
      });
      connection = await Connection.connect({ address: '127.0.0.1:7233' });
      const client = new Client({ connection });
      const taskQueue = `integration-retries-${randomUUID()}`;
      const worker = await Worker.create({
        taskQueue,
        workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
        activities: executor.activities,
      });
      await worker.runUntil(async () => {
        for (const revoke of [false, true]) {
          const run = await executor.startDelegated(w, a, { activationId: activation.activationId, scope });
          const ids = { workspaceId: w, runId: run.runId, callId: randomUUID() };
          await executor.queueCall(w, a, {
            runId: run.runId,
            callId: ids.callId,
            sequence: 0,
            call: { tool: 'github.issue.read', integrationId: i.id, sourceId: i.repositories[0].id, issueNumber: 17 },
          });
          f.setProvider(async () => {
            throw new Error('temporary provider failure');
          });
          const handle = await client.workflow.start('boundedAgentTool', {
            workflowId: `retry-${ids.callId}`,
            taskQueue,
            args: [ids],
          });
          try {
            let waiting = false;
            for (let attempt = 0; attempt < 200; attempt++) {
              const history = await handle.fetchHistory();
              waiting = history.events.some(event => event.timerStartedEventAttributes);
              if (waiting) break;
              await setTimeout(25);
            }
            assert.equal(waiting, true, 'retryable failure enters the workflow timer rather than completing failed');
            assert.deepEqual(
              (
                await f.owner.query(
                  `SELECT status, attempt FROM ${f.table('tf_integration_dispatches')} WHERE request_id = $1`,
                  [ids.callId],
                )
              ).rows[0],
              { status: 'failed', attempt: 1 },
            );
            if (revoke) await executor.revoke(w, a, { kind: 'activation', id: activation.activationId });
            else await f.service.rotate(w, a, i.id, { expectedGeneration: 1, token: 'workflow-retry-token' });
            f.setProvider(
              async () =>
                new Response(JSON.stringify({ number: 17, title: 'Workflow recovered', body: '', state: 'open' })),
            );
            await handle.signal('resumeAgentTool');
            assert.equal(await handle.result(), revoke ? 'blocked' : 'completed');
            if (!revoke) {
              assert.equal((await executor.readResult(ids, a)).result.title, 'Workflow recovered');
              assert.equal(f.calls.at(-1)[1].headers.Authorization, 'Bearer workflow-retry-token');
            }
          } finally {
            if ((await handle.describe()).status.name === 'RUNNING') await handle.terminate('Test cleanup');
          }
        }
        assert.equal(f.calls.length, 3);
      });
    } finally {
      await connection?.close();
      await f.close();
    }
  },
);

test(
  'uppercase agent scopes, scheduled IDs and queued calls replay as canonical UUID identities',
  { skip: soulStorageSkip },
  async () => {
    const f = await fixture();
    try {
      const { workspaceId: w, actor: a, input: i } = f;
      await f.service.create(w, a, i);
      await f.service.setGrants(w, a, i.id, {
        expectedGrantsVersion: 1,
        grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
        sourceGrants: [{ teamId: f.teamId, sourceId: i.repositories[0].id }],
      });
      const executor = createAgentExecutor({ runtime: f.runtime, integrations: f.service });
      const human = { ...a, membershipId: a.membershipId.toUpperCase() };
      const agentId = randomUUID();
      const scope = [
        { assetId: i.id.toUpperCase(), permissions: ['integration.read', 'integration.use'] },
        { assetId: i.repositories[0].id.toUpperCase(), permissions: ['github.issue.read'] },
      ];
      const definition = await f.saveAgent(w.toUpperCase(), human, agentId.toUpperCase(), f.teamId.toUpperCase(), {
        name: 'Canonical',
        instructions: 'Read issue',
        tools: ['github.issue.read'],
      });
      assert.equal(definition.agentId, agentId);
      const activation = await executor.activate(w, human, {
        agentId: agentId.toUpperCase(),
        revision: definition.revision,
        scope,
      });
      await executor.configure(w, human, {
        agentId: agentId.toUpperCase(),
        version: await f.version(agentId),
        enabled: true,
        teamIds: [f.teamId.toUpperCase()],
        limits: scope,
      });
      const schedule = await executor.authorizeSchedule(w, human, {
        activationId: activation.activationId.toUpperCase(),
        scope,
      });
      const runId = randomUUID();
      assert.equal(
        (
          await executor.startScheduled(w.toUpperCase(), {
            scheduleId: schedule.scheduleId.toUpperCase(),
            runId: runId.toUpperCase(),
          })
        ).runId,
        runId,
      );
      assert.equal((await executor.startScheduled(w, { scheduleId: schedule.scheduleId, runId })).runId, runId);
      const delegated = await executor.startDelegated(w.toUpperCase(), human, {
        activationId: activation.activationId.toUpperCase(),
        scope,
      });
      for (const run of [runId, delegated.runId]) {
        const callId = randomUUID();
        const call = {
          tool: 'github.issue.read',
          integrationId: i.id,
          sourceId: i.repositories[0].id,
          issueNumber: 17,
        };
        const ids = { workspaceId: w, runId: run, callId };
        assert.equal(
          (
            await executor.queueCall(w.toUpperCase(), human, {
              runId: run.toUpperCase(),
              callId: callId.toUpperCase(),
              sequence: 0,
              call: { ...call, integrationId: call.integrationId.toUpperCase(), sourceId: call.sourceId.toUpperCase() },
            })
          ).callId,
          callId,
        );
        assert.equal((await executor.queueCall(w, a, { runId: run, callId, sequence: 0, call })).callId, callId);
        assert.equal(
          await executor.execute({
            workspaceId: w.toUpperCase(),
            runId: run.toUpperCase(),
            callId: callId.toUpperCase(),
          }),
          'completed',
        );
        assert.equal((await executor.readResult(ids, human)).result.title, 'Issue title');
        assert.equal(
          (
            await f.service.readIssue(
              w.toUpperCase(),
              { kind: 'agent', runId: run.toUpperCase() },
              {
                requestId: callId.toUpperCase(),
                integrationId: i.id.toUpperCase(),
                sourceId: i.repositories[0].id.toUpperCase(),
                issueNumber: 17,
              },
            )
          ).title,
          'Issue title',
        );
      }
      assert.equal(f.calls.length, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  'agent provider retries wait, reload credentials and authority, and stop on exhaustion or stale ambiguity',
  { skip: soulStorageSkip },
  async () => {
    const f = await fixture();
    try {
      const { workspaceId: w, actor: a, input: i } = f;
      await f.service.create(w, a, i);
      await f.service.setGrants(w, a, i.id, {
        expectedGrantsVersion: 1,
        grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
        sourceGrants: [{ teamId: f.teamId, sourceId: i.repositories[0].id }],
      });
      const executor = createAgentExecutor({ runtime: f.runtime, integrations: f.service });
      const agentId = randomUUID();
      const scope = [
        { assetId: i.id, permissions: ['integration.read', 'integration.use'] },
        { assetId: i.repositories[0].id, permissions: ['github.issue.read'] },
      ];
      const definition = await f.saveAgent(w, a, agentId, f.teamId, {
        name: 'Retry',
        instructions: 'Read one issue',
        tools: ['github.issue.read'],
      });
      const activation = await executor.activate(w, a, { agentId, revision: definition.revision, scope });
      const configure = async limits =>
        executor.configure(w, a, {
          agentId,
          version: await f.version(agentId),
          enabled: true,
          teamIds: [f.teamId],
          limits,
        });
      await configure(scope);
      async function queued() {
        const run = await executor.startDelegated(w, a, { activationId: activation.activationId, scope });
        const ids = { workspaceId: w, runId: run.runId, callId: randomUUID() };
        await executor.queueCall(w, a, {
          runId: ids.runId,
          callId: ids.callId,
          sequence: 0,
          call: { tool: 'github.issue.read', integrationId: i.id, sourceId: i.repositories[0].id, issueNumber: 17 },
        });
        return ids;
      }
      const transient = await queued();
      f.setProvider(async () => {
        throw new Error('provider unavailable');
      });
      assert.equal(await executor.execute(transient), 'waiting');
      assert.equal((await executor.readResult(transient, a)).status, 'waiting');
      await f.service.rotate(w, a, i.id, { expectedGeneration: 1, token: 'retry-token' });
      f.setProvider(
        async () => new Response(JSON.stringify({ number: 17, title: 'Recovered', body: '', state: 'open' })),
      );
      assert.equal(await executor.execute(transient), 'completed');
      assert.equal((await executor.readResult(transient, a)).result.title, 'Recovered');
      assert.equal(f.calls.at(-1)[1].headers.Authorization, 'Bearer retry-token');
      const revoked = await queued();
      f.setProvider(async () => {
        throw new Error('provider unavailable');
      });
      assert.equal(await executor.execute(revoked), 'waiting');
      await configure([]);
      assert.equal(await executor.execute(revoked), 'blocked');
      assert.equal(f.calls.length, 3);
      await configure(scope);
      const exhausted = await queued();
      assert.equal(await executor.execute(exhausted), 'waiting');
      assert.equal(await executor.execute(exhausted), 'waiting');
      assert.equal(await executor.execute(exhausted), 'failed');
      assert.equal(await executor.execute(exhausted), 'failed');
      assert.equal(f.calls.length, 6);
      const stale = await queued();
      let entered;
      let release;
      const started = new Promise(resolve => {
        entered = resolve;
      });
      f.setProvider(async () => {
        entered();
        await new Promise(resolve => {
          release = resolve;
        });
        return new Response(JSON.stringify({ number: 17, title: 'Late', body: '', state: 'open' }));
      });
      const running = executor.execute(stale);
      await started;
      await f.owner.query(
        `UPDATE ${f.table('tf_integration_dispatches')} SET started_at = now() - interval '61 seconds' WHERE request_id = $1`,
        [stale.callId],
      );
      assert.equal(await executor.execute(stale), 'failed');
      release();
      assert.equal(await running, 'failed');
      assert.equal(await executor.execute(stale), 'failed');
      assert.equal(f.calls.length, 7);
      assert.deepEqual(
        (
          await f.owner.query(
            `SELECT status, attempt FROM ${f.table('tf_integration_dispatches')} WHERE request_id = $1`,
            [stale.callId],
          )
        ).rows[0],
        { status: 'failed', attempt: 3 },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'persisted agent integration calls intersect scopes, enforce ordering and deduplicate concurrent execution',
  { skip: soulStorageSkip },
  async () => {
    const f = await fixture();
    try {
      const { workspaceId: w, actor: a, input: i } = f;
      await f.service.create(w, a, i);
      const grants = {
        grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
        sourceGrants: [{ teamId: f.teamId, sourceId: i.repositories[0].id }],
      };
      await f.service.setGrants(w, a, i.id, { ...grants, expectedGrantsVersion: 1 });
      const executor = createAgentExecutor({ runtime: f.runtime, integrations: f.service });
      const agentId = randomUUID();
      const scope = [
        { assetId: i.id, permissions: ['integration.read', 'integration.use'] },
        { assetId: i.repositories[0].id, permissions: ['github.issue.read'] },
      ];
      const definition = await f.saveAgent(w, a, agentId, f.teamId, {
        name: 'Triage',
        instructions: 'Read one issue',
        tools: ['github.issue.read'],
      });
      await f.owner.query(
        `INSERT INTO ${f.table('tf_agent_grants')} (team_id, agent_id, permission) VALUES ($1,$2,'read'),($1,$2,'invoke')`,
        [f.teamId, agentId],
      );
      const activation = await executor.activate(w, a, { agentId, revision: definition.revision, scope });
      const configure = async limits =>
        executor.configure(w, a, {
          agentId,
          version: await f.version(agentId),
          enabled: true,
          teamIds: [f.teamId],
          limits,
        });
      await configure(scope);
      const call = { tool: 'github.issue.read', integrationId: i.id, sourceId: i.repositories[0].id, issueNumber: 17 };
      const modelChat = createAgentChat(
        f.runtime,
        syntheticContinuity(async () => ({ kind: 'tool', text: 'Read issue', call })),
        f.service,
      );
      const modelId = randomUUID();
      await modelChat.submit(w, a.userId, agentId, {
        id: modelId,
        activationId: activation.activationId,
        scope,
        prompt: 'Read issue 17.',
      });
      await modelChat.processTurn(w, modelId);
      assert.equal((await modelChat.read(w, a.userId, agentId, modelId)).execution.result.title, 'Issue title');
      await modelChat.processTurn(w, modelId);
      assert.equal(f.calls.length, 1);
      f.calls.length = 0;
      async function queued(human = a, requestedScope = scope) {
        const run = await executor.startDelegated(w, human, {
          activationId: activation.activationId,
          scope: requestedScope,
        });
        const ids = { workspaceId: w, runId: run.runId, callId: randomUUID() };
        await executor.queueCall(w, human, { runId: ids.runId, callId: ids.callId, sequence: 0, call });
        return ids;
      }
      const ids = await queued();
      await assert.rejects(
        f.service.readIssue(
          w,
          { kind: 'agent', runId: ids.runId },
          { ...f.request(), requestId: ids.callId, issueNumber: 18 },
        ),
        /not found/,
      );
      await assert.rejects(f.service.readIssue(w, { kind: 'agent', runId: ids.runId }, f.request()), /not found/);
      let entered;
      let release;
      const started = new Promise(resolve => {
        entered = resolve;
      });
      f.setProvider(async () => {
        entered();
        await new Promise(resolve => {
          release = resolve;
        });
        return new Response(JSON.stringify({ number: 17, title: 'Agent issue', body: 'Result', state: 'open' }));
      });
      const running = executor.execute(ids);
      await started;
      assert.equal(await executor.execute(ids), 'waiting');
      const next = { ...ids, callId: randomUUID() };
      await executor.queueCall(w, a, { runId: ids.runId, callId: next.callId, sequence: 1, call });
      assert.equal(await executor.execute(next), 'waiting');
      release();
      assert.equal(await running, 'completed');
      assert.equal(await executor.execute(ids), 'completed');
      assert.equal(f.calls.length, 1);
      assert.deepEqual((await executor.readResult(ids, a)).result, {
        number: 17,
        title: 'Agent issue',
        body: 'Result',
        state: 'open',
        url: 'https://github.com/tulipfarm/fixture/issues/17',
      });
      f.setProvider(async () => new Response(JSON.stringify({ number: 17, title: 'Next', body: '', state: 'open' })));
      assert.equal(await executor.execute(next), 'completed');
      assert.equal(f.calls.length, 2);
      const narrow = [{ assetId: i.id, permissions: ['integration.read', 'integration.use'] }];
      await configure(narrow);
      assert.equal(await executor.execute(await queued()), 'blocked');
      await assert.rejects(executor.readResult(ids, a), /not found/);
      await configure(scope);
      assert.equal(await executor.execute(await queued(a, narrow)), 'blocked');
      assert.equal(
        await executor.execute(await queued(a, [{ assetId: i.id, permissions: ['integration.use'] }, scope[1]])),
        'blocked',
      );
      const memberIds = await queued(f.member);
      await f.service.setGrants(w, a, i.id, {
        expectedGrantsVersion: 2,
        grants: [{ teamId: f.teamId, permissions: ['read'] }],
        sourceGrants: grants.sourceGrants,
      });
      assert.equal(await executor.execute(memberIds), 'blocked');
      await executor.configure(w, a, {
        agentId,
        version: await f.version(agentId),
        enabled: true,
        teamIds: [f.otherTeamId],
        limits: scope,
      });
      await f.service.setGrants(w, a, i.id, {
        expectedGrantsVersion: 3,
        grants: [{ teamId: f.otherTeamId, permissions: ['read', 'use'] }],
        sourceGrants: [{ teamId: f.otherTeamId, sourceId: i.repositories[0].id }],
      });
      assert.equal(await executor.execute(await queued(f.member)), 'blocked');
      assert.equal(await executor.execute(await queued()), 'completed');
      await configure(scope);
      await f.service.setGrants(w, a, i.id, { ...grants, expectedGrantsVersion: 4 });
      const reincarnated = await queued(f.member);
      await f.owner.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
        f.member.membershipId,
      ]);
      await f.owner.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        f.member.userId,
      ]);
      assert.equal(await executor.execute(reincarnated), 'blocked');
      const schedule = await executor.authorizeSchedule(w, a, { activationId: activation.activationId, scope });
      const run = await executor.startScheduled(w, { scheduleId: schedule.scheduleId, runId: randomUUID() });
      const scheduled = { workspaceId: w, runId: run.runId, callId: randomUUID() };
      await executor.queueCall(w, a, { runId: run.runId, callId: scheduled.callId, sequence: 0, call });
      assert.equal(await executor.execute(scheduled), 'completed');
      await executor.revoke(w, a, { kind: 'schedule', id: schedule.scheduleId });
      assert.equal(await executor.execute(scheduled), 'blocked');
      const persisted = JSON.stringify(
        (await f.owner.query(`SELECT call, result FROM ${f.table('tf_agent_tool_calls')}`)).rows,
      );
      assert.equal(persisted.includes(i.token), false);
    } finally {
      await f.close();
    }
  },
);
