import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { AccessDenied } from '@tulipfarm/access';
import { GoogleOperationError } from '@tulipfarm/google-workspace/operation-contracts';
import { GoogleFileError } from '@tulipfarm/google-workspace/public-contracts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime, taskGoogleFilesReader } from '../src/task-runtime.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';

const terms = 'Freight is invoiced on the first of each month.';
const drive = 'https://www.googleapis.com/auth/drive';

test(
  'a task reads its owner’s Google Drive input through the integration bound at send time, records the read, and stops plainly when that integration changes',
  { timeout: 180000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
    for (const migration of ['0001_baseline.sql'])
      await db.platform.query(
        await readFile(new URL(`../../../apps/database/migrations/${migration}`, import.meta.url), 'utf8'),
      );
    const w = await db.create(await workspaceTableMigrations()),
      table = name => `"${w.names.schema}"."${name}"`;
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
    const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['rows.list']);
    await createAgentExecutor({ runtime }).configure(
      w.id,
      { kind: 'human', userId: w.userId, membershipId: w.membershipId },
      { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
    );

    const integrationId = randomUUID();
    const integration = { integrationId, accountId: 'google-account-1', generation: 1 };
    const google = { reads: [], files: new Map([['drive-terms', terms]]), failure: null, afterRead: null };
    // Stands in for the Google operations service: it reads only through the integration the caller names, as `fileText` does.
    const reader = {
      async fileText(workspaceId, userId, input) {
        google.reads.push({ workspaceId, userId, input });
        if (
          input.expectedIntegration.integrationId !== integration.integrationId ||
          input.expectedIntegration.accountId !== integration.accountId ||
          input.expectedIntegration.generation !== integration.generation
        )
          throw new GoogleOperationError('reconnect-required');
        if (google.failure) throw google.failure;
        const text = google.files.get(input.fileId);
        if (text === undefined) throw new GoogleFileError('source-not-found');
        await google.afterRead?.();
        return {
          metadata: {
            id: input.fileId,
            name: 'Freight terms',
            mimeType: 'application/vnd.google-apps.document',
            version: '88',
            modifiedTime: '2026-10-05T09:00:00.000Z',
          },
          bytes: Buffer.from(text),
          contentType: 'text/plain',
          representation: 'export',
        };
      },
    };

    const route = {
      id: 'google-task',
      modelId: 'claude-opus-5-5',
      provider: 'anthropic',
      deployment: 'claude-opus-5-5',
      location: 'test',
      adapterVersion: 1,
      qualification: 'local',
      lifecycle: 'current',
      maxInputTokens: 100000,
      maxOutputTokens: 4096,
      boundedDecision: true,
    };
    const bundle = modelBundleSchema.parse({
      format: 1,
      id: 'google-task',
      mapping: {
        ...initialModelMapping,
        revision: 'google-task',
        families: initialModelMapping.families.filter(f => f.id === 'claude-opus'),
      },
      models: initialBundleModels,
      routes: [route],
    });
    const prompts = [];
    const model = {
      activeBundle: () => ({ bundle, activationRevision: 1 }),
      trustedBundle: () => bundle,
      restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
      allowed: () => true,
      actualModelIds: () => [route.modelId],
      legacyFamily: () => 'claude-opus',
      budgetPicoUsd: () => '10000000000000',
      health: createModelRouteHealth(db.platform, () => 'google-task'),
      infer: async (_resolution, input) => {
        prompts.push(JSON.parse(input.prompt));
        return {
          kind: 'success',
          decision: { kind: 'answer', text: 'On the first of each month.' },
          actualModel: route.modelId,
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
      taskGoogleFilesReader(reader),
    );
    const limits = { toolCalls: 10, credits: 100, activeMilliseconds: 120000 };
    const start = (sources, text = 'When is freight invoiced?') =>
      tasks.start(w.id, user, { requestId: randomUUID(), agentId: agent.agentId, scope: [], text, sources, limits });
    const run = async id => {
      for (let n = 0; n < 8 && ['pending', 'waiting-approval'].includes((await tasks.read(w.id, user, id)).status); n++)
        await engine.process(w.id, id);
      return tasks.read(w.id, user, id);
    };
    const history = async id => (await tasks.history(w.id, user, id)).messages;
    const binding = generation => ({
      kind: 'google-drive-file',
      fileId: 'drive-terms',
      integrationId,
      accountId: 'google-account-1',
      generation,
    });

    await assert.rejects(
      start([{ kind: 'drive-file', fileId: 'drive-terms' }]),
      { code: 'google-integration-required' },
      'a Drive input needs the owner’s Google integration',
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_google_integrations')} (id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES ($1,$2,$3,1,'connected','google-account-1','owner@example.com',$4,'{}')`,
      [integrationId, user, member, ['https://www.googleapis.com/auth/gmail.send']],
    );
    await assert.rejects(
      start([{ kind: 'drive-file', fileId: 'drive-terms' }]),
      { code: 'google-integration-required' },
      'an integration without Drive access cannot bind it',
    );
    await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET scopes=$2 WHERE id=$1`, [
      integrationId,
      [drive],
    ]);
    for (const forged of [
      binding(1),
      {
        ...binding(1),
        kind: 'google-file',
        conversationId: randomUUID(),
        membershipId: member,
        read: { readAt: new Date().toISOString(), sha256: 'a'.repeat(64), representation: 'export' },
      },
    ])
      await assert.rejects(
        start([forged]),
        { name: 'ZodError' },
        `a person cannot supply a ${forged.kind} binding or receipt`,
      );

    const task = await start([{ kind: 'drive-file', fileId: 'drive-terms' }]);
    assert.deepEqual(
      (await history(task.id))[0].sources,
      [binding(1)],
      'the server binds the input to the owner’s current integration',
    );
    assert.equal((await run(task.id)).status, 'completed');
    assert.deepEqual(
      google.reads.map(read => [read.userId, read.input]),
      [
        [
          user,
          {
            fileId: 'drive-terms',
            expectedIntegration: { integrationId, accountId: 'google-account-1', generation: 1 },
          },
        ],
      ],
      'the read goes through the bound integration as the owner',
    );
    assert.deepEqual(prompts[0].files, [{ source: binding(1), filename: 'Freight terms', text: terms }]);
    const receipt = (await history(task.id))
      .at(-1)
      .sources.find(source => source.kind === 'google-drive-file' && source.read);
    assert.deepEqual(receipt, {
      ...binding(1),
      read: {
        readAt: receipt.read.readAt,
        sha256: createHash('sha256').update(terms).digest('hex'),
        representation: 'export',
        version: '88',
        modifiedTime: '2026-10-05T09:00:00.000Z',
      },
    });
    assert.ok(!Number.isNaN(Date.parse(receipt.read.readAt)));

    const taskRun = (
      await db.platform.query(
        `SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1 ORDER BY generation DESC LIMIT 1`,
        [task.id],
      )
    ).rows[0].run_id;
    await tasks.checkSources(w.id, user, [binding(1)], taskRun);
    await assert.rejects(
      tasks.checkSources(w.id, user, [binding(1)], randomUUID()),
      AccessDenied,
      'a run that is not the owner’s task run cannot read it',
    );
    const scheduleId = randomUUID(),
      scheduledRun = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_agent_schedules')} (id,activation_id,scope) VALUES ($1,$2,'[]')`, [
      scheduleId,
      agent.activationId,
    ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,schedule_id,scope) VALUES ($1,$2,$3,$4,'scheduled',$5,'[]')`,
      [scheduledRun, agent.agentId, agent.activationId, agent.revision, scheduleId],
    );
    await assert.rejects(
      tasks.checkSources(w.id, user, [binding(1)], scheduledRun),
      AccessDenied,
      'a scheduled run, which no person started, is refused',
    );

    const changed = await start([{ kind: 'drive-file', fileId: 'drive-terms' }], 'Summarize the freight terms.');
    integration.generation = 2;
    await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET generation=2 WHERE id=$1`, [integrationId]);
    const before = prompts.length;
    const paused = await run(changed.id);
    assert.equal(paused.status, 'paused', 'a changed integration stops the task instead of reading through it');
    assert.equal(paused.pauseReason, 'file');
    assert.equal(
      (await history(changed.id)).at(-1).text,
      'A Google Drive file for this task is unavailable because your Google integration changed: it was disconnected, needs reconnecting, lacks Drive access, or now uses another Google account. Its contents were not read. Reconnect Google Drive, then add the file to your next message again.',
    );
    assert.equal(prompts.length, before, 'nothing from the file reaches the model');
    assert.equal(
      google.reads.at(-1).input.expectedIntegration.generation,
      1,
      'the read named the old binding, never the new integration',
    );

    const messages = await history(changed.id);
    const resumed = await tasks.continueTask(w.id, user, changed.id, {
      requestId: randomUUID(),
      expectedGeneration: paused.generation,
      expectedSequence: messages.at(-1).sequence,
      text: 'I reconnected. Try again.',
      sources: [{ kind: 'drive-file', fileId: 'drive-terms' }],
    });
    assert.equal(resumed.status, 'pending');
    assert.deepEqual(
      (await history(changed.id)).at(-1).sources,
      [binding(2)],
      'adding the file again binds the reconnected account',
    );
    assert.equal((await run(changed.id)).status, 'completed', 'the newer binding replaces the stale one');
    assert.deepEqual(prompts.at(-1).files, [{ source: binding(2), filename: 'Freight terms', text: terms }]);

    const disconnected = await start([{ kind: 'drive-file', fileId: 'drive-terms' }], 'Read it while I disconnect.');
    google.afterRead = async () => {
      google.afterRead = null;
      await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET generation=3 WHERE id=$1`, [
        integrationId,
      ]);
    };
    const beforeDisconnect = prompts.length;
    assert.equal(
      (await run(disconnected.id)).status,
      'paused',
      'an integration change after Google returned the file still withholds it',
    );
    assert.match(
      (await history(disconnected.id)).at(-1).text,
      /^A Google Drive file for this task is unavailable because your Google integration changed/,
    );
    assert.equal(prompts.length, beforeDisconnect, 'the text read before the change never reaches the model');
    await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET generation=2 WHERE id=$1`, [integrationId]);

    const missing = await start([{ kind: 'drive-file', fileId: 'drive-gone' }], 'Read the missing file.');
    assert.equal((await run(missing.id)).status, 'paused');
    assert.equal(
      (await history(missing.id)).at(-1).text,
      'A Google Drive file for this task is unavailable: Google reports that it no longer exists or that your Google account cannot open it. Its contents were not read.',
    );

    google.failure = new GoogleFileError('transfer-busy');
    const busy = await start([{ kind: 'drive-file', fileId: 'drive-terms' }], 'Read it while Google is busy.');
    await assert.rejects(
      engine.process(w.id, busy.id),
      /task-google-file-busy/,
      'a busy Google retries the step instead of stopping the task',
    );
    assert.equal((await tasks.read(w.id, user, busy.id)).status, 'pending');
  },
);
