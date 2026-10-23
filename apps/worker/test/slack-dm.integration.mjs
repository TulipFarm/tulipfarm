import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { promptFixture } from '../../../packages/slack/test/link-prompts.integration.mjs';
import { memberProviderFixture } from '../../../packages/slack/test/member-provider-fixture.mjs';
import { createSlackInbox, createSlackMemberLinking } from '@tulipfarm/slack';
import { createSlackPromptComposition } from '../dist/slack-composition.js';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../packages/tables/test/fixture.mjs';
import { markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { completionReply, isCompletionRequest, anthropicChat } from './native-chat-fixture.mjs';

test(
  'ordinary compiled worker links, resumes original signed DM, reads once, renders answer, follows up and restarts',
  { timeout: 180000 },
  async () => {
    assert.ok(process.env.TEST_TEMPORAL_CLI);
    const reservation = netServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const temporal = spawn(
      process.env.TEST_TEMPORAL_CLI,
      ['server', 'start-dev', '--ip', '127.0.0.1', '--port', String(port), '--headless', '--log-level', 'error'],
      { stdio: 'ignore' },
    );
    const env = { ...process.env },
      nativeFetch = fetch;
    let f, connection, clientConnection, worker, running, composition, api;
    const taskQueue = `slack-dm-${randomUUID()}`;
    const modelCalls = [];
    let completionChecks = 0;
    let resource, revision;
    const model = createServer(async (request, response) => {
      let raw = '';
      for await (const part of request) raw += part;
      response.setHeader('content-type', 'application/json');
      if (isCompletionRequest(JSON.parse(raw))) {
        completionChecks++;
        response.end(JSON.stringify(completionReply('anthropic')));
        return;
      }
      modelCalls.push(JSON.parse(raw));
      const decision =
        modelCalls.length === 1
          ? { kind: 'tool', call: { tool: 'rows.page', tableId: resource, revision, limit: 10 } }
          : {
              kind: 'answer',
              text: modelCalls.length === 2 ? '**Created** your invoice.' : 'You asked me to create an invoice.',
            };
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(anthropicChat(decision, { model: 'synthetic', usage: { input_tokens: 20, output_tokens: 10 } })),
      );
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    try {
      for (let i = 0; i < 100; i++) {
        try {
          clientConnection = await Connection.connect({ address: `127.0.0.1:${port}`, connectTimeout: '1 second' });
          break;
        } catch {
          assert.equal(temporal.exitCode, null);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      assert.ok(clientConnection);
      connection = await NativeConnection.connect({ address: `127.0.0.1:${port}` });
      const client = new Client({ connection: clientConnection });
      f = await promptFixture();
      const team = randomUUID(),
        field = textField('Name');
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Finance')`, [team]);
      const created = await createTableWithRows({
        db: f.db,
        workspace: f.workspace,
        runtime: f.runtime,
        definition: tableDefinition({ owningTeamId: team, label: 'Invoices', fields: [field] }),
        records: [{ values: textValues(field, 'Slack invoice') }],
      });
      resource = created.tableId;
      revision = created.revision;
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
        SLACK_DIRECT_MESSAGES_ENABLED: 'true',
        SLACK_CONFIGURATION: JSON.stringify(config),
        SLACK_CREDENTIAL_KEYS: JSON.stringify({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } }),
        WEB_ORIGIN: 'https://app.example.test',
        WORKSPACE_AUTHORING_DATABASE_URL: f.db.connectionString,
        TEMPORAL_ADDRESS: `127.0.0.1:${port}`,
        TEMPORAL_TASK_QUEUE: taskQueue,
        ANTHROPIC_API_KEY: 'synthetic-model-key',
      });
      const provider = await memberProviderFixture(config);
      const providerHttp = createServer(async (request, response) => {
        let body = '';
        for await (const part of request) body += part;
        // #365 proves linked user tokens with auth.test, which reads the bearer header and returns granted scopes in a header.
        const result = await provider.fetcher(`https://slack.com${request.url}`, {
          body,
          headers: { authorization: request.headers.authorization ?? '' },
        });
        const scopes = result.headers.get('x-oauth-scopes');
        if (scopes !== null) response.setHeader('x-oauth-scopes', scopes);
        response.setHeader('content-type', 'application/json');
        response.end(await result.text());
      });
      providerHttp.listen(0, '127.0.0.1');
      await once(providerHttp, 'listening');
      try {
        const route = async () => ({ workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 });
        const memberLinking = createSlackMemberLinking({
          runtime: f.runtime,
          config,
          cipher: f.options.cipher,
          installations: { route },
          fetcher: (url, init) =>
            nativeFetch(`http://127.0.0.1:${providerHttp.address().port}${new URL(url).pathname}`, init),
        });
        const { default: Fastify } = await import('../../../apps/api/node_modules/fastify/fastify.js');
        const { registerSlack } = await import('../../api/dist/slack.js');
        api = Fastify();
        api.register(
          async routes =>
            registerSlack(
              routes,
              {
                api: {
                  getSession: async ({ headers }) =>
                    headers.get('cookie')?.includes('test-session=valid')
                      ? { user: { id: f.workspace.userId }, session: { id: 'session' } }
                      : null,
                },
              },
              { config, installations: { route }, inbox: createSlackInbox(f.runtime), memberLinking },
            ),
          { prefix: '/v1' },
        );
        const address = await api.listen({ host: '127.0.0.1', port: 0 });
        const send = async (id, ts, text, thread_ts) => {
          const timestamp = String(Math.floor(Date.now() / 1000));
          const body = JSON.stringify({
            type: 'event_callback',
            api_app_id: 'ATEST',
            team_id: 'TONE',
            event_id: id,
            event_time: Number(timestamp),
            event: { type: 'message', user: 'UPERSON', channel: 'DONE', ts, text, ...(thread_ts ? { thread_ts } : {}) },
          });
          const response = await nativeFetch(`${address}/v1/slack/events`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-slack-request-timestamp': timestamp,
              'x-slack-signature': `v0=${createHmac('sha256', config.signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
            },
            body,
          });
          assert.equal(response.status, 200);
          return response.json();
        };
        globalThis.fetch = (url, init) =>
          String(url) === 'https://slack.com/api/chat.postMessage'
            ? f.options.fetcher(url, init)
            : String(url).startsWith('https://api.anthropic.com/')
              ? nativeFetch(`http://127.0.0.1:${model.address().port}`, init)
              : nativeFetch(url, init);
        const startWorker = async () => {
          composition = await createSlackPromptComposition(f.runtime, null, 'claude-sonnet');
          worker = await Worker.create({
            connection,
            taskQueue,
            workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
            activities: { ...composition.activities, ...createConversationActivities(f.runtime) },
          });
          running = worker.run();
        };
        const stopWorker = async () => {
          await composition.close();
          composition = undefined;
          worker.shutdown();
          await running;
          worker = undefined;
        };
        const wait = async predicate => {
          for (let i = 0; i < 300; i++) {
            if (await predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          assert.fail('durable worker outcome timed out');
        };
        await send('original', '100.000001', 'Create an invoice');
        await startWorker();
        await wait(() => f.requests.length === 1);
        assert.equal(modelCalls.length, 0);
        const eventId = (
          await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_events')} WHERE event_id='original'`)
        ).rows[0].id;
        const start = await nativeFetch(`${address}/v1/workspaces/${f.workspace.id}/slack/link`, {
          method: 'POST',
          headers: { cookie: 'test-session=valid', origin: process.env.WEB_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ eventId }),
        });
        assert.equal(start.status, 200);
        const destination = new URL((await start.json()).url),
          cookie = start.headers.get('set-cookie').split(';')[0],
          state = destination.searchParams.get('state');
        provider.set({ nonce: destination.searchParams.get('nonce') });
        assert.equal(
          (
            await nativeFetch(`${address}/v1/slack/link/identity`, {
              method: 'POST',
              redirect: 'manual',
              headers: { cookie, origin: 'https://slack.com', 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ state, code: 'synthetic' }),
            })
          ).status,
          303,
        );
        const headers = { cookie: `test-session=valid; ${cookie}` };
        assert.equal(
          (await nativeFetch(`${address}/v1/slack/link/consent?state=${state}`, { headers, redirect: 'manual' }))
            .status,
          302,
        );
        assert.equal(modelCalls.length, 0);
        provider.set({});
        f.setResponse('retry');
        assert.equal(
          (
            await nativeFetch(`${address}/v1/slack/link/complete?state=${state}&code=synthetic`, {
              headers,
              redirect: 'manual',
            })
          ).status,
          200,
        );
        await wait(
          async () =>
            (
              await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_dm_events')} WHERE event_id=$1`, [
                eventId,
              ])
            ).rows[0]?.state === 'retry',
        );
        await stopWorker();
        assert.equal(modelCalls.length, 2);
        assert.equal(completionChecks, 1);
        assert.match(JSON.stringify(modelCalls[0]), /Create an invoice/);
        const credit = (await f.db.platform.query(`SELECT available FROM ${f.table('tf_credit_account')}`)).rows[0]
          .available;
        await send('unpaid', '102.000001', 'Wait for credits');
        await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
        f.setResponse('success');
        await startWorker();
        await wait(
          async () =>
            (
              await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_dm_events')} WHERE event_id=$1`, [
                eventId,
              ])
            ).rows[0]?.state === 'sent',
        );
        const answer = f.requests.at(-1);
        assert.equal(answer.authorization, 'Bearer synthetic-bot-token');
        assert.equal(answer.body.thread_ts, '100.000001');
        assert.equal(answer.body.blocks[0].type, 'rich_text');
        assert.equal(JSON.stringify(answer.body.blocks).includes('**'), false);
        assert.equal(answer.body.text, 'Created your invoice.');
        assert.equal(modelCalls.length, 2);
        await stopWorker();
        assert.equal(
          (
            await f.db.platform.query(
              `SELECT count(*)::int AS n FROM ${f.table('tf_slack_dm_events')} d JOIN ${f.table('tf_slack_events')} e ON e.id=d.event_id WHERE e.event_id='unpaid'`,
            )
          ).rows[0].n,
          0,
        );
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_slack_dm_rejections')} (event_id,reason) SELECT id,'invalid-message' FROM ${f.table('tf_slack_events')} WHERE event_id='unpaid'`,
        );
        await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=$1`, [credit]);
        await startWorker();
        assert.equal((await send('original', '100.000001', 'Create an invoice')).duplicate, true);
        await send('followup', '101.000001', 'What did I ask?', '100.000001');
        await wait(() => f.requests.at(-1).body.text === 'You asked me to create an invoice.');
        assert.equal(modelCalls.length, 3);
        assert.equal(completionChecks, 2);
        assert.match(JSON.stringify(modelCalls[2]), /Create an invoice/);
        assert.match(JSON.stringify(modelCalls[2]), /Created/);
        await stopWorker();
        await startWorker();
        await new Promise(resolve => setTimeout(resolve, 2500));
        await stopWorker();
        assert.equal(modelCalls.length, 3);
        assert.equal(
          (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_slack_dm_roots')}`)).rows[0].n,
          1,
        );
        for await (const execution of client.workflow.list({ query: `TaskQueue = '${taskQueue}'` })) {
          const history = await client.workflow.getHandle(execution.workflowId, execution.runId).fetchHistory();
          const text = JSON.stringify(history);
          assert.equal(text.includes('synthetic-bot-token'), false);
          assert.equal(text.includes('Create an invoice'), false);
          for (const event of history.events) {
            const input =
              event.workflowExecutionStartedEventAttributes?.input ?? event.activityTaskScheduledEventAttributes?.input;
            if (input)
              for (const payload of input.payloads) {
                const value = JSON.parse(Buffer.from(payload.data).toString());
                assert.equal(value.workspaceId, f.workspace.id);
                assert.ok(value.eventId || value.turnId);
                assert.equal(Object.hasOwn(value, 'text'), false);
              }
          }
        }
      } finally {
        await new Promise(resolve => providerHttp.close(resolve));
      }
    } finally {
      await composition?.close();
      if (worker) {
        worker.shutdown();
        await running;
      }
      globalThis.fetch = nativeFetch;
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
      Object.assign(process.env, env);
      await api?.close();
      await connection?.close();
      await clientConnection?.close();
      await f?.close();
      await new Promise(resolve => model.close(resolve));
      temporal.kill('SIGTERM');
      await once(temporal, 'exit');
    }
  },
);
