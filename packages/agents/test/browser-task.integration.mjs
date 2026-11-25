import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { browserSessionId } from '@tulipfarm/browser';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime, taskFilesReader } from '../src/task-runtime.ts';
import { createFiles } from '../../files/src/index.ts';
import { createBrowserHandBack, createTaskProgress } from '../src/task-progress.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { savedTaskAgent } from './task-fixture.mjs';

const route = {
  id: 'browser-task',
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
  id: 'browser-task',
  mapping: {
    ...initialModelMapping,
    revision: 'browser-task',
    families: initialModelMapping.families.filter(f => f.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});

/** A browser host that keeps each session's state in memory. */
function fakeHost() {
  const sessions = new Map();
  const calls = [];
  const held = new Map();
  const state = sessionId => sessions.get(sessionId) ?? null;
  const host = {
    unreachable: false,
    sessions,
    calls,
    client: {
      state: async sessionId => {
        if (host.unreachable) throw new Error('host unreachable');
        return state(sessionId);
      },
      open: async (sessionId, options) => {
        calls.push(['open', sessionId, options]);
        const opened = {
          sessionId,
          url: 'about:blank',
          title: '',
          controller: 'agent',
          needsPerson: null,
          controlledBy: null,
          signIn: null,
          logins: [],
        };
        sessions.set(sessionId, opened);
        return opened;
      },
      act: async (sessionId, action) => {
        calls.push(['act', sessionId, action]);
        const s = state(sessionId);
        if (action.action === 'navigate') Object.assign(s, { url: action.url, title: 'Invoices' });
        // A click on the invoice link downloads a fresh copy of it.
        const downloads = [];
        if (action.action === 'click') {
          const download = { id: randomUUID(), name: 'invoice.csv', size: 9 };
          held.set(download.id, Buffer.from('paid,12\n\n'));
          downloads.push(download);
        }
        return {
          state: s,
          snapshot: '- heading "Invoices"',
          truncated: false,
          ...(downloads.length ? { downloads } : {}),
        };
      },
      download: async (_sessionId, id) => {
        const bytes = held.get(id);
        held.delete(id);
        return { name: 'invoice.csv', bytes };
      },
      upload: async (sessionId, input, bytes) => {
        calls.push(['upload', sessionId, { ...input, text: Buffer.from(bytes).toString() }]);
        return { state: state(sessionId), snapshot: '- button "Choose file" [ref=e2]', truncated: false };
      },
      needsPerson: async (sessionId, input) => {
        calls.push(['needsPerson', sessionId, input]);
        Object.assign(state(sessionId), { needsPerson: input.reason });
        return state(sessionId);
      },
      close: async sessionId => {
        calls.push(['close', sessionId]);
        sessions.delete(sessionId);
      },
    },
    handBack(sessionId) {
      Object.assign(state(sessionId), { controller: 'agent', needsPerson: null, controlledBy: null });
    },
  };
  return host;
}

test('an agent run uses one browser, waits for a person, and resumes or fails', { timeout: 240000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
  await db.platform.query(
    await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8'),
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
  const owner = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    owner.membershipId,
    owner.userId,
  ]);
  const login = randomUUID();
  const agent = await savedTaskAgent(db, w, runtime, owner.userId, owner.membershipId, [], ['browser.act'], undefined, {
    browser: { sites: ['billing.example'], logins: [login] },
  });
  await createAgentExecutor({ runtime }).configure(
    w.id,
    { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );

  const offered = [];
  let decisions = [];
  const model = {
    activeBundle: () => ({ bundle, activationRevision: 1 }),
    trustedBundle: () => bundle,
    restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
    allowed: () => true,
    actualModelIds: () => [route.modelId],
    defaultFamily: () => 'claude-opus',
    budgetPicoUsd: () => '10000000000000',
    health: createModelRouteHealth(db.platform, () => 'browser-task'),
    infer: async (_resolution, input) => {
      offered.push(input.browser === true);
      const next = decisions.shift();
      return {
        kind: 'success',
        decision: (typeof next === 'function' ? await next() : next) ?? { kind: 'answer', text: 'Done.' },
        actualModel: route.modelId,
        requestId: randomUUID(),
        usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      };
    },
  };
  const host = fakeHost();
  const loaded = [];
  const browser = {
    client: host.client,
    loadLogin: async input => {
      loaded.push(input);
    },
  };
  const tasks = createAgentTasks(runtime);
  const progress = createTaskProgress(runtime);
  const handBack = createBrowserHandBack(runtime);
  const objects = new Map();
  const files = createFiles(runtime, {
    putIfAbsent: async (key, body) => void objects.set(key, Buffer.from(body)),
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
  });
  const reader = taskFilesReader(files);
  const engine = createTaskRuntime(
    runtime,
    model,
    ...Array(5).fill(undefined),
    reader,
    ...Array(5).fill(undefined),
    browser,
  );
  const start = (sources = []) =>
    tasks.start(w.id, owner.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope: [],
      sources,
      text: 'Download the latest invoice.',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 120000 },
    });
  const settle = async taskId => {
    for (let n = 0; n < 8 && (await tasks.read(w.id, owner.userId, taskId)).status === 'pending'; n++)
      await engine.process(w.id, taskId);
    return (await tasks.read(w.id, owner.userId, taskId)).status;
  };
  const toolCall = async (taskId, tool) =>
    (
      await db.platform.query(
        `SELECT c.id,c.status,c.result FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} b ON b.run_id=c.run_id
         WHERE b.task_id=$1 AND c.call->>'tool'=$2 ORDER BY b.generation DESC, c.sequence DESC LIMIT 1`,
        [taskId, tool],
      )
    ).rows[0];
  const handoff = {
    kind: 'tool',
    text: 'The site wants a captcha solved.',
    call: { tool: 'browser.handoff', reason: 'Solve the captcha' },
  };

  await t.test('the run opens its own limited session, waits for a person and resumes on hand back', async () => {
    decisions = [
      {
        kind: 'tool',
        text: 'Opening the billing site.',
        call: { tool: 'browser.act', action: { action: 'navigate', url: 'https://billing.example/invoices' } },
      },
      handoff,
      { kind: 'answer', text: 'Downloaded.' },
    ];
    const task = await start();
    const sessionId = browserSessionId(w.id, { runId: task.id });
    assert.equal(await settle(task.id), 'waiting-approval');
    assert.deepEqual(host.calls[0], ['open', sessionId, { allowedSites: ['billing.example'], workspaceId: w.id }]);
    assert.deepEqual(
      loaded.map(l => [l.sessionId, l.loginId, l.actor.userId]),
      [[sessionId, login, owner.userId]],
      "the preselected login loads as the run's owner",
    );
    assert.equal(host.calls.filter(c => c[0] === 'open').length, 1, 'the run reuses its one session');
    const waiting = await toolCall(task.id, 'browser.handoff');
    assert.equal(waiting.status, 'waiting');
    const deadline = Date.parse(waiting.result.waitingUntil) - Date.now();
    assert.ok(deadline > 23.9 * 3600000 && deadline <= 24 * 3600000, 'the run waits up to 24 hours');
    assert.deepEqual(await progress(w.id, task.id), { kind: 'waiting' });
    assert.equal((await tasks.read(w.id, owner.userId, task.id)).waitingOn, 'browser', 'it waits on the browser');
    assert.equal(
      (await tasks.list(w.id, owner.userId, {})).tasks.find(listed => listed.id === task.id)?.waitingOn,
      'browser',
    );

    await engine.process(w.id, task.id);
    assert.equal((await toolCall(task.id, 'browser.handoff')).status, 'waiting', 'it keeps waiting for a person');

    host.handBack(sessionId);
    await engine.process(w.id, task.id);
    const resumed = await toolCall(task.id, 'browser.handoff');
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.result.browser.status, 'handed-back');
    assert.equal(await settle(task.id), 'completed');
    assert.equal((await tasks.read(w.id, owner.userId, task.id)).waitingOn, null);
    assert.ok(offered.every(Boolean), 'the model was offered the browser');
  });

  await t.test('a run nobody hands back within 24 hours fails, needing a person, and closes its browser', async () => {
    decisions = [handoff];
    const task = await start();
    const sessionId = browserSessionId(w.id, { runId: task.id });
    assert.equal(await settle(task.id), 'waiting-approval');
    const waiting = await toolCall(task.id, 'browser.handoff');
    await db.platform.query(
      `UPDATE ${table('tf_agent_tool_calls')} SET result=jsonb_set(result,'{waitingUntil}',$2) WHERE id=$1`,
      [waiting.id, JSON.stringify(new Date(Date.now() - 1000).toISOString())],
    );
    assert.deepEqual(await progress(w.id, task.id), { kind: 'runnable' }, 'the deadline wakes the run');
    await engine.process(w.id, task.id);
    const read = await tasks.read(w.id, owner.userId, task.id);
    assert.equal(read.status, 'failed');
    const [message] = (
      await db.platform.query(
        `SELECT text FROM ${table('tf_agent_task_messages')} WHERE task_id=$1 AND role='agent' ORDER BY sequence DESC LIMIT 1`,
        [task.id],
      )
    ).rows;
    assert.equal(
      message.text,
      'No one handed the browser back within 24 hours, so the run stopped and its browser closed.',
    );
    assert.equal(host.sessions.has(sessionId), false);
    assert.deepEqual(await progress(w.id, task.id), { kind: 'terminal' });
  });

  const expire = async (taskId, at = Date.now() - 1000) => {
    const waiting = await toolCall(taskId, 'browser.handoff');
    await db.platform.query(
      `UPDATE ${table('tf_agent_tool_calls')} SET result=jsonb_set(result,'{waitingUntil}',$2) WHERE id=$1`,
      [waiting.id, JSON.stringify(new Date(at).toISOString())],
    );
  };

  await t.test('the deadline stops the run even while the browser host is unreachable', async t => {
    t.after(() => (host.unreachable = false));
    decisions = [handoff];
    const task = await start();
    assert.equal(await settle(task.id), 'waiting-approval');
    await expire(task.id);
    host.unreachable = true;
    await engine.process(w.id, task.id);
    assert.equal((await tasks.read(w.id, owner.userId, task.id)).status, 'failed');
  });

  await t.test('a hand back after the deadline is not recorded and does not resume the run', async () => {
    decisions = [handoff];
    const task = await start();
    const sessionId = browserSessionId(w.id, { runId: task.id });
    assert.equal(await settle(task.id), 'waiting-approval');
    await expire(task.id);
    host.handBack(sessionId);
    assert.equal(await handBack(w.id, task.id), false, 'a late hand back is not recorded');
    await engine.process(w.id, task.id);
    assert.equal((await tasks.read(w.id, owner.userId, task.id)).status, 'failed');
    assert.equal(host.sessions.has(sessionId), false);
  });

  await t.test('a recorded hand back resumes the run without its wake, the host, or the time left', async t => {
    t.after(() => (host.unreachable = false));
    decisions = [handoff, { kind: 'answer', text: 'Done.' }];
    const task = await start();
    const sessionId = browserSessionId(w.id, { runId: task.id });
    assert.equal(await settle(task.id), 'waiting-approval');
    host.handBack(sessionId);
    assert.equal(await handBack(w.id, task.id, new Date(Date.now() - 2000)), true);
    assert.equal(await handBack(w.id, task.id), false, 'a hand back is recorded once');
    assert.deepEqual(await progress(w.id, task.id), { kind: 'runnable' }, 'recovery resumes a lost wake');
    // The run picks the hand back up only after its deadline, with the host down: it still counts.
    await expire(task.id);
    host.unreachable = true;
    await engine.process(w.id, task.id);
    const resumed = await toolCall(task.id, 'browser.handoff');
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.result.browser.status, 'handed-back');
    host.unreachable = false;
    assert.equal(await settle(task.id), 'completed');
  });

  await t.test(
    'a run saves downloads to the folder it names and uploads only files attached to it or saved by it',
    async t => {
      t.after(() => delete browser.files);
      browser.files = files;
      const folder = await files.createFolder(w.id, owner.userId, randomUUID(), { name: 'Invoices', parentId: null });
      const upload = (name, mediaType, text) =>
        files.upload(w.id, owner.userId, randomUUID(), { name, parentId: null, mediaType }, Buffer.from(text));
      const attached = await upload('Form.csv', 'text/csv', 'name,Ada\n');
      const unrelated = await upload('Salary.csv', 'text/csv', 'secret,1\n');
      const click = folderId => ({
        kind: 'tool',
        text: 'Downloading the invoice.',
        call: { tool: 'browser.act', action: { action: 'click', ref: 'e4' }, ...(folderId ? { folderId } : {}) },
      });
      const send = file => ({ kind: 'tool', text: 'Uploading.', call: { tool: 'browser.upload', file, ref: 'e2' } });
      let saved;
      decisions = [
        click(folder.id),
        async () => {
          saved = (await toolCall(task.id, 'browser.act')).result.browser.files[0];
          return send(saved.id);
        },
        click(),
        send(unrelated.id),
        send(attached.id),
        { kind: 'answer', text: 'Uploaded.' },
      ];
      const uploadsBefore = host.calls.filter(c => c[0] === 'upload').length;
      const task = await start([{ kind: 'file', fileId: attached.id }]);
      for (let n = 0; n < 12 && (await tasks.read(w.id, owner.userId, task.id)).status === 'pending'; n++) {
        await engine.process(w.id, task.id);
      }
      assert.equal((await tasks.read(w.id, owner.userId, task.id)).status, 'completed');
      const [downloaded, uploadedSaved, notSaved, refused, uploadedAttached] = (
        await db.platform.query(
          `SELECT c.result FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} b ON b.run_id=c.run_id
         WHERE b.task_id=$1 AND c.call->>'tool' LIKE 'browser.%' ORDER BY b.generation, c.sequence`,
          [task.id],
        )
      ).rows.map(row => row.result.browser);

      assert.equal(downloaded.files.length, 1, 'a download goes to the folder the run named');
      const [row] = (
        await db.platform.query(`SELECT name,parent_id AS "parentId" FROM ${table('tf_files')} WHERE id=$1`, [saved.id])
      ).rows;
      assert.deepEqual(row, { name: 'invoice.csv', parentId: folder.id });
      assert.equal(
        Buffer.from((await files.download(w.id, owner.userId, saved.id)).bytes).toString(),
        'paid,12\n\n',
        "the download is the run's owner's file",
      );

      assert.equal(uploadedSaved.uploaded, 'invoice.csv', 'the run uploads a file it saved');
      assert.equal(notSaved.files, undefined);
      assert.deepEqual(
        notSaved.downloadsNotSaved.map(entry => entry.error),
        ['destination-required'],
        'without a folder nothing is saved',
      );
      assert.equal(refused.error, 'file-not-allowed', 'a readable file unrelated to the run is refused');
      assert.match(refused.instruction, /^Runs upload only the files attached to the run or saved by it\./);
      assert.equal(uploadedAttached.uploaded, 'Form.csv', 'the run uploads a file attached to it');
      assert.deepEqual(
        host.calls
          .filter(c => c[0] === 'upload')
          .slice(uploadsBefore)
          .map(c => [c[2].name, c[2].text]),
        [
          ['invoice.csv', 'paid,12\n\n'],
          ['Form.csv', 'name,Ada\n'],
        ],
        'the unrelated file never reaches the browser',
      );
    },
  );

  await t.test(
    'a run that can upload keeps an attached file it cannot read; one that cannot upload pauses',
    async t => {
      t.after(() => delete browser.files);
      browser.files = files;
      const clip = await files.upload(
        w.id,
        owner.userId,
        randomUUID(),
        { name: 'clip.mp4', parentId: null, mediaType: 'video/mp4' },
        Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]),
      );
      const sources = [{ kind: 'file', fileId: clip.id }];
      decisions = [
        {
          kind: 'tool',
          text: 'Opening the form.',
          call: { tool: 'browser.act', action: { action: 'navigate', url: 'https://forms.example/upload' } },
        },
        { kind: 'tool', text: 'Uploading.', call: { tool: 'browser.upload', file: clip.id, ref: 'e2' } },
        { kind: 'answer', text: 'Uploaded.' },
      ];
      const uploadsBefore = host.calls.filter(c => c[0] === 'upload').length;
      const task = await start(sources);
      assert.equal(await settle(task.id), 'completed');
      assert.equal((await toolCall(task.id, 'browser.upload')).result.browser.uploaded, 'clip.mp4');
      assert.deepEqual(
        host.calls
          .filter(c => c[0] === 'upload')
          .slice(uploadsBefore)
          .map(c => c[2].name),
        ['clip.mp4'],
      );

      delete browser.files;
      decisions = [{ kind: 'answer', text: 'No uploads.' }];
      const unread = await start(sources);
      assert.equal(await settle(unread.id), 'paused', 'a run that cannot upload stops on a file it cannot read');

      browser.files = files;
      const referencing = await start([{ kind: 'task', taskId: unread.id, throughSequence: 0 }]);
      assert.equal(
        await settle(referencing.id),
        'paused',
        'a file another task references is not attached to this run, so it still stops the step',
      );
    },
  );
});
