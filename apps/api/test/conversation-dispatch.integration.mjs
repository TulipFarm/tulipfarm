import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { conversationFixture, reverseReply } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createReplyDispatch, registerConversationDispatch } from '../src/conversation-dispatch.ts';
import { registerConversations } from '../src/conversations.ts';
import { approvalFixture } from '../../../packages/conversations/test/approval-fixture.mjs';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { createRequire } from 'node:module';

const telemetryRequire = createRequire(import.meta.resolve('@tulipfarm/observability'));
const { context, metrics, trace } = telemetryRequire('@opentelemetry/api');
const { MeterProvider, MetricReader } = telemetryRequire('@opentelemetry/sdk-metrics');
const { BasicTracerProvider } = telemetryRequire('@opentelemetry/sdk-trace-base');
const { AsyncLocalStorageContextManager } = createRequire(telemetryRequire.resolve('@opentelemetry/sdk-node'))(
  '@opentelemetry/context-async-hooks',
);

class TestReader extends MetricReader {
  async onShutdown() {}
  async onForceFlush() {}
}
const metricReader = new TestReader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [metricReader] }));
trace.setGlobalTracerProvider(new BasicTracerProvider());
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const registerWithReplies = (app, dependencies) =>
  registerConversationDispatch(app, { ...dependencies, replies: createReplyDispatch(dependencies) });

test(
  'restricted API identity discovers persisted conversations and dispatches only control IDs',
  { timeout: 15000 },
  async () => {
    const f = await conversationFixture();
    const role = `conversation_api_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    const url = new URL(f.db.connectionString);
    url.username = role;
    url.password = password;
    const pool = new Pool({ connectionString: url.href });
    const app = Fastify({ logger: false });
    let roleCreated = false;
    try {
      const { workspace: w, store } = f;
      await f.db.platform.query(
        "INSERT INTO app.workspace_storage (workspace_id, stage, runtime_credential, migration_credential, confirmation_credential) VALUES ($1, 'ready', '{}', '{}', '{}') ON CONFLICT (workspace_id) DO UPDATE SET stage='ready', runtime_credential='{}', migration_credential='{}', confirmation_credential='{}'",
        [w.id],
      );
      await f.db.admin.query(
        `CREATE ROLE ${escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`,
      );
      roleCreated = true;
      const database = (await f.db.platform.query('SELECT current_database() AS name')).rows[0].name;
      await f.db.platform.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(role)};
      GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(role)};
      GRANT SELECT (workspace_id, generation, stage, runtime_credential, error_code, updated_at), INSERT (workspace_id) ON app.workspace_storage TO ${escapeIdentifier(role)}`);
      await assert.rejects(
        pool.query('SELECT disabled_at FROM app.workspace_storage'),
        error => error.code === '42501',
      );
      assert.deepEqual(
        (await pool.query("SELECT workspace_id FROM app.workspace_storage WHERE stage = 'ready'")).rows,
        [{ workspace_id: w.id }],
      );
      const id = randomUUID();
      await store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
      const sent = await store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'API discovery' }],
      });
      const calls = [];
      const executor = createConversationExecutor(f.runtime, reverseReply);
      registerWithReplies(app, {
        pool,
        runtime: f.runtime,
        temporal: {
          connection: { withDeadline: (_deadline, operation) => operation() },
          client: {
            workflow: {
              start: async (name, options) => {
                calls.push({ name, options });
                await executor.process(options.args[0]);
              },
            },
          },
        },
      });
      await app.ready();
      let history;
      for (let attempt = 0; attempt < 100; attempt++) {
        history = await store.history(w.id, w.userId, id);
        if (history.messages.length === 2) break;
        await delay(20);
      }
      assert.deepEqual(
        history.messages.map(message => message.parts.map(part => part.text).join('')),
        ['API discovery', 'yrevocsid IPA'],
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        name: 'conversationReply',
        options: {
          workflowId: `conversation-reply-v1-${w.id}-${sent.turnId}-0`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [{ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        },
      });
    } finally {
      await app.close();
      await pool.end();
      if (roleCreated) {
        await f.db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
        await f.db.admin.query(`DROP ROLE ${escapeIdentifier(role)}`);
      }
      await f.close();
    }
  },
);

