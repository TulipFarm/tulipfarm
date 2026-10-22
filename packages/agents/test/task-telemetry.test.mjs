import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { reserveTaskWork, settleTaskWork } from '../dist/task-activity.js';
import { admitTaskCall } from '../dist/task-approval-gate.js';
import { createAgentTasks } from '../dist/tasks.js';
import { createTaskRuntime } from '../dist/task-runtime.js';
import { createAgentSchedules } from '../dist/schedules.js';
import { AgentTaskError } from '../dist/task-contracts.js';
import { taskTelemetryCheckpoint, taskTransition, withTaskTelemetry } from '../dist/task-telemetry.js';

const workspaceId = randomUUID(),
  taskId = randomUUID(),
  agentId = randomUUID(),
  activationId = randomUUID(),
  membershipId = randomUUID();
const compatibility = { minimum: 1, maximum: 100 };
const result = (rows = []) => ({ rows, rowCount: rows.length });
const transaction = query => ({ schema: 'telemetry_fixture', commonVersion: 1, client: { query } });

function storage(tx, commit = () => {}) {
  return {
    transaction: async (_workspaceId, _compatibility, operation) => {
      const value = await operation(tx);
      await commit();
      return value;
    },
  };
}

test('task telemetry reports actual transitions without private data or replay duplicates', async t => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
  const sdk = new NodeSDK({ autoDetectResources: false, metricReader: reader });
  sdk.start();
  const events = [];
  const write = process.stdout.write;
  t.mock.method(process.stdout, 'write', function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.includes('"event":"task_status_changed"')) {
      events.push(JSON.parse(chunk));
      return true;
    }
    return write.call(this, chunk, ...args);
  });
  try {
    await t.test('publishes after commit, suppresses zero-row updates and discards rollback', async () => {
      const tx = transaction(async () => result());
      const before = events.length;
      const runtime = withTaskTelemetry(storage(tx, () => assert.equal(events.length, before)));
      assert.equal(
        await runtime.transaction(workspaceId, compatibility, async outer => {
          taskTransition(outer, 'failed', 0);
          taskTransition(outer, 'paused', null);
          const nested = withTaskTelemetry(storage({ ...outer }));
          await nested.transaction(workspaceId, compatibility, inner => taskTransition(inner, 'completed', 1));
          assert.equal(events.length, before);
          return 'committed';
        }),
        'committed',
      );
      assert.deepEqual(
        events.slice(before).map(event => event.status),
        ['completed'],
      );
      await assert.rejects(
        runtime.transaction(workspaceId, compatibility, tx => {
          taskTransition(tx, 'failed', 1);
          throw new Error('operation rollback');
        }),
        /operation rollback/,
      );
      const commitFailure = withTaskTelemetry(
        storage(tx, () => {
          throw new Error('commit rollback');
        }),
      );
      await assert.rejects(
        commitFailure.transaction(workspaceId, compatibility, tx => taskTransition(tx, 'completed', 1)),
        /commit rollback/,
      );
      assert.equal(events.length, before + 1);
      await withTaskTelemetry(storage(tx)).transaction(workspaceId, compatibility, tx =>
        taskTransition(tx, 'failed', 1),
      );
      assert.equal(events.at(-1).status, 'failed', 'buffer is cleaned after rollback');
    });

    await t.test('independent concurrent transactions do not share buffers', async () => {
      const before = events.length;
      let release;
      const wait = new Promise(resolve => {
        release = resolve;
      });
      const slow = withTaskTelemetry(
        storage(
          transaction(async () => result()),
          () => wait,
        ),
      );
      const fast = withTaskTelemetry(storage(transaction(async () => result())));
      const operation = slow.transaction(workspaceId, compatibility, tx => taskTransition(tx, 'paused', 1));
      await fast.transaction(workspaceId, compatibility, tx => taskTransition(tx, 'failed', 1));
      assert.deepEqual(
        events.slice(before).map(event => event.status),
        ['failed'],
      );
      release();
      await operation;
      assert.deepEqual(
        events.slice(before).map(event => event.status),
        ['failed', 'paused'],
      );
    });

    await t.test('savepoint rollback discards paused and started events but retains earlier transitions', async () => {
      const before = events.length;
      const runtime = withTaskTelemetry(storage(transaction(async () => result())));
      await runtime.transaction(workspaceId, compatibility, tx => {
        taskTransition(tx, 'started', 1);
        const rollback = taskTelemetryCheckpoint(tx);
        taskTransition(tx, 'paused', 1);
        taskTransition(tx, 'started', 1);
        rollback();
        taskTransition(tx, 'failed', 1);
      });
      assert.deepEqual(
        events.slice(before).map(event => event.status),
        ['started', 'failed'],
      );
    });

    await t.test(
      'ordinary and scheduled starts and owner pause emit once, excluding replay and failed commit',
      async () => {
        let task, receipt, digest;
        let dueRows = [],
          failMessage = false,
          failNextRun = false;
        const tx = transaction(async (sql, values = []) => {
          if (sql.startsWith('SELECT s.id, s.activation_id')) return result(dueRows);
          if (sql.includes('tf_agent_schedules') && sql.startsWith('UPDATE')) {
            if (failNextRun && sql.includes('next_run_at')) throw new Error('schedule update rollback');
            return result();
          }
          if (sql.includes('tf_authorization_lock')) return result([{ id: 1 }]);
          if (sql.includes('tf_memberships'))
            return result([{ id: membershipId, user_id: 'PRIVATE OWNER', role: 'admin' }]);
          if (sql.startsWith('SELECT 1 FROM') && sql.includes('tf_agents')) return result([{ allowed: 1 }]);
          if (sql.includes('SELECT input_digest,receipt'))
            return result(receipt ? [{ input_digest: digest, receipt }] : []);
          if (sql.includes('count(*)::integer')) return result([{ count: 0 }]);
          if (sql.includes('SELECT a.id,a.definition_revision'))
            return result([
              {
                id: activationId,
                revision: 'a'.repeat(64),
                definition: { name: 'PRIVATE AGENT', instructions: 'PRIVATE INSTRUCTIONS', tools: [] },
                scope: [],
                activated_at: new Date(),
              },
            ]);
          if (sql.includes('SELECT task_limits')) return result();
          if (sql.startsWith('SELECT r.id AS "runId"')) return result();
          if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return result();
          if (
            sql.startsWith('SELECT soul_revision') ||
            sql.startsWith('SELECT d.sources') ||
            sql.startsWith("SELECT definition->'skills'")
          )
            return result();
          if (sql.includes("SET status='paused'")) {
            assert.match(sql, /status IS DISTINCT FROM 'paused'/);
            if (task.status === 'paused') return result();
            task.status = 'paused';
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO') && sql.includes('tf_agent_tasks')) {
            task = {
              id: values[0],
              agentId,
              activationId,
              definitionRevision: 'a'.repeat(64),
              skills: [],
              scope: [],
              limits: values[11],
              parentTaskId: null,
              delegationDepth: 0,
              delegationTools: null,
              flowId: values[0],
              generation: 0,
              status: 'pending',
              activeMilliseconds: '0',
              toolCalls: 0,
              createdAt: new Date().toISOString(),
            };
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT id, agent_id AS')) return result(task ? [task] : []);
          if (sql.includes('tf_agent_task_messages') && sql.startsWith('INSERT')) {
            if (failMessage) throw new AgentTaskError('task-limit');
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('tf_agent_task_commands') && sql.startsWith('INSERT')) {
            digest = values[2];
            receipt = values[3];
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SET knowledge_root=')) return { rows: [], rowCount: 1 };
          if (sql.includes('tf_audit_events')) return { rows: [], rowCount: 1 };
          throw new Error(`Unexpected start query: ${sql}`);
        });
        const before = events.length;
        let committedEvents = before;
        const tasks = createAgentTasks(storage(tx, () => assert.equal(events.length, committedEvents)));
        const input = { requestId: randomUUID(), agentId, text: 'PRIVATE REQUEST' };
        const first = await tasks.start(workspaceId, 'PRIVATE OWNER', input);
        committedEvents++;
        assert.deepEqual(await tasks.start(workspaceId, 'PRIVATE OWNER', input), first);
        assert.deepEqual(
          events.slice(before).map(event => event.status),
          ['started'],
        );
        await tasks.startScheduled(workspaceId, 'PRIVATE OWNER', {
          scheduleId: randomUUID(),
          agentId,
          activationId,
          scope: [],
          limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
          text: 'PRIVATE SCHEDULE',
        });
        committedEvents++;
        assert.deepEqual(
          events.slice(before).map(event => event.status),
          ['started', 'started'],
        );
        await tasks.pause(workspaceId, 'PRIVATE OWNER', task.id, { expectedGeneration: 0 });
        committedEvents++;
        await tasks.pause(workspaceId, 'PRIVATE OWNER', task.id, { expectedGeneration: 0 });
        assert.deepEqual(
          events.slice(before).map(event => event.status),
          ['started', 'started', 'paused'],
        );
        const failing = createAgentTasks(
          storage(tx, () => {
            throw new Error('commit rollback');
          }),
        );
        await assert.rejects(
          failing.startScheduled(workspaceId, 'PRIVATE OWNER', {
            scheduleId: randomUUID(),
            agentId,
            activationId,
            scope: [],
            limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
            text: 'PRIVATE SCHEDULE',
          }),
          /commit rollback/,
        );
        assert.equal(events.length, before + 3);
        dueRows = [
          {
            id: randomUUID(),
            activation_id: activationId,
            agent_id: agentId,
            definition_revision: 'a'.repeat(64),
            membership_id: membershipId,
            user_id: 'PRIVATE OWNER',
            scope: [],
            call: {
              kind: 'task',
              text: 'PRIVATE SCHEDULE',
              limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
            },
            interval_minutes: 60,
            cron_expression: null,
            timezone: null,
            now: new Date(),
          },
        ];
        const schedules = createAgentSchedules(storage(tx, () => assert.equal(events.length, committedEvents)));
        assert.deepEqual(await schedules.due(workspaceId), []);
        committedEvents++;
        assert.equal(events.length, before + 4, 'production bound scheduled start publishes only after outer commit');
        failMessage = true;
        assert.deepEqual(await schedules.due(workspaceId), []);
        assert.equal(events.length, before + 4, 'rolled-back scheduled start is removed at its savepoint');
        failMessage = false;
        failNextRun = true;
        await assert.rejects(schedules.due(workspaceId), /schedule update rollback/);
        assert.equal(events.length, before + 4, 'outer rollback discards a successful inner scheduled start');
      },
    );

    for (const initialStatus of ['completed', 'paused', 'failed', 'waiting-clarification']) {
      await t.test(`${initialStatus} task resumes with started only once after commit`, async () => {
        let receipt,
          digest,
          failCommit = false;
        const task = {
          id: taskId,
          agentId,
          activationId,
          definitionRevision: 'a'.repeat(64),
          skills: [],
          scope: [],
          parentTaskId: null,
          delegationDepth: 0,
          delegationTools: null,
          limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
          flowId: taskId,
          generation: 0,
          status: initialStatus,
          activeMilliseconds: '0',
          toolCalls: 0,
          createdAt: new Date().toISOString(),
        };
        const definition = { name: 'PRIVATE AGENT', instructions: 'PRIVATE INSTRUCTIONS', tools: [] };
        const tx = transaction(async (sql, values = []) => {
          if (sql.includes('tf_authorization_lock')) return result([{ id: 1 }]);
          if (sql.includes('tf_memberships'))
            return result([{ id: membershipId, user_id: 'PRIVATE OWNER', role: 'admin' }]);
          if (sql.startsWith('SELECT to_regclass')) return result([{ installed: false }]);
          if (sql.startsWith('SELECT input_digest,receipt'))
            return result(receipt ? [{ input_digest: digest, receipt }] : []);
          if (sql.startsWith('SELECT max(sequence)')) return result([{ sequence: 0 }]);
          if (sql.includes('count(*)::integer')) return result([{ count: 0 }]);
          if (sql.startsWith('SELECT a.id,a.definition_revision'))
            return result([
              { id: activationId, revision: task.definitionRevision, definition, scope: [], activated_at: new Date() },
            ]);
          if (sql.startsWith('SELECT DISTINCT d.definition')) return result([{ definition }]);
          if (sql.startsWith('SELECT id, agent_id AS')) return result([task]);
          if (sql.startsWith('SELECT owner_user_id,owner_membership_id,delegation_tools'))
            return result([
              { owner_user_id: 'PRIVATE OWNER', owner_membership_id: membershipId, delegation_tools: null },
            ]);
          if (sql.startsWith('SELECT agent_id,definition_revision,skills'))
            return result([{ agent_id: agentId, definition_revision: task.definitionRevision, skills: [] }]);
          if (sql.startsWith('SELECT soul_revision')) return result([{ soul_revision: 'b'.repeat(64) }]);
          if (sql.startsWith('SELECT sources FROM')) return result([{ sources: [] }]);
          if (sql.startsWith('SELECT 1 FROM') && sql.includes('tf_agent_task_activity')) return result();
          if (sql.startsWith('SELECT 1 FROM') || sql.startsWith('SELECT id FROM')) return result([{ id: taskId }]);
          if (sql.includes("status='pending',limits=$2")) {
            assert.match(sql, /status IS DISTINCT FROM 'pending'/);
            if (task.status === 'pending') return result();
            task.status = 'pending';
            if (sql.includes('generation=generation+1')) task.generation++;
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO') && sql.includes('tf_agent_task_commands')) {
            digest = values[2];
            receipt = values[3];
          }
          return result();
        });
        const before = events.length;
        const tasks = createAgentTasks(
          storage(tx, () => {
            assert.equal(events.length, before);
            if (failCommit) throw new Error('resume commit rollback');
          }),
        );
        const input = {
          requestId: randomUUID(),
          expectedGeneration: 0,
          text: 'PRIVATE FOLLOWUP',
          ...(initialStatus === 'completed' ? {} : { expectedSequence: 0 }),
        };
        const operation = () =>
          initialStatus === 'completed'
            ? tasks.reopen(workspaceId, 'PRIVATE OWNER', taskId, input)
            : tasks.continueTask(workspaceId, 'PRIVATE OWNER', taskId, input);
        failCommit = true;
        await assert.rejects(operation(), /resume commit rollback/);
        assert.equal(events.length, before);
        // Restore the fixture state to model the database's transaction rollback.
        receipt = undefined;
        digest = undefined;
        task.status = initialStatus;
        task.generation = 0;
        failCommit = false;
        const first = await operation();
        assert.equal(first.status, 'pending');
        assert.deepEqual(
          events.slice(before).map(event => event.status),
          ['started'],
        );
        const replayTasks = createAgentTasks(storage(tx));
        const replay =
          initialStatus === 'completed'
            ? await replayTasks.reopen(workspaceId, 'PRIVATE OWNER', taskId, input)
            : await replayTasks.continueTask(workspaceId, 'PRIVATE OWNER', taskId, input);
        assert.deepEqual(replay, first);
        assert.equal(events.length, before + 1);
      });
    }

    for (const path of ['reserve-files', 'reserve-tool', 'settle', 'admission']) {
      await t.test(`${path} limit emits paused once and replay is silent`, async () => {
        let status = 'pending',
          settled = false,
          used = false;
        const tx = transaction(async (sql, values = []) => {
          if (sql.includes("SET status='paused'")) {
            assert.match(sql, /status IS DISTINCT FROM 'paused'/);
            if (status === 'paused') return result();
            status = 'paused';
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("SET status='settled'")) {
            if (settled) return result();
            settled = true;
            return result([{ id: values[0] }]);
          }
          if (sql.includes('tf_agent_task_tool_usage') && sql.startsWith('SELECT'))
            return result(used ? [{ call_id: values[0] }] : []);
          return result();
        });
        const runtime = withTaskTelemetry(storage(tx));
        const activity = { id: randomUUID(), task_id: taskId, reserved_milliseconds: '10', expires_at: new Date() };
        const callId = randomUUID();
        const operation = tx =>
          path.startsWith('reserve')
            ? reserveTaskWork(tx, taskId, path === 'reserve-files' ? 'files' : 'tool')
            : path === 'settle'
              ? settleTaskWork(tx, activity, 10)
              : admitTaskCall(tx, taskId, callId);
        const before = events.length;
        await runtime.transaction(workspaceId, compatibility, operation);
        await runtime.transaction(workspaceId, compatibility, operation);
        assert.deepEqual(
          events.slice(before).map(event => event.status),
          ['paused'],
        );
        used = true;
        if (path === 'admission') assert.equal(await runtime.transaction(workspaceId, compatibility, operation), true);
        assert.equal(events.length, before + 1);
      });
    }

    await t.test('runtime authority failure emits failed once; polling stays silent', async () => {
      let status = 'pending';
      const tx = transaction(async sql => {
        if (sql.includes('tf_authorization_lock')) return result([{ id: 1 }]);
        if (sql.startsWith('SELECT owner_user_id'))
          return result([
            { owner_user_id: 'PRIVATE OWNER', owner_membership_id: membershipId, delegation_tools: null },
          ]);
        if (sql.startsWith('SELECT status FROM')) return result([{ status }]);
        if (sql.includes('SET status=$2')) {
          assert.match(sql, /status IS DISTINCT FROM \$2/);
          if (status !== 'pending') return result();
          status = 'failed';
          return { rows: [], rowCount: 1 };
        }
        return result();
      });
      const runtime = createTaskRuntime(storage(tx), null);
      const before = events.length;
      await runtime.process(workspaceId, taskId);
      await runtime.process(workspaceId, taskId);
      assert.deepEqual(await runtime.pending(workspaceId), []);
      assert.deepEqual(
        events.slice(before).map(event => event.status),
        ['failed'],
      );
    });

    await reader.forceFlush();
    const metric = exporter
      .getMetrics()
      .flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics))
      .find(metric => metric.descriptor.name === 'cloud_agent_task_transitions');
    assert.ok(metric);
    for (const point of metric.dataPoints) {
      assert.equal(point.attributes.runtime, 'task');
      assert.equal(point.value, events.filter(event => event.status === point.attributes.status).length);
    }
    assert.doesNotMatch(JSON.stringify({ events, metric }), /PRIVATE|telemetry_fixture/);
    assert.deepEqual([...new Set(events.map(event => event.status))].sort(), [
      'completed',
      'failed',
      'paused',
      'started',
    ]);
  } finally {
    await sdk.shutdown();
  }
});

