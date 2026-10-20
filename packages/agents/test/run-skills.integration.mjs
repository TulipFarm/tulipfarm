import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { initializeSoul } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision, readVerifiedProjection, verifySoulRevision } from '@tulipfarm/workspaces/soul-revisions';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { createAgentAuthoring } from '../src/authoring.ts';
import { createSavedAgentService } from '../src/saved-service.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createAgentChat } from '../src/chat.ts';
import { nativeReply } from './native-fixture.mjs';
import { createAgentSchedules } from '../src/schedules.ts';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../tables/test/fixture.mjs';
import { createChatTools } from '../src/tools.ts';
import { inferDecision } from '../src/inference.ts';
import { syntheticContinuity } from './continuity-fixture.mjs';

async function ownedObjects(t) {
  assert.ok(
    process.env.RUSTFS_BINARY,
    'Set RUSTFS_BINARY to a local RustFS executable. This test starts its own service.',
  );
  const directory = await mkdtemp(join(tmpdir(), 'agent-run-skills-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const accessKeyId = randomUUID(),
    secretAccessKey = randomUUID();
  const child = spawn(process.env.RUSTFS_BINARY, ['server', '--address', `127.0.0.1:${port}`, directory], {
    env: {
      ...process.env,
      RUSTFS_ACCESS_KEY: accessKeyId,
      RUSTFS_SECRET_KEY: secretAccessKey,
      RUSTFS_CONSOLE_ENABLE: 'false',
    },
    stdio: 'ignore',
  });
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
  t.after(async () => {
    client.destroy();
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const bucket = `agent-run-skills-${randomUUID()}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      return { client, bucket };
    } catch (error) {
      if (child.exitCode !== null || attempt === 99) throw error;
      await delay(100);
    }
  }
  throw new Error('Owned object service did not start');
}

test(
  'run-bound reviewed workspace skills survive Soul saves and enforce live execution authority',
  { timeout: 180000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    const soul = await ownedObjects(t);
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    const w = await db.create(migrations),
      other = await db.create(migrations);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async id => {
        const target = db.workspaces.find(workspace => workspace.id === id);
        assert.ok(target);
        return { workspaceId: id, generation: 1, connectionString: db.login(target) };
      },
    });
    const table = name => qualified(w.names.schema, name);
    const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const team = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Invokers')`, [team]);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      member.membershipId,
      team,
    ]);
    const skills = createWorkspaceSkills(runtime),
      executor = createAgentExecutor({ runtime });
    const seed = { workspaceId: w.id, createdBy: w.userId, createdAt: new Date().toISOString() };
    const initial = await initializeSoul(soul, seed);
    await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, [initial.commit]);
    const commands = createAgentAuthoring(runtime);
    const prepared = [];
    const worker = commands.withWriter(async input => {
      const revision = await prepareSoulRevision(
        soul,
        seed,
        input.parent ? { commit: input.expectedParentCommit, bucket: soul.bucket, ...input.parent } : initial,
        {
          kind: 'agent',
          commandId: input.commandId,
          expectedParentCommit: input.expectedParentCommit,
          createdAt: input.createdAt,
          definition: input.definition,
        },
      );
      prepared.push(revision);
      return revision;
    });
    const service = createSavedAgentService(runtime, (id, projection) => readVerifiedProjection(soul, id, projection));
    const agentId = randomUUID(),
      skillId = randomUUID();
    const original = {
      name: 'Reviewed cleanup',
      description: 'Review cleanup requests before proposing changes.',
      instructions: 'Inspect first. Propose exact changes. Never claim a tool grant.',
    };
    let receipt = await skills.save(w.id, admin, skillId, {
      requestId: randomUUID(),
      expectedVersion: 0,
      definition: original,
    });
    const selection = { id: skillId, revision: receipt.savedRevision };
    const definition = {
      name: 'Cleanup agent',
      instructions: 'Use the reviewed procedure.',
      tools: ['skills.list'],
      skills: [selection],
    };
    async function save(selected, id = agentId) {
      const head = (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0]
        .revision;
      const saved =
        (await db.platform.query(`SELECT saved_revision FROM ${table('tf_agents')} WHERE id=$1`, [id])).rows[0]
          ?.saved_revision ?? null;
      const command = await commands.save(w.id, admin, id, {
        requestId: randomUUID(),
        expectedSoulRevision: head,
        expectedSavedRevision: saved,
        owningTeamId: team,
        definition: selected,
      });
      assert.equal((await worker.prepare(w.id, command.commandId)).status, 'accepted');
      return service.detail(w.id, w.userId, id);
    }
    const detail = await save(definition);
    await executor.configure(w.id, admin, { agentId, version: 0, enabled: true, teamIds: [team], limits: [] });
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'read'),($1,$2,'invoke')`,
      [agentId, team],
    );
    let activation;
    const setEnabled = async enabled => {
      receipt = await skills.setEnabled(w.id, admin, skillId, {
        requestId: randomUUID(),
        expectedVersion: receipt.version,
        enabled,
      });
    };
    const start = () => executor.startDelegated(w.id, member, { activationId: activation.activationId, scope: [] });

    await t.test(
      'save, Soul projection, tool readback and activation retain exact references and reject unreviewed revisions',
      async () => {
        assert.deepEqual(detail.definition, definition);
        const last = prepared.at(-1);
        const verified = await verifySoulRevision(soul, seed, last.bundle, last.projection);
        assert.deepEqual(verified.definition.skills, [selection]);
        const read = await createChatTools(runtime).invoke(
          { workspaceId: w.id, actor: member, callId: randomUUID() },
          { tool: 'agents.read', agentId },
        );
        assert.deepEqual(read.definition.skills, [selection]);
        await assert.rejects(
          executor.activate(w.id, admin, { agentId, revision: detail.definitionRevision, scope: [] }),
          AccessDenied,
        );
        receipt = await skills.review(w.id, admin, skillId, {
          requestId: randomUUID(),
          expectedVersion: receipt.version,
          revision: receipt.savedRevision,
        });
        activation = await executor.activate(w.id, admin, { agentId, revision: detail.definitionRevision, scope: [] });
        assert.deepEqual(
          (await service.detail(w.id, w.userId, agentId)).activations.map(item => item.revision),
          [detail.definitionRevision],
        );
      },
    );

    let run;
    await t.test(
      'edits and newer review never replace pinned selections; picker uses reviewed rather than creator draft',
      async () => {
        run = await start();
        assert.deepEqual(await skills.resolveRun(w.id, run.runId), [{ ...selection, ...original }]);
        receipt = await skills.save(w.id, admin, skillId, {
          requestId: randomUUID(),
          expectedVersion: receipt.version,
          definition: {
            name: 'New draft',
            description: 'A different cleanup procedure.',
            instructions: 'Different procedure.',
          },
        });
        assert.deepEqual((await skills.list(w.id, admin, { view: 'reviewed' })).workspace, [
          {
            ...selection,
            name: original.name,
            description: original.description,
            source: 'Legacy skill',
            status: 'enabled',
          },
        ]);
        assert.equal((await skills.list(w.id, admin)).workspace[0].revision, receipt.savedRevision);
        const changed = await save({ ...definition, skills: [{ id: skillId, revision: receipt.savedRevision }] });
        await assert.rejects(
          executor.activate(w.id, admin, { agentId, revision: changed.definitionRevision, scope: [] }),
          AccessDenied,
        );
        receipt = await skills.review(w.id, admin, skillId, {
          requestId: randomUUID(),
          expectedVersion: receipt.version,
          revision: receipt.savedRevision,
        });
        await executor.activate(w.id, admin, { agentId, revision: changed.definitionRevision, scope: [] });
        assert.deepEqual(await createWorkspaceSkills(runtime).resolveRun(w.id, run.runId), [
          { ...selection, ...original },
        ]);
        assert.deepEqual((await start()).revision, detail.definitionRevision);
      },
    );

    await t.test('forged and cross-workspace runs fail; skills never add tools', async () => {
      await assert.rejects(skills.resolveRun(w.id, randomUUID()), AccessDenied);
      await assert.rejects(skills.resolveRun(other.id, run.runId), AccessDenied);
      await assert.rejects(
        skills.resolve(w.id, { kind: 'agent', runId: run.runId }, [selection]),
        error => error.name === 'ZodError',
      );
      await assert.rejects(
        executor.queueCall(w.id, member, {
          runId: run.runId,
          callId: randomUUID(),
          sequence: 0,
          call: { tool: 'skills.read', skillId: 'agent-authoring' },
        }),
        AccessDenied,
      );
      const readIds = { workspaceId: w.id, runId: run.runId, callId: randomUUID() };
      await executor.queueCall(w.id, member, {
        runId: readIds.runId,
        callId: readIds.callId,
        sequence: 0,
        call: { tool: 'skills.read', skillId, revision: selection.revision },
      });
      assert.equal(await executor.execute(readIds), 'completed');
      assert.deepEqual((await executor.readResult(readIds, member)).result, {
        id: skillId,
        revision: selection.revision,
        ...original,
      });
      const ids = { workspaceId: w.id, runId: run.runId, callId: randomUUID() };
      await executor.queueCall(w.id, member, {
        runId: ids.runId,
        callId: ids.callId,
        sequence: 1,
        call: { tool: 'skills.list' },
      });
      assert.equal(await executor.execute(ids), 'completed');
      assert.equal((await executor.readResult(ids, member)).result.source, 'bundled');
      await setEnabled(false);
      await assert.rejects(executor.readResult(ids, member), AccessDenied);
      await assert.rejects(start(), AccessDenied);
      await assert.rejects(
        executor.activate(w.id, admin, { agentId, revision: detail.definitionRevision, scope: [] }),
        AccessDenied,
      );
      assert.deepEqual((await skills.list(w.id, admin, { view: 'reviewed' })).workspace, []);
      await setEnabled(true);
      const foreignSkill = randomUUID();
      const foreignDraft = await skills.save(other.id, other.userId, foreignSkill, {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: original,
      });
      await skills.review(other.id, other.userId, foreignSkill, {
        requestId: randomUUID(),
        expectedVersion: 1,
        revision: foreignDraft.savedRevision,
      });
      const foreignAgent = randomUUID();
      const foreignSelection = await save(
        { ...definition, skills: [{ id: foreignSkill, revision: foreignDraft.savedRevision }] },
        foreignAgent,
      );
      await assert.rejects(
        executor.activate(w.id, admin, {
          agentId: foreignAgent,
          revision: foreignSelection.definitionRevision,
          scope: [],
        }),
        AccessDenied,
      );
    });

    await t.test('disable after planning blocks an action and persisted waiting work on resume', async () => {
      for (const waiting of [false, true]) {
        const planned = await start();
        const ids = { workspaceId: w.id, runId: planned.runId, callId: randomUUID() };
        await executor.queueCall(w.id, member, {
          runId: ids.runId,
          callId: ids.callId,
          sequence: 0,
          call: { tool: 'skills.list' },
        });
        if (waiting)
          await db.platform.query(`UPDATE ${table('tf_agent_tool_calls')} SET status='waiting' WHERE id=$1`, [
            ids.callId,
          ]);
        await setEnabled(false);
        assert.equal(await createAgentExecutor({ runtime }).execute(ids), 'blocked');
        assert.deepEqual(
          (
            await db.platform.query(`SELECT status,result FROM ${table('tf_agent_tool_calls')} WHERE id=$1`, [
              ids.callId,
            ])
          ).rows,
          [{ status: 'blocked', result: { code: 'access-denied' } }],
        );
        await setEnabled(true);
      }
    });

    let responseGate = async () => {};
    const requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      await responseGate();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nativeReply('anthropic', { text: 'Reviewed answer' })));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, options) => {
      if (new URL(url).hostname === 'api.anthropic.com')
        return originalFetch(`http://127.0.0.1:${server.address().port}/v1/messages`, options);
      return originalFetch(url, options);
    });
    const continuity = {
      ...syntheticContinuity(() => assert.fail('Use real provider adapter')),
      infer: (_resolution, input, timeoutMs, signal) =>
        inferDecision(
          {
            provider: 'anthropic',
            endpoint: 'https://api.anthropic.com/',
            model: 'claude-opus-5-5',
            apiKey: 'local-fixture',
            timeoutMs,
          },
          input,
          signal,
        ),
    };
    const chat = createAgentChat(runtime, continuity);
    const submit = async (driver = chat) => {
      const id = randomUUID();
      await driver.submit(w.id, member.userId, agentId, {
        id,
        activationId: activation.activationId,
        scope: [],
        prompt: 'Inspect records',
      });
      return id;
    };

    await t.test(
      'real provider request contains original reviewed text and only explicitly configured tools',
      async () => {
        const id = await submit();
        await chat.processTurn(w.id, id);
        const context = JSON.parse(requests.at(-1).messages[0].content.split('\n')[2]);
        assert.deepEqual(context.selectedSkills, [
          { id: skillId, revision: selection.revision, name: original.name, description: original.description },
        ]);
        assert.deepEqual(Object.keys(context.tools).sort(), ['skills.list', 'skills.read']);
        assert.equal((await chat.read(w.id, member.userId, agentId, id)).text, 'Reviewed answer');
        await setEnabled(false);
        assert.equal((await chat.read(w.id, member.userId, agentId, id)).text, null);
        await setEnabled(true);
      },
    );

    await t.test(
      'disable before inference prevents dispatch and disable in flight rejects the late answer',
      async () => {
        const id = await submit();
        const count = requests.length;
        await setEnabled(false);
        await chat.processTurn(w.id, id);
        assert.equal(requests.length, count);
        assert.equal(
          (await db.platform.query(`SELECT failure FROM ${table('tf_model_generations')} WHERE run_id=$1`, [id]))
            .rows[0].failure,
          'authority-revoked',
        );
        await assert.rejects(submit(), AccessDenied);
        await setEnabled(true);
        const late = await submit();
        let enter, release;
        const entered = new Promise(resolve => {
          enter = resolve;
        });
        const gate = new Promise(resolve => {
          release = resolve;
        });
        responseGate = async () => {
          enter();
          await gate;
        };
        const running = chat.processTurn(w.id, late);
        await entered;
        await setEnabled(false);
        release();
        await running;
        responseGate = async () => {};
        assert.deepEqual(
          (await db.platform.query(`SELECT status,decision FROM ${table('tf_agent_chat_turns')} WHERE id=$1`, [late]))
            .rows,
          [{ status: 'failed', decision: null }],
        );
        await assert.rejects(
          chat.retry(w.id, member.userId, agentId, late, { requestId: randomUUID(), expectedGeneration: 0 }),
          AccessDenied,
        );
        await setEnabled(true);
        const transient = await submit();
        const transientEntered = new Promise(resolve => {
          enter = resolve;
        });
        const transientGate = new Promise(resolve => {
          release = resolve;
        });
        responseGate = async () => {
          enter();
          await transientGate;
        };
        const transientRunning = chat.processTurn(w.id, transient);
        await transientEntered;
        await setEnabled(false);
        await setEnabled(true);
        release();
        await transientRunning;
        responseGate = async () => {};
        assert.deepEqual(
          (
            await db.platform.query(`SELECT status,decision FROM ${table('tf_agent_chat_turns')} WHERE id=$1`, [
              transient,
            ])
          ).rows,
          [{ status: 'failed', decision: null }],
        );
      },
    );

    await t.test('disable queued between model claim and dispatch prevents the provider request', async () => {
      let enter, release;
      const entered = new Promise(resolve => {
        enter = resolve;
      });
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const driver = createAgentChat(runtime, {
        ...continuity,
        health: {
          ...continuity.health,
          claim: async () => {
            enter();
            await gate;
            return true;
          },
        },
      });
      const id = await submit(driver),
        count = requests.length;
      const running = driver.processTurn(w.id, id);
      await entered;
      const disable = setEnabled(false);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const row = (
            await db.databaseAdmin.query(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%tf_authorization_lock%FOR UPDATE%') AS waiting`,
            )
          ).rows[0];
          if (row.waiting) {
            waiting = true;
            break;
          }
          await delay(10);
        }
        assert.equal(waiting, true, 'Disable must reach the held authorization lock');
        release();
        await disable;
        await running;
        assert.equal(requests.length, count);
        assert.equal(
          (await db.platform.query(`SELECT failure FROM ${table('tf_model_generations')} WHERE run_id=$1`, [id]))
            .rows[0].failure,
          'authority-revoked',
        );
      } finally {
        release();
        await disable;
        await running;
        await setEnabled(true);
      }
    });

    await t.test('record action and scheduled authority stay revoked after re-enable', async () => {
      const field = textField('Name');
      const created = await createTableWithRows({
        db,
        workspace: w,
        runtime,
        definition: tableDefinition({ owningTeamId: team, label: 'People', fields: [field] }),
        records: [{ values: textValues(field, 'alice') }],
      });
      const tableId = created.tableId,
        revision = created.revision,
        record = created.records[0];
      const records = createAgentRecordTools(runtime);
      const scope = [{ assetId: tableId, permissions: ['table.row.read', 'table.row.update'] }];
      for (const permission of scope[0].permissions)
        await db.platform.query(`INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
          team,
          tableId,
          permission,
        ]);
      const id = randomUUID();
      const saved = await save({ ...definition, tools: ['rows.update', 'schema.inspect'] }, id);
      await executor.configure(w.id, admin, { agentId: id, version: 0, enabled: true, teamIds: [team], limits: scope });
      const active = await executor.activate(w.id, admin, { agentId: id, revision: saved.definitionRevision, scope });
      const started = await executor.startDelegated(w.id, admin, { activationId: active.activationId, scope });
      const first = { workspaceId: w.id, runId: started.runId, callId: randomUUID() };
      const call = {
        tool: 'rows.update',
        tableId,
        recordId: record.id,
        expectedAppliedRevision: revision,
        expectedToken: (await records.getRecord(w.id, admin, tableId, revision, record.id)).token,
        values: textValues(field, 'Alice'),
      };
      await executor.queueCall(w.id, admin, { runId: first.runId, callId: first.callId, sequence: 0, call });
      assert.equal(await executor.execute(first), 'completed');
      assert.deepEqual(
        (await records.getRecord(w.id, admin, tableId, revision, record.id)).values,
        textValues(field, 'Alice'),
      );
      const second = { ...first, callId: randomUUID() };
      await executor.queueCall(w.id, admin, {
        runId: second.runId,
        callId: second.callId,
        sequence: 1,
        call: { ...call, values: textValues(field, 'Forbidden') },
      });
      const schedules = createAgentSchedules(runtime);
      const inspection = await schedules.activate(w.id, w.userId, id, {
        id: randomUUID(),
        revision: saved.definitionRevision,
        tableId,
      });
      const scheduleId = randomUUID();
      await schedules.save(w.id, w.userId, id, {
        id: scheduleId,
        activationId: inspection.activationId,
        action: { kind: 'inspect', tableId },
        trigger: { kind: 'interval', minutes: 60 },
        sponsorMembershipId: w.membershipId,
        historyAudience: [],
      });
      const due = await schedules.due(w.id);
      assert.equal(due.length, 1);
      assert.deepEqual(await skills.resolveRun(w.id, due[0].runId), [{ ...selection, ...original }]);
      await setEnabled(false);
      await setEnabled(true);
      assert.equal(await executor.execute(second), 'blocked');
      assert.deepEqual(
        (await records.getRecord(w.id, admin, tableId, revision, record.id)).values,
        textValues(field, 'Alice'),
      );
      assert.equal(await executor.execute(due[0]), 'blocked');
      const schedule = await executor.authorizeSchedule(w.id, admin, { activationId: active.activationId, scope });
      const scheduled = await executor.startScheduled(w.id, { scheduleId: schedule.scheduleId, runId: randomUUID() });
      assert.deepEqual(await skills.resolveRun(w.id, scheduled.runId), [{ ...selection, ...original }]);
      await setEnabled(false);
      await assert.rejects(
        executor.startScheduled(w.id, { scheduleId: schedule.scheduleId, runId: randomUUID() }),
        AccessDenied,
      );
      await assert.rejects(skills.resolveRun(w.id, scheduled.runId), AccessDenied);
      await setEnabled(true);
      const fresh = await executor.startDelegated(w.id, admin, { activationId: active.activationId, scope });
      assert.deepEqual(await skills.resolveRun(w.id, fresh.runId), [{ ...selection, ...original }]);
      await executor.revokeActivation(w.id, admin, { agentId: id, activationId: active.activationId });
      await assert.rejects(skills.resolveRun(w.id, fresh.runId), AccessDenied);
      await setEnabled(false);
      await assert.rejects(
        schedules.activate(w.id, w.userId, id, { id: randomUUID(), revision: saved.definitionRevision, tableId }),
        AccessDenied,
      );
      await setEnabled(true);
    });

    await t.test('current invoke grants and original membership incarnation govern run resolution', async () => {
      run = await start();
      await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
        member.membershipId,
        team,
      ]);
      await assert.rejects(skills.resolveRun(w.id, run.runId), AccessDenied);
      await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        member.membershipId,
        team,
      ]);
      await db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='invoke'`, [
        agentId,
      ]);
      await assert.rejects(skills.resolveRun(w.id, run.runId), AccessDenied);
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke')`,
        [agentId, team],
      );
      assert.deepEqual(await skills.resolveRun(w.id, run.runId), [{ ...selection, ...original }]);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
        member.membershipId,
      ]);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        member.userId,
      ]);
      await assert.rejects(skills.resolveRun(w.id, run.runId), AccessDenied);
    });

    await t.test(
      'definitions without skills and built-in-only selections still execute without workspace skill access',
      async () => {
        await setEnabled(false);
        for (const selected of [undefined, [{ id: 'agent-authoring', revision: '1' }]]) {
          const id = randomUUID();
          const legacy = await save(
            {
              name: 'Legacy',
              instructions: 'Inspect',
              tools: ['skills.list'],
              ...(selected ? { skills: selected } : {}),
            },
            id,
          );
          await executor.configure(w.id, admin, { agentId: id, version: 0, enabled: true, teamIds: [], limits: [] });
          const active = await executor.activate(w.id, admin, {
            agentId: id,
            revision: legacy.definitionRevision,
            scope: [],
          });
          const started = await executor.startDelegated(w.id, admin, { activationId: active.activationId, scope: [] });
          const procedures = await skills.resolveRun(w.id, started.runId);
          assert.deepEqual(
            procedures.map(procedure => procedure.id),
            selected ? ['agent-authoring'] : [],
          );
          const callId = randomUUID();
          await executor.queueCall(w.id, admin, {
            runId: started.runId,
            callId,
            sequence: 0,
            call: { tool: 'skills.list' },
          });
          assert.equal(await executor.execute({ workspaceId: w.id, runId: started.runId, callId }), 'completed');
        }
      },
    );
  },
);
