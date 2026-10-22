import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { promptFixture } from '../../../packages/slack/test/link-prompts.integration.mjs';
import { createSlackLinkPrompts } from '@tulipfarm/slack';
import { createSlackPromptComposition } from '../dist/slack-composition.js';
import { markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';

test(
  'compiled Slack workflow restarts with durable retries and ID-only Temporal history',
  { timeout: 120000 },
  async () => {
    assert.ok(process.env.TEST_TEMPORAL_CLI, 'Set TEST_TEMPORAL_CLI to a local Temporal CLI binary');
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const server = spawn(
      process.env.TEST_TEMPORAL_CLI,
      ['server', 'start-dev', '--ip', '127.0.0.1', '--port', String(port), '--headless', '--log-level', 'error'],
      { stdio: 'ignore' },
    );
    let f, connection, clientConnection, worker, running, composition;
    const originalEnv = { ...process.env },
      originalFetch = fetch;
    const taskQueue = `slack-prompt-${randomUUID()}`;
    try {
      for (let i = 0; i < 100; i++) {
        try {
          clientConnection = await Connection.connect({ address: `127.0.0.1:${port}`, connectTimeout: '1 second' });
          break;
        } catch {
          assert.equal(server.exitCode, null);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      assert.ok(clientConnection, 'owned Temporal server must accept integrations');
      connection = await NativeConnection.connect({ address: `127.0.0.1:${port}` });
      const client = new Client({ connection: clientConnection });
      f = await promptFixture();
      const prompts = createSlackLinkPrompts(f.options);
      const startWorker = async () => {
        worker = await Worker.create({
          connection,
          taskQueue,
          workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
          activities: { deliverSlackLinkPrompt: prompts.process },
        });
        running = worker.run();
      };
      await f.event();
      const [work] = await prompts.discover(f.workspace.id);
      const start = () =>
        client.workflow.start('slackLinkPrompt', {
          workflowId: `prompt-${work.eventId}`,
          taskQueue,
          args: [work],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        });
      const pending = await start();
      const duplicate = await start();
      assert.equal(pending.firstExecutionRunId, duplicate.firstExecutionRunId);
      f.setResponse('retry');
      await startWorker();
      assert.equal(await pending.result(), 'retry');
      worker.shutdown();
      await running;
      worker = undefined;
      assert.deepEqual(await prompts.discover(f.workspace.id), []);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_slack_link_prompts')} SET next_attempt_at=clock_timestamp()-interval '1 second'`,
      );
      f.setResponse('success');
      const resumed = await start();
      await startWorker();
      assert.equal(await resumed.result(), 'sent');
      assert.equal(f.requests.length, 2);
      assert.deepEqual(await prompts.discover(f.workspace.id), []);
      for (const handle of [pending, resumed]) {
        const history = await handle.fetchHistory();
        const serialized = JSON.stringify(history);
        assert.equal(serialized.includes('PRIVATE ORIGINAL REQUEST'), false);
        assert.equal(serialized.includes('synthetic-bot-token'), false);
        for (const event of history.events) {
          const input =
            event.workflowExecutionStartedEventAttributes?.input ?? event.activityTaskScheduledEventAttributes?.input;
          if (input)
            assert.deepEqual(
              input.payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
              [work],
            );
          for (const payload of event.activityTaskCompletedEventAttributes?.result?.payloads ?? [])
            assert.ok(['retry', 'sent'].includes(JSON.parse(Buffer.from(payload.data).toString())));
        }
      }
      worker.shutdown();
      await running;
      worker = undefined;
      await markWorkspaceReady(f.db.platform, f.workspace.id);
      const config = {
        appId: 'ATEST',
        clientId: 'client',
        clientSecret: 'synthetic',
        signingSecret: 'synthetic-signing-secret',
        redirectUri: 'https://api.example.test/callback',
        scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
        memberLinking: {
          identityRedirectUri: 'https://api.example.test/identity',
          operationalRedirectUri: 'https://api.example.test/operational',
          distribution: 'internal',
          scopeApproval: {
            reference: 'test',
            userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
          },
        },
      };
      Object.assign(process.env, {
        SLACK_LINK_PROMPTS_ENABLED: 'true',
        SLACK_CONFIGURATION: JSON.stringify(config),
        SLACK_CREDENTIAL_KEYS: JSON.stringify({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } }),
        WEB_ORIGIN: 'https://app.example.test',
        WORKSPACE_AUTHORING_DATABASE_URL: f.db.connectionString,
        TEMPORAL_ADDRESS: `127.0.0.1:${port}`,
        TEMPORAL_TASK_QUEUE: taskQueue,
      });
      globalThis.fetch = (url, init) =>
        url === 'https://slack.com/api/chat.postMessage' ? f.options.fetcher(url, init) : originalFetch(url, init);
      const automatic = await f.event('UAUTO', 'DAUTO');
      composition = await createSlackPromptComposition(f.runtime);
      await assert.rejects(
        composition.activities.deliverSlackLinkPrompt({ workspaceId: randomUUID(), eventId: automatic }),
        /slack-workspace-disabled/,
      );
      worker = await Worker.create({
        connection,
        taskQueue,
        workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
        activities: composition.activities,
      });
      running = worker.run();
      for (let i = 0; i < 100; i++) {
        const state = (
          await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_link_prompts')} WHERE event_id=$1`, [
            automatic,
          ])
        ).rows[0]?.state;
        if (state === 'sent') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(f.requests.length, 3);
      assert.equal(f.requests[2].body.channel, 'DAUTO');
      assert.equal(
        (
          await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_link_prompts')} WHERE event_id=$1`, [
            automatic,
          ])
        ).rows[0].state,
        'sent',
      );
    } finally {
      await composition?.close();
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      if (worker) {
        worker.shutdown();
        await running;
      }
      await connection?.close();
      await clientConnection?.close();
      await f?.close();
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
  },
);