test('terminal task transitions emit task.completed after commit, never on rollback', async () => {
  const { defineExtension, registerExtension, resetExtensions } = await import('@tulipfarm/extensions');
  const { inTransaction } = await import('@tulipfarm/workspace-storage/provisioning');
  const seen = [];
  await registerExtension(
    defineExtension({
      name: 'recorder',
      register(slots) {
        slots.hooks({
          'task.completed': payload => {
            seen.push(payload);
          },
        });
      },
    }),
    { app: 'worker', env: {} },
  );
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    const schema = `ws_${workspaceId.replaceAll('-', '')}`;
    const tx = { schema, commonVersion: 1, client: { query: async () => result() } };
    const runtime = withTaskTelemetry(
      storage(tx, async () => {
        await tick();
        assert.deepEqual(seen, []);
      }),
    );
    await runtime.transaction(workspaceId, compatibility, async outer => {
      taskTransition(outer, 'completed', 1, taskId);
      taskTransition(outer, 'failed', 0, 'not-changed');
      taskTransition(outer, 'paused', 1);
      const rollback = taskTelemetryCheckpoint(outer);
      taskTransition(outer, 'failed', 1, 'savepoint-rolled-back');
      rollback();
    });
    await assert.rejects(
      runtime.transaction(workspaceId, compatibility, async outer => {
        taskTransition(outer, 'failed', 1, 'rolled-back');
        throw new Error('rollback');
      }),
      /rollback/,
    );
    await tick();
    assert.deepEqual(seen, [{ workspaceId, taskId, outcome: 'completed' }]);

    const client = { query: async () => result() };
    await inTransaction(client, async inner => {
      taskTransition({ schema, commonVersion: 1, client: inner }, 'failed', 1, taskId);
      await tick();
      assert.equal(seen.length, 1);
    });
    await tick();
    assert.deepEqual(seen.at(-1), { workspaceId, taskId, outcome: 'failed' });
  } finally {
    resetExtensions();
  }
});
