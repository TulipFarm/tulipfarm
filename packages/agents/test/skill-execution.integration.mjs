import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createFiles } from '@tulipfarm/files';
import { AccessDenied } from '@tulipfarm/access';
import { createSnippetBroker } from '@tulipfarm/workflow-snippets/broker';
import { createSkillClient } from '@tulipfarm/workflow-snippets/client';
import { createSkillImports } from '../src/skill-imports.ts';
import { createSkillObjects } from '../src/skill-objects.ts';
import { createSkillExecutionFactory } from '../src/skill-execution.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { savedTaskAgent, seedExecution } from './task-fixture.mjs';

test(
  'reviewed script runs through the broker to Files, replay and revocation remain fenced',
  { skip: !process.env.SNIPPET_TEST_IMAGE && 'Set SNIPPET_TEST_IMAGE to the digest-pinned local test image' },
  async () => {
    assert.ok(process.env.SNIPPET_TEST_IMAGE, 'Use the digest-pinned local test image');
    const db = await fixture();
    const directory = await mkdtemp(join(tmpdir(), 'skill-execution-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = directory;
    let runtime, broker;
    try {
      const workspace = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async () => ({
          workspaceId: workspace.id,
          generation: 1,
          connectionString: db.login(workspace),
        }),
      });
      const actor = { kind: 'human', membershipId: workspace.membershipId, userId: workspace.userId };
      const data = new Map();
      const bytes = {
        async putIfAbsent(key, content) {
          if (!data.has(key)) data.set(key, Uint8Array.from(content));
        },
        async read(key) {
          if (!data.has(key)) throw new Error('missing-object');
          return data.get(key);
        },
        async remove(key) {
          data.delete(key);
        },
      };
      const token = randomBytes(32).toString('hex');
      const brokerOptions = {
        database: join(directory, 'broker.sqlite'),
        token,
        image: process.env.SNIPPET_TEST_IMAGE,
        runtime: 'runc',
        allowLocalRunc: true,
        enableSkillJobs: true,
      };
      broker = await createSnippetBroker(brokerOptions);
      broker.server.listen(0, '127.0.0.1');
      await once(broker.server, 'listening');
      const client = createSkillClient({
        url: `http://127.0.0.1:${broker.server.address().port}`,
        token,
        allowLocalHttp: true,
      });
      assert.equal(await client.available(), true);
      const objects = createSkillObjects(runtime, bytes);
      const imports = createSkillImports(runtime, {
        objects,
        runtimeAvailable: client.available,
        review: () => async () => ({
          summary: 'Fixture review only; the local script copies one bundled file.',
          findings: [],
        }),
      });
      const importId = randomUUID();
      await imports.draft(
        workspace.id,
        actor,
        importId,
        [
          {
            path: 'SKILL.md',
            bytes: Buffer.from(
              '---\nname: copy-example\ndescription: Copy the packaged example into a file\n---\nRun scripts/copy.sh when asked.',
            ),
          },
          {
            path: 'scripts/copy.sh',
            bytes: Buffer.from('cat assets/example.txt > "$TULIPFARM_OUTPUT_DIR/result.txt"\nprintf "copied"'),
          },
          { path: 'assets/example.txt', bytes: Buffer.from('exact packaged bytes') },
        ],
        [],
        objects,
      );
      await imports.process(workspace.id, importId);
      const review = await imports.read(workspace.id, actor, importId);
      const [receipt] = await imports.approve(workspace.id, actor.userId, importId, {
        commandId: randomUUID(),
        digest: review.digest,
        selected: review.selected,
        acknowledgeWarnings: true,
      });
      const context = {
        workspaceId: workspace.id,
        actor,
        callId: randomUUID(),
        scope: { kind: 'conversation', id: randomUUID(), turnId: randomUUID() },
        sources: [],
      };
      const call = {
        tool: 'skills.execute',
        skillId: receipt.id,
        revision: receipt.activeRevision,
        language: 'bash',
        entrypoint: 'scripts/copy.sh',
        args: [],
        input: null,
      };
      let submittedJob;
      const execution = createSkillExecutionFactory(bytes, {
        ...client,
        submit: job => {
          submittedJob = job;
          return client.submit(job);
        },
      })(runtime);
      let result = await execution.execute(context, call);
      const deadline = Date.now() + 30000;
      while (result.status === 'pending' && Date.now() < deadline) {
        await delay(100);
        result = await execution.execute(context, { ...call, invocationId: result.invocationId });
      }
      assert.equal(result.status, 'completed');
      assert.equal(result.stdout, 'copied');
      assert.equal(result.files.length, 1);
      const files = createFiles(runtime, bytes);
      assert.equal(
        Buffer.from((await files.download(workspace.id, actor.userId, result.files[0].id)).bytes).toString(),
        'exact packaged bytes',
      );
      assert.deepEqual(await execution.execute(context, { ...call, invocationId: result.invocationId }), result);
      const brokerResult = await client.submit(submittedJob);
      const port = broker.server.address().port;
      await broker.close();
      broker = await createSnippetBroker(brokerOptions);
      broker.server.listen(port, '127.0.0.1');
      await once(broker.server, 'listening');
      assert.deepEqual(
        await client.submit(submittedJob),
        brokerResult,
        'A restarted broker retains the exact execution receipt',
      );
      const selected = [{ id: receipt.id, revision: receipt.activeRevision }];
      const agent = await savedTaskAgent(db, workspace, runtime, actor.userId, actor.membershipId, selected, [
        'skills.execute',
        'skills.files.read',
      ]);
      await db.platform.query(`UPDATE "${workspace.names.schema}".tf_teams SET name='Script executors' WHERE id=$1`, [
        agent.teamId,
      ]);
      await seedExecution(db, workspace, agent.agentId, [agent.teamId], []);
      const executor = createAgentExecutor({ runtime, skills: createSkillExecutionFactory(bytes, client) });
      const run = await executor.startDelegated(workspace.id, actor, { activationId: agent.activationId, scope: [] });
      async function executeRun(run, request) {
        const until = Date.now() + 30000;
        for (let sequence = 0; Date.now() < until; sequence++) {
          const ids = { workspaceId: workspace.id, runId: run.runId, callId: randomUUID() };
          await executor.queueCall(workspace.id, actor, {
            runId: run.runId,
            callId: ids.callId,
            sequence,
            call: request,
          });
          assert.equal(await executor.execute(ids), 'completed', JSON.stringify(await executor.readResult(ids, actor)));
          const output = (await executor.readResult(ids, actor)).result;
          if (output.status !== 'pending') {
            assert.equal(output.status, 'completed', JSON.stringify(output));
            return output;
          }
          request = { ...request, invocationId: output.invocationId };
          await delay(100);
        }
        assert.fail('Script did not finish within the execution deadline');
      }
      const named = await executeRun(run, call);
      assert.equal(
        Buffer.from((await files.download(workspace.id, actor.userId, named.files[0].id)).bytes).toString(),
        'exact packaged bytes',
      );
      const folder = await files.createFolder(workspace.id, actor.userId, randomUUID(), {
        name: 'Scheduled output',
        parentId: null,
      });
      const schedule = await executor.authorizeSchedule(workspace.id, actor, {
        activationId: agent.activationId,
        scope: [],
      });
      const scheduled = await executor.startScheduled(workspace.id, {
        scheduleId: schedule.scheduleId,
        runId: randomUUID(),
      });
      const scheduledResult = await executeRun(scheduled, { ...call, folderId: folder.id });
      assert.equal(
        Buffer.from((await files.download(workspace.id, actor.userId, scheduledResult.files[0].id)).bytes).toString(),
        'exact packaged bytes',
      );
      const noGrant = await savedTaskAgent(db, workspace, runtime, actor.userId, actor.membershipId, selected, [
        'skills.list',
      ]);
      await seedExecution(db, workspace, noGrant.agentId, [noGrant.teamId], []);
      const deniedRun = await executor.startDelegated(workspace.id, actor, {
        activationId: noGrant.activationId,
        scope: [],
      });
      await assert.rejects(
        executor.queueCall(workspace.id, actor, { runId: deniedRun.runId, callId: randomUUID(), sequence: 0, call }),
        AccessDenied,
      );
      const skills = createWorkspaceSkills(runtime);
      await skills.setEnabled(workspace.id, actor, receipt.id, {
        requestId: randomUUID(),
        expectedVersion: receipt.version,
        enabled: false,
      });
      await assert.rejects(files.download(workspace.id, actor.userId, result.files[0].id), AccessDenied);
      await assert.rejects(execution.execute(context, { ...call, invocationId: result.invocationId }), AccessDenied);
      const disabled = await skills.read(workspace.id, actor, receipt.id);
      await skills.setEnabled(workspace.id, actor, receipt.id, {
        requestId: randomUUID(),
        expectedVersion: disabled.management.version,
        enabled: true,
      });
      assert.deepEqual(
        await execution.execute(
          { ...context, sources: [{ kind: 'workspace-skill', skillId: randomUUID(), revision: 'f'.repeat(64) }] },
          { ...call, invocationId: result.invocationId },
        ),
        result,
        'Later chat context does not change an existing invocation input',
      );
      await assert.rejects(
        execution.execute(context, { ...call, invocationId: result.invocationId, args: ['different'] }),
        /import-conflict/,
      );
      const dispatched = [];
      const uncertain = createSkillExecutionFactory(bytes, {
        async submit(job) {
          dispatched.push(job.invocationId);
          if (dispatched.length === 1) throw new Error('Connection lost after dispatch');
          return {
            kind: 'completed',
            exitCode: 0,
            stdout: '',
            stderr: '',
            files: [
              { path: 'unsupported.html', content: Buffer.from('<h1>Not a supported output</h1>').toString('base64') },
            ],
          };
        },
      })(runtime);
      const uncertainContext = { ...context, callId: randomUUID() };
      const pending = await uncertain.execute(uncertainContext, call);
      assert.equal(pending.status, 'pending');
      assert.equal(pending.error, 'execution-outcome-unknown');
      const failed = await uncertain.execute(uncertainContext, { ...call, invocationId: pending.invocationId });
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error, 'output-rejected');
      assert.deepEqual(failed.files, []);
      assert.deepEqual(dispatched, [pending.invocationId, pending.invocationId]);
      assert.deepEqual(
        await uncertain.execute(uncertainContext, { ...call, invocationId: pending.invocationId }),
        failed,
      );
      assert.equal(dispatched.length, 2, 'Completed failure is durable and never dispatches again');
      let live = true;
      const guarded = {
        transaction: (...args) => {
          if (!live) return Promise.reject(new AccessDenied());
          return runtime.transaction(...args);
        },
      };
      const cancelled = createSkillExecutionFactory(bytes, {
        async submit(job) {
          const response = await client.submit(job);
          live = false;
          return response;
        },
      })(guarded);
      await assert.rejects(cancelled.execute({ ...context, callId: randomUUID() }, call), AccessDenied);
    } finally {
      await broker?.close();
      await runtime?.close();
      await db.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
