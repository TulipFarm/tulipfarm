import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createAgentComposition } from '../dist/agent-composition.js';
import {
  check,
  denied,
  noDisclosure,
  prepareAgent,
  withLiveIntegration,
} from '../../../packages/integrations/test/github-live.mjs';

const { Client, Connection } = createRequire(new URL('../../../packages/agents/package.json', import.meta.url))(
  '@temporalio/client',
);

function payloadText(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(payloadText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(payloadText).join('\n');
  return typeof value === 'string' ? value : '';
}

async function main() {
  let stage = 'fixture and credential lookup';
  try {
    let summary;
    await withLiveIntegration(async f => {
      let connection;
      const children = new Map();
      const handles = [];
      let output = '';
      let cleanupFailed = false;
      const taskQueue = `integrations-composition-${randomUUID()}`;
      async function stop(child, signal = 'SIGTERM') {
        const closed = children.get(child);
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
          await Promise.race([closed, setTimeout(10000, undefined, { ref: false })]);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        await closed;
        children.delete(child);
      }
      async function start() {
        const child = spawn(
          process.execPath,
          [fileURLToPath(new URL('./integrations-composition-child.mjs', import.meta.url))],
          {
            env: {
              PATH: process.env.PATH,
              NODE_ENV: 'test',
              INTEGRATION_ACCEPTANCE_WORKSPACE: f.workspaceId,
              INTEGRATION_ACCEPTANCE_DATABASE_URL: f.runtimeURL,
              INTEGRATION_ACCEPTANCE_QUEUE: taskQueue,
              INTEGRATION_CREDENTIAL_KEY_ID: 'acceptance',
              INTEGRATION_CREDENTIAL_KEY: f.key,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          },
        );
        children.set(child, new Promise(resolve => child.once('close', resolve)));
        child.stdout.on('data', data => {
          output += data.toString();
        });
        child.stderr.on('data', data => {
          output += data.toString();
        });
        await new Promise((resolve, reject) => {
          const timer = globalThis.setTimeout(() => reject(new Error('Worker readiness timeout')), 30000);
          child.once('error', () => {
            clearTimeout(timer);
            reject(new Error('Worker spawn failed'));
          });
          child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('Worker exited'));
          });
          child.once('message', message => {
            clearTimeout(timer);
            if (message?.kind === 'ready') resolve();
            else reject(new Error('Unexpected worker message'));
          });
        });
        return child;
      }
      try {
        stage = 'compiled composition setup';
        await f.service.setGrants(f.workspaceId, f.actor, f.input.id, { ...f.grants, expectedGrantsVersion: 1 });
        const previousEnv = {
          key: process.env.INTEGRATION_CREDENTIAL_KEY,
          id: process.env.INTEGRATION_CREDENTIAL_KEY_ID,
        };
        process.env.INTEGRATION_CREDENTIAL_KEY_ID = 'acceptance';
        process.env.INTEGRATION_CREDENTIAL_KEY = f.key;
        const executor = createAgentComposition(f.runtime);
        if (previousEnv.key === undefined) delete process.env.INTEGRATION_CREDENTIAL_KEY;
        else process.env.INTEGRATION_CREDENTIAL_KEY = previousEnv.key;
        if (previousEnv.id === undefined) delete process.env.INTEGRATION_CREDENTIAL_KEY_ID;
        else process.env.INTEGRATION_CREDENTIAL_KEY_ID = previousEnv.id;
        const agent = await prepareAgent(f, executor);
        connection = await Connection.connect({ address: '127.0.0.1:7233' });
        const client = new Client({ connection });
        async function dispatch(ids) {
          const handle = await client.workflow.start('boundedAgentTool', {
            workflowId: `integration-acceptance-${ids.callId}`,
            taskQueue,
            args: [ids],
            workflowExecutionTimeout: '90 seconds',
          });
          handles.push({ handle, ids });
          return handle;
        }
        let child = await start();
        stage = 'compiled child default fetch read';
        const ids = await agent.queue();
        const completed = await dispatch(ids);
        check((await completed.result()) === 'completed', 'Compiled worker read did not complete');
        const result = await executor.readResult(ids, f.member);
        check(
          result.status === 'completed' && result.result.number === 5 && result.result.state === f.reference.state,
          'Backend result mismatch',
        );
        check(
          typeof result.result.title === 'string' &&
            result.result.title.length > 0 &&
            typeof result.result.body === 'string',
          'Backend issue fields missing',
        );
        const privateValues = [...f.secrets, result.result.title, result.result.body];
        summary = { number: result.result.number, state: result.result.state };
        stage = 'compiled child missing scope denial';
        const narrow = await agent.queue([f.scope[0]]);
        check((await (await dispatch(narrow)).result()) === 'blocked', 'Missing source scope allowed');
        stage = 'durable predecessor wait';
        const predecessor = await agent.queue();
        const waitingIds = await agent.queue(f.scope, 1, predecessor.runId);
        const waiting = await dispatch(waitingIds);
        let enteredWait = false;
        for (let attempt = 0; attempt < 300; attempt++) {
          enteredWait = (await waiting.fetchHistory()).events.some(event => event.timerStartedEventAttributes);
          if (enteredWait) break;
          check(child.exitCode === null && child.signalCode === null, 'Worker exited during wait');
          await setTimeout(50);
        }
        check(enteredWait, 'Workflow did not enter durable wait');
        const beforeRestart = (
          await f.owner.query(`SELECT status FROM ${f.table('tf_agent_tool_calls')} WHERE id = $1`, [waitingIds.callId])
        ).rows[0];
        check(beforeRestart.status === 'pending', 'Predecessor ordering did not defer call');
        stage = 'worker restart and authorization revocation';
        await stop(child, 'SIGKILL');
        await executor.revoke(f.workspaceId, f.actor, { kind: 'activation', id: agent.activation.activationId });
        child = await start();
        await waiting.signal('resumeAgentTool');
        check((await waiting.result()) === 'blocked', 'Revocation after restart did not block');
        await denied(() => executor.readResult(ids, f.member));
        check(
          (
            await f.owner.query(`SELECT status FROM ${f.table('tf_agent_tool_calls')} WHERE id = $1`, [
              waitingIds.callId,
            ])
          ).rows[0].status === 'blocked',
          'Blocked result not persisted',
        );
        check(
          (await f.owner.query(`SELECT count(*)::int AS n FROM ${f.table('tf_integration_dispatches')}`)).rows[0].n ===
            1,
          'Denied or waiting calls reached provider',
        );
        stage = 'history and process log nondisclosure';
        const histories = [];
        for (const { handle, ids: executionIds } of handles) {
          const history = await handle.fetchHistory();
          histories.push(history);
          const input = history.events.find(event => event.workflowExecutionStartedEventAttributes)
            .workflowExecutionStartedEventAttributes.input.payloads;
          const decode = payloads => payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString('utf8')));
          check(JSON.stringify(decode(input)) === JSON.stringify([executionIds]), 'Workflow input was not IDs only');
          const activities = history.events.filter(event => event.activityTaskScheduledEventAttributes);
          check(activities.length >= 1, 'No activity scheduled');
          for (const event of activities) {
            const activity = event.activityTaskScheduledEventAttributes;
            check(activity.activityType.name === 'executeAgentTool', 'Unexpected activity');
            check(
              JSON.stringify(decode(activity.input.payloads)) === JSON.stringify([executionIds]),
              'Activity input was not IDs only',
            );
          }
          for (const event of history.events) {
            const payloads =
              event.activityTaskCompletedEventAttributes?.result?.payloads ??
              event.workflowExecutionCompletedEventAttributes?.result?.payloads;
            if (payloads)
              check(
                decode(payloads).every(value => ['completed', 'waiting', 'blocked'].includes(value)),
                'History result was not status only',
              );
          }
        }
        await stop(child);
        noDisclosure(payloadText(histories), privateValues);
        noDisclosure(JSON.stringify(histories), privateValues);
        noDisclosure(output, privateValues);
        const stored = await f.owner.query(`SELECT call, result FROM ${f.table('tf_agent_tool_calls')}`);
        noDisclosure(JSON.stringify(stored.rows), f.secrets);
        stage = 'cleanup';
      } finally {
        for (const { handle } of handles) {
          try {
            if ((await handle.describe()).status.name === 'RUNNING')
              await handle.terminate('Disposable acceptance cleanup');
          } catch {
            cleanupFailed = true;
          }
        }
        for (const child of children.keys()) {
          try {
            await stop(child);
          } catch {
            cleanupFailed = true;
          }
        }
        try {
          await connection?.close();
        } catch {
          cleanupFailed = true;
        }
        check(!cleanupFailed, 'Worker cleanup failed');
      }
    });
    console.log(`integrations-composition PASS ${JSON.stringify(summary)}`);
  } catch {
    console.error(`integrations-composition FAIL at ${stage}; details suppressed`);
    process.exitCode = 1;
  }
}

await main();