test(
  'periodic discovery expires human waits and cleans unbound bytes without browser reads',
  { timeout: 30000 },
  async () => {
    const f = await approvalFixture();
    const app = Fastify({ logger: false });
    try {
      const { workspace: w, table, db } = f;
      await db.platform.query(
        "UPDATE app.workspace_storage SET stage = 'ready', runtime_credential = '{}', migration_credential = '{}', confirmation_credential = '{}' WHERE workspace_id = $1",
        [w.id],
      );
      const fence = await f.start();
      const information = await createConversationRequests(f.runtime).create(fence, {
        producerId: randomUUID(),
        prompt: 'Expire without a browser',
        answerSchema: { kind: 'text' },
      });
      const approval = await f.pending();
      const objects = new Map();
      const attachments = createAttachments(f.runtime, {
        putIfAbsent: async (key, bytes) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
        },
        read: async key => objects.get(key),
        remove: async key => {
          objects.delete(key);
        },
      });
      const chatId = fence.origin.conversationId;
      const uploadId = randomUUID(),
        bytes = Buffer.from('abandoned private bytes');
      await attachments.reserve(w.id, w.userId, chatId, uploadId, {
        filename: 'pending.txt',
        mediaType: 'text/plain',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      await attachments.upload(w.id, w.userId, chatId, uploadId, bytes);
      let initialSweep = false;
      const calls = [];
      registerWithReplies(app, {
        pool: db.platform,
        runtime: f.runtime,
        attachments,
        expireApprovals: async workspaceId => {
          for (const id of await f.requests.due(workspaceId)) await f.resolver.expire(workspaceId, id);
          initialSweep = true;
        },
        temporal: {
          connection: { withDeadline: (_deadline, operation) => operation() },
          client: {
            workflow: {
              start: async (_name, options) => {
                calls.push(options.args[0]);
              },
            },
          },
        },
      });
      await app.ready();
      for (let attempt = 0; !initialSweep && attempt < 100; attempt++) await delay(20);
      assert.equal(initialSweep, true);
      assert.equal(objects.size, 1);
      await db.platform.query(
        `UPDATE ${table('tf_conversation_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [information.requestId],
      );
      await db.platform.query(
        `UPDATE ${table('tf_conversation_approval_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [approval.requestId],
      );
      await db.platform.query(
        `UPDATE ${table('tf_conversation_attachments')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [uploadId],
      );
      for (let attempt = 0; (objects.size !== 0 || calls.length < 2) && attempt < 300; attempt++) await delay(20);
      assert.equal(objects.size, 0);
      assert.deepEqual(
        (
          await db.platform.query(`SELECT status FROM ${table('tf_conversation_requests')} WHERE id=$1`, [
            information.requestId,
          ])
        ).rows,
        [{ status: 'expired' }],
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT resolution,confirmation_id FROM ${table('tf_conversation_approval_resolutions')} WHERE request_id=$1`,
            [approval.requestId],
          )
        ).rows,
        [{ resolution: 'expired', confirmation_id: null }],
      );
      assert.deepEqual(
        (await db.platform.query(`SELECT state FROM ${table('tf_conversation_attachments')} WHERE id=$1`, [uploadId]))
          .rows,
        [{ state: 'abandoned' }],
      );
      assert.deepEqual(
        calls.map(work => work.turnId).sort(),
        [fence.origin.turnId, approval.fence.origin.turnId].sort(),
      );
      assert.deepEqual(
        calls.map(work => work.generation),
        [1, 1],
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT count(*)::int AS count FROM ${table('tf_confirmations')} WHERE migration_id=$1`,
            [approval.migrationId],
          )
        ).rows,
        [{ count: 0 }],
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);

function fakeTemporal(start) {
  return {
    connection: { withDeadline: (_deadline, operation) => operation() },
    client: { workflow: { start: (_name, options) => start(options) } },
  };
}

async function sendRoute(f, replies) {
  const app = Fastify({ logger: false });
  registerConversations(app, {
    auth: { api: { getSession: async () => ({ user: { id: f.workspace.userId } }) } },
    service: f.store,
    replies,
  });
  await app.ready();
  return {
    app,
    send: async (chatId, text) => {
      const response = await app.inject({
        method: 'PUT',
        url: `/workspaces/${f.workspace.id}/conversations/${chatId}/messages/${randomUUID()}`,
        payload: { commandId: randomUUID(), parts: [{ kind: 'text', text }] },
        headers: { origin: 'http://localhost:5173' },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    },
  };
}

async function newChat(f) {
  const chatId = randomUUID();
  await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
  return chatId;
}

const replyTexts = async (f, chatId) =>
  (await f.store.history(f.workspace.id, f.workspace.userId, chatId)).messages
    .filter(message => message.author === 'assistant')
    .map(message => message.parts.map(part => part.text).join(''));

const outbox = async (f, turnId) =>
  (
    await f.db.platform.query(
      `SELECT dispatched_at IS NOT NULL AS dispatched FROM ${f.table('tf_conversation_outbox')} WHERE turn_id=$1`,
      [turnId],
    )
  ).rows;

test(
  'a send starts its reply before any sweep, with the same workflow id the sweep uses',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    const starts = [];
    const replies = createReplyDispatch({
      runtime: f.runtime,
      temporal: fakeTemporal(async options => {
        starts.push(options);
      }),
    });
    const route = await sendRoute(f, replies);
    try {
      const chatId = await newChat(f);
      const sent = await route.send(chatId, 'hey');
      await replies.settle();
      assert.deepEqual(starts, [
        {
          workflowId: `conversation-reply-v1-${f.workspace.id}-${sent.turnId}-0`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [{ workspaceId: f.workspace.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        },
      ]);
      assert.deepEqual(await outbox(f, sent.turnId), [{ dispatched: true }]);
      await replies.dispatch(f.workspace.id);
      assert.equal(starts.length, 1, 'an acknowledged send leaves nothing for the sweep');
    } finally {
      await route.app.close();
      await f.close();
    }
  },
);

test('a racing send and sweep start one workflow and write one reply', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  const executor = createConversationExecutor(f.runtime, reverseReply);
  const starts = [];
  const runs = [];
  let sweeping;
  const replies = createReplyDispatch({
    runtime: f.runtime,
    // The sweep runs while the send's start is still in flight, the window the prod race hit.
    temporal: fakeTemporal(async options => {
      starts.push(options.workflowId);
      if (starts.length === 1) await (sweeping = replies.dispatch(f.workspace.id));
      runs.push(await executor.process(options.args[0]));
    }),
  });
  const route = await sendRoute(f, replies);
  try {
    const chatId = await newChat(f);
    const sent = await route.send(chatId, 'race');
    await replies.settle();
    await sweeping;
    assert.deepEqual(starts, [`conversation-reply-v1-${f.workspace.id}-${sent.turnId}-0`]);
    assert.deepEqual(runs, ['completed']);
    assert.deepEqual(await replyTexts(f, chatId), ['ecar']);
  } finally {
    await route.app.close();
    await f.close();
  }
});

test('concurrent sends and sweeps lease each turn to one start', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  const starts = [];
  const replies = createReplyDispatch({
    runtime: f.runtime,
    temporal: fakeTemporal(async options => {
      starts.push(options.workflowId);
      await delay(50);
    }),
  });
  const quiet = await sendRoute(f, undefined);
  try {
    const chats = await Promise.all([newChat(f), newChat(f), newChat(f)]);
    for (const chatId of chats) await quiet.send(chatId, 'many');
    await Promise.all([
      replies.dispatch(f.workspace.id),
      replies.dispatch(f.workspace.id),
      ...chats.map(conversationId => replies.dispatch(f.workspace.id, { conversationId, source: 'send' })),
    ]);
    assert.equal(starts.length, 3);
    assert.equal(new Set(starts).size, 3);
  } finally {
    await quiet.app.close();
    await f.close();
  }
});

test('the sweep restarts a started reply only once its claim grace lapses', { timeout: 60000 }, async () => {
  const before = await dispatchCounts();
  const f = await conversationFixture();
  const executor = createConversationExecutor(f.runtime, reverseReply);
  const starts = [];
  const replies = createReplyDispatch({
    runtime: f.runtime,
    graceMs: 400,
    temporal: fakeTemporal(async options => {
      starts.push(options.workflowId);
    }),
  });
  const route = await sendRoute(f, replies);
  try {
    const chatId = await newChat(f);
    const sent = await route.send(chatId, 'lost');
    await replies.settle();
    await replies.dispatch(f.workspace.id);
    assert.equal(starts.length, 1, 'a sweep inside the grace leaves the send alone');
    await delay(500);
    await replies.dispatch(f.workspace.id);
    assert.equal(starts.length, 2, 'an unclaimed reply is started again after the grace');
    assert.equal(new Set(starts).size, 1, 'with the same workflow id');
    await delay(500);
    assert.equal(
      await executor.process({
        workspaceId: f.workspace.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      }),
      'completed',
    );
    await replies.dispatch(f.workspace.id);
    assert.equal(starts.length, 2, 'a claimed reply is never due again');
    const after = await dispatchCounts();
    const delta = key => (after[key] ?? 0) - (before[key] ?? 0);
    assert.equal(delta('send/undispatched/success'), 1);
    assert.equal(delta('sweep/unclaimed/success'), 1);
    assert.equal(delta('sweep/undispatched/success'), 0);
  } finally {
    await route.app.close();
    await f.close();
  }
});

test('a lease left by a crashed dispatcher lapses to the sweep', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  const executor = createConversationExecutor(f.runtime, reverseReply);
  const starts = [];
  const replies = createReplyDispatch({
    runtime: f.runtime,
    graceMs: 400,
    temporal: fakeTemporal(async options => {
      starts.push(options.args[0]);
    }),
  });
  const quiet = await sendRoute(f, undefined);
  try {
    const chatId = await newChat(f);
    const sent = await quiet.send(chatId, 'crash');
    // A dispatcher that leased the turn and then died before starting or releasing it.
    assert.equal((await executor.lease(f.workspace.id, chatId, 400)).length, 1);
    await replies.dispatch(f.workspace.id);
    assert.deepEqual(starts, []);
    await delay(500);
    await replies.dispatch(f.workspace.id);
    assert.deepEqual(
      starts.map(work => work.turnId),
      [sent.turnId],
    );
  } finally {
    await quiet.app.close();
    await f.close();
  }
});

test('a failed start still saves the send, logs a code, and the sweep recovers it', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  const executor = createConversationExecutor(f.runtime, reverseReply);
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...rest) => {
    lines.push(String(chunk));
    return write(chunk, ...rest);
  });
  let attempts = 0;
  const replies = createReplyDispatch({
    runtime: f.runtime,
    temporal: fakeTemporal(async options => {
      if (++attempts === 1)
        throw new Error('Failed to start Workflow', {
          cause: Object.assign(new Error('4 DEADLINE_EXCEEDED: private detail'), {
            code: 4,
            details: 'private detail',
            metadata: {},
          }),
        });
      await executor.process(options.args[0]);
    }),
  });
  const route = await sendRoute(f, replies);
  try {
    const chatId = await newChat(f);
    const sent = await route.send(chatId, 'offline');
    await replies.settle();
    assert.equal(attempts, 1);
    assert.deepEqual(await outbox(f, sent.turnId), [{ dispatched: false }]);
    const failure = lines
      .flatMap(line => line.split('\n'))
      .filter(line => line.includes('"dispatch_failed"'))
      .map(line => JSON.parse(line));
    assert.equal(failure.length, 1);
    assert.equal(failure[0].level, 'warn');
    assert.equal(failure[0].dispatch_source, 'send');
    assert.equal(failure[0]['error.code'], 'timeout');
    assert.doesNotMatch(JSON.stringify(failure), /private detail/);
    assert.deepEqual(await replyTexts(f, chatId), []);
    await replies.dispatch(f.workspace.id);
    assert.equal(attempts, 2);
    assert.deepEqual(await replyTexts(f, chatId), ['enilffo']);
  } finally {
    await route.app.close();
    await f.close();
  }
});

test('a send during an active reply queues behind it on both paths, as before', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  const executor = createConversationExecutor(f.runtime, reverseReply);
  const starts = [];
  const replies = createReplyDispatch({
    runtime: f.runtime,
    temporal: fakeTemporal(async options => {
      starts.push(options.args[0]);
    }),
  });
  const route = await sendRoute(f, replies);
  try {
    const chatId = await newChat(f);
    const first = await route.send(chatId, 'first');
    await replies.settle();
    assert.ok(await executor.claim(starts[0]), 'the first reply is now active');
    const second = await route.send(chatId, 'second');
    await replies.settle();
    await replies.dispatch(f.workspace.id);
    assert.deepEqual(
      starts.map(work => work.turnId),
      [first.turnId],
    );
    assert.deepEqual(
      (await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [second.turnId]))
        .rows,
      [{ status: 'queued' }],
    );
  } finally {
    await route.app.close();
    await f.close();
  }
});

test('a send dispatches only its own chat and leaves other due chats to the sweep', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  const starts = [];
  const replies = createReplyDispatch({
    runtime: f.runtime,
    temporal: fakeTemporal(async options => {
      starts.push(options.args[0]);
    }),
  });
  const quiet = await sendRoute(f, undefined);
  const route = await sendRoute(f, replies);
  try {
    const other = await newChat(f);
    const missed = await quiet.send(other, 'missed');
    const chatId = await newChat(f);
    const sent = await route.send(chatId, 'mine');
    await replies.settle();
    assert.deepEqual(
      starts.map(work => work.turnId),
      [sent.turnId],
    );
    assert.deepEqual(await outbox(f, missed.turnId), [{ dispatched: false }]);
    await replies.dispatch(f.workspace.id);
    assert.deepEqual(
      starts.map(work => work.turnId),
      [sent.turnId, missed.turnId],
    );
  } finally {
    await quiet.app.close();
    await route.app.close();
    await f.close();
  }
});

test('a send starts its reply inside the request trace; the sweep does not', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  const active = [];
  const replies = createReplyDispatch({
    runtime: f.runtime,
    temporal: fakeTemporal(async () => {
      active.push(trace.getActiveSpan()?.spanContext().spanId);
    }),
  });
  const quiet = await sendRoute(f, undefined);
  const route = await sendRoute(f, replies);
  try {
    const chatId = await newChat(f);
    const request = trace.getTracer('test').startSpan('PUT message');
    await context.with(trace.setSpan(context.active(), request), () => route.send(chatId, 'traced'));
    request.end();
    await replies.settle();
    await quiet.send(await newChat(f), 'untraced');
    await replies.dispatch(f.workspace.id);
    assert.deepEqual(active, [request.spanContext().spanId, undefined]);
  } finally {
    await quiet.app.close();
    await route.app.close();
    await f.close();
  }
});

test('a start that outlives its bound fails the send dispatch with a timeout code', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...rest) => {
    lines.push(String(chunk));
    return write(chunk, ...rest);
  });
  const replies = createReplyDispatch({
    runtime: f.runtime,
    // A lazy first connect waits outside `withDeadline`; a start that never settles models it ignoring the RPC deadline.
    temporal: fakeTemporal(() => new Promise(() => {})),
  });
  const route = await sendRoute(f, replies);
  try {
    await route.send(await newChat(f), 'stuck');
    await replies.settle();
    const failure = lines
      .flatMap(line => line.split('\n'))
      .filter(line => line.includes('"dispatch_failed"'))
      .map(line => JSON.parse(line));
    assert.deepEqual(
      failure.map(line => line['error.code']),
      ['timeout'],
    );
  } finally {
    await route.app.close();
    await f.close();
  }
});

test('dispatch metrics label each start with the path that made it', { timeout: 60000 }, async () => {
  const before = await dispatchCounts();
  const f = await conversationFixture();
  const replies = createReplyDispatch({ runtime: f.runtime, temporal: fakeTemporal(async () => {}) });
  const quiet = await sendRoute(f, undefined);
  const route = await sendRoute(f, replies);
  try {
    await route.send(await newChat(f), 'send');
    await replies.settle();
    await quiet.send(await newChat(f), 'sweep');
    await replies.dispatch(f.workspace.id);
    const after = await dispatchCounts();
    const delta = key => (after[key] ?? 0) - (before[key] ?? 0);
    assert.equal(delta('send/undispatched/success'), 1);
    assert.equal(delta('sweep/undispatched/success'), 1);
  } finally {
    await quiet.app.close();
    await route.app.close();
    await f.close();
  }
});

async function dispatchCounts() {
  const { resourceMetrics } = await metricReader.collect();
  const counts = {};
  for (const scope of resourceMetrics.scopeMetrics)
    for (const metric of scope.metrics)
      if (metric.descriptor.name === 'cloud_chat_dispatches')
        for (const point of metric.dataPoints)
          counts[
            `${point.attributes.dispatch_source}/${point.attributes.dispatch_reason}/${point.attributes.outcome}`
          ] = point.value;
  return counts;
}
