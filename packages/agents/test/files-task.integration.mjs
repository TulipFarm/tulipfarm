import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { AccessDenied } from '@tulipfarm/access';
import { createFiles } from '../../files/dist/index.js';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime, taskFilesReader } from '../src/task-runtime.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';

const terms = 'Suppliers are paid within 30 days of delivery.';

test(
  'a task reads its owner’s Files input under current access, records the read, and refuses runs that are not the owner’s task run',
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
      member = randomUUID(),
      outsider = randomUUID(),
      outsiderMember = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
      [member, user, outsiderMember, outsider],
    );
    const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['rows.list']);
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
    const upload = async (owner, name, mediaType, content) =>
      (await files.upload(w.id, owner, randomUUID(), { name, parentId: null, mediaType }, Buffer.from(content))).id;

    const route = {
      id: 'files-task',
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
      id: 'files-task',
      mapping: {
        ...initialModelMapping,
        revision: 'files-task',
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
      health: createModelRouteHealth(db.platform, () => 'files-task'),
      infer: async (_resolution, input) => {
        prompts.push(JSON.parse(input.prompt));
        return {
          kind: 'success',
          decision: { kind: 'answer', text: 'Within 30 days.' },
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
      taskFilesReader(files),
    );
    const start = (sources, text = 'When are suppliers paid?') =>
      tasks.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope: [],
        text,
        sources,
        limits: { toolCalls: 10, credits: 100, activeMilliseconds: 120000 },
      });
    const run = async id => {
      for (let n = 0; n < 8 && ['pending', 'waiting-approval'].includes((await tasks.read(w.id, user, id)).status); n++)
        await engine.process(w.id, id);
      return tasks.read(w.id, user, id);
    };

    const fileId = await upload(user, 'Supplier terms.md', 'text/markdown', terms);
    const task = await start([{ kind: 'file', fileId }]);
    assert.equal((await run(task.id)).status, 'completed');
    assert.deepEqual(prompts[0].files, [
      { source: { kind: 'file', fileId }, filename: 'Supplier terms.md', text: terms },
    ]);
    const history = (await tasks.history(w.id, user, task.id)).messages;
    assert.deepEqual(
      history[0].sources,
      [{ kind: 'file', fileId }],
      'the owner’s request names the file without content',
    );
    const receipt = history.at(-1).sources.find(source => source.kind === 'file' && source.read);
    assert.deepEqual(
      { ...receipt, read: { ...receipt.read, readAt: 'checked' } },
      {
        kind: 'file',
        fileId,
        read: { readAt: 'checked', sha256: createHash('sha256').update(terms).digest('hex'), representation: 'text' },
      },
    );
    assert.ok(!Number.isNaN(Date.parse(receipt.read.readAt)));

    const chatId = randomUUID(),
      chatMessage = randomUUID(),
      googleId = randomUUID(),
      read = { readAt: new Date().toISOString(), sha256: 'f'.repeat(64), representation: 'text' };
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id,title) VALUES ($1,$2,$3,'Supplier chat')`,
      [chatId, user, member],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) VALUES ($1,$2,1,'human',$3)`,
      [chatMessage, chatId, member],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_google_integrations')} (id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES ($1,$2,$3,1,'connected','account','member@example.test',ARRAY['https://www.googleapis.com/auth/drive'],'{}')`,
      [googleId, user, member],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_conversation_parts')} (conversation_id,message_id,ordinal,kind,file_id) VALUES ($1,$2,0,'file',$3)`,
      [chatId, chatMessage, fileId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_conversation_parts')} (conversation_id,message_id,ordinal,kind,google_file) VALUES ($1,$2,1,'google-file',$3)`,
      [
        chatId,
        chatMessage,
        {
          fileId: 'drive-terms',
          integrationId: googleId,
          accountId: 'account',
          generation: 1,
          name: 'Terms',
          mimeType: 'text/plain',
        },
      ],
    );
    const forgeries = {
      'a Files read receipt': { kind: 'file', fileId, read },
      'a chat Files read receipt': {
        kind: 'tulipfarm-file',
        fileId,
        conversationId: chatId,
        membershipId: member,
        read,
      },
      'a chat Google Drive read receipt': {
        kind: 'google-file',
        fileId: 'drive-terms',
        conversationId: chatId,
        membershipId: member,
        integrationId: googleId,
        accountId: 'account',
        generation: 1,
        read: { ...read, representation: 'export', version: '7' },
      },
    };
    const stored = async () =>
      (
        await db.platform.query(
          `SELECT (SELECT count(*) FROM ${table('tf_agent_tasks')})::int AS tasks, (SELECT count(*) FROM ${table('tf_agent_task_messages')})::int AS messages, (SELECT count(*) FROM ${table('tf_agent_task_commands')})::int AS commands`,
        )
      ).rows[0];
    const beforeForgery = await stored(),
      completed = await tasks.read(w.id, user, task.id);
    for (const [label, source] of Object.entries(forgeries)) {
      await assert.rejects(start([source]), { name: 'ZodError' }, `a person cannot start a task with ${label}`);
      await assert.rejects(
        tasks.reopen(w.id, user, task.id, {
          requestId: randomUUID(),
          expectedGeneration: completed.generation,
          text: 'Again',
          sources: [source],
        }),
        { name: 'ZodError' },
        `a person cannot reopen a task with ${label}`,
      );
      await assert.rejects(
        tasks.continueTask(w.id, user, task.id, {
          requestId: randomUUID(),
          expectedGeneration: completed.generation,
          expectedSequence: history.at(-1).sequence,
          text: 'More',
          sources: [source],
        }),
        { name: 'ZodError' },
        `a person cannot continue a task with ${label}`,
      );
    }
    assert.deepEqual(await stored(), beforeForgery, 'a refused receipt leaves no task, message, or command behind');
    assert.equal((await tasks.read(w.id, user, task.id)).generation, completed.generation);

    const taskRun = (
      await db.platform.query(
        `SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1 ORDER BY generation DESC LIMIT 1`,
        [task.id],
      )
    ).rows[0].run_id;
    await tasks.checkSources(w.id, user, [{ kind: 'file', fileId }], taskRun);
    await assert.rejects(
      tasks.checkSources(w.id, user, [{ kind: 'file', fileId }], randomUUID()),
      AccessDenied,
      'a run that is not the owner’s delegated task run cannot read the file',
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
      tasks.checkSources(w.id, user, [{ kind: 'file', fileId }], scheduledRun),
      AccessDenied,
      'a scheduled run, which no person started, is refused',
    );

    await assert.rejects(
      tasks.start(w.id, outsider, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope: [],
        text: 'Read it',
        sources: [{ kind: 'file', fileId }],
      }),
      AccessDenied,
      'a person who cannot read the file cannot give it to a task',
    );

    const sharedId = await upload(w.userId, 'Rates.txt', 'text/plain', 'Rate card: 12 per crate.');
    await files.share(w.id, w.userId, sharedId, { kind: 'individual', id: member }, 'viewer');
    const revoked = await start([{ kind: 'file', fileId: sharedId }], 'What is the rate?');
    await files.share(w.id, w.userId, sharedId, { kind: 'individual', id: member }, null);
    const before = prompts.length;
    assert.equal(
      (await run(revoked.id)).status,
      'failed',
      'access lost after the task started stops it before the read',
    );
    assert.equal(prompts.length, before);

    const archiveId = await upload(
      user,
      'Photos.zip',
      'application/zip',
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
    );
    const unsupported = await start([{ kind: 'file', fileId: archiveId }], 'Describe the photos.');
    const paused = await run(unsupported.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'file');
    assert.equal(
      (await tasks.history(w.id, user, unsupported.id)).messages.at(-1).text,
      'An attached file exceeds the supported text format or size, or file storage is not configured.',
    );
    assert.equal(prompts.length, before, 'an unreadable file never reaches the model');
  },
);
