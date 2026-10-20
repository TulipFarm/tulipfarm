import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.ts';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { decryptEmailDelivery } from '@tulipfarm/workspaces/email-delivery';
import { encryptCredential } from '../../../packages/workspaces/src/credentials.ts';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { initialModelMapping } from '@tulipfarm/config';

test(
  'authenticated default buildApp persists model attempts, retries, fallback cost and revocation',
  { timeout: 240000 },
  async t => {
    const previousEnvironment = process.env;
    const origin = 'http://localhost:5173';
    process.env = {
      PATH: previousEnvironment.PATH,
      NODE_ENV: 'test',
      HOST: '0.0.0.0',
      TEST_ADMIN_DATABASE_URL:
        previousEnvironment.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres',
      BETTER_AUTH_SECRET: 'synthetic-model-runtime-auth-secret-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:3001',
      WEB_ORIGIN: origin,
      TEMPORAL_ADDRESS: '127.0.0.1:1',
      WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
      WORKSPACE_RUNTIME_REPLICAS: '1',
      WORKSPACE_DATABASE_CONNECTION_BUDGET: '120',
      WORKSPACE_RUNTIME_KEY_ID: 'runtime-test',
      WORKSPACE_RUNTIME_KEY: '11'.repeat(32),
      WORKSPACE_CONFIRMATION_KEY_ID: 'confirmation-test',
      WORKSPACE_CONFIRMATION_KEY: '22'.repeat(32),
      INTEGRATION_CREDENTIAL_KEY_ID: 'integration-test',
      INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
      EMAIL_DELIVERY_KEY_ID: 'email-test',
      EMAIL_DELIVERY_KEY: '44'.repeat(32),
      MODEL_FAMILIES: 'claude-opus,gpt-astra',
      AZURE_FOUNDRY_ENDPOINT: 'https://synthetic-local.services.ai.azure.com/',
      ANTHROPIC_API_KEY: 'synthetic-loopback-provider-credential',
      AZURE_FOUNDRY_API_KEY: 'synthetic-loopback-provider-credential',
    };
    let f, identity, app, server;
    const requests = [];
    const transportErrors = [];
    const scenarios = new Map();
    try {
      f = await fixture();
      await f.platform.query('DROP TABLE app.accounts; SET search_path TO app');
      for (const name of ['0001_baseline.sql', '0002_model_bundles.sql']) {
        await f.platform.query(await readFile(new URL(`../../database/migrations/${name}`, import.meta.url), 'utf8'));
      }
      identity = new Pool({ connectionString: f.connectionString, options: '-c search_path=app' });
      const migrations = await workspaceTableMigrations();
      const workspace = await f.create(migrations);
      const table = name => `"${workspace.names.schema}".${name}`;
      assert.deepEqual(
        (await f.platform.query(`SELECT name,checksum FROM ${table('tf_common_migrations')} ORDER BY name`)).rows,
        migrations.map(({ name, checksum }) => ({ name, checksum })),
      );
      process.env.DATABASE_URL = f.connectionString;
      process.env.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL = f.login(workspace, 'confirmation');
      server = createServer(async (request, response) => {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          if (request.url === '/turnstile/v0/siteverify') {
            const challenge = new URLSearchParams(Buffer.concat(chunks).toString());
            assert.equal(challenge.get('response'), 'XXXX.DUMMY.TOKEN.XXXX');
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ success: true, metadata: { result_with_testing_key: true } }));
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const provider = request.url === '/v1/messages' ? 'anthropic' : 'azure';
          assert.equal(request.url, provider === 'anthropic' ? '/v1/messages' : '/openai/v1/chat/completions');
          assert.equal(request.method, 'POST');
          assert.equal(
            request.headers[provider === 'anthropic' ? 'x-api-key' : 'api-key'],
            'synthetic-loopback-provider-credential',
          );
          assert.equal(body.model, provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-6-astra');
          const prompt = body.messages.at(-1).content;
          const scenario = scenarios.get(prompt);
          assert.ok(scenario, `Unexpected provider prompt ${prompt}`);
          requests.push({ provider, prompt, body, path: request.url });
          if (scenario.gate) {
            scenario.gate.started.resolve();
            await scenario.gate.release.promise;
          }
          if (scenario.pause && (!scenario.pauseProvider || scenario.pauseProvider === provider)) {
            scenario.pause.started.resolve();
            await scenario.pause.release.promise;
          }
          const success = provider === 'azure' ? scenario.fallback !== 'unavailable' : scenario.primary === 'answer';
          const decision = scenario.decision ?? {
            kind: 'answer',
            text: provider === 'azure' ? 'Fallback answered over HTTP.' : 'Primary answered over HTTP.',
          };
          response.writeHead(success ? 200 : 503, {
            'content-type': 'application/json',
            'request-id': `loopback-${requests.length}`,
          });
          response.end(
            JSON.stringify(
              !success
                ? { error: { type: 'api_error', message: 'Synthetic primary unavailable' } }
                : provider === 'anthropic'
                  ? {
                      model: 'claude-opus-5-5',
                      stop_reason: 'tool_use',
                      content: [{ type: 'tool_use', name: 'select_action', input: { decision } }],
                      usage: {
                        input_tokens: 10,
                        output_tokens: 2,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                      },
                    }
                  : {
                      model: 'gpt-6-astra-2026-09-22',
                      choices: [
                        {
                          finish_reason: 'tool_calls',
                          message: {
                            tool_calls: [
                              {
                                type: 'function',
                                function: { name: 'select_action', arguments: JSON.stringify({ decision }) },
                              },
                            ],
                          },
                        },
                      ],
                      usage: {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                        total_tokens: 12,
                        prompt_tokens_details: { cached_tokens: 0 },
                      },
                    },
            ),
          );
        } catch (error) {
          transportErrors.push(error);
          response.writeHead(500).end();
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const fetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', (url, options) => {
        const parsed = new URL(url);
        assert.ok(
          [
            'https://api.anthropic.com',
            'https://synthetic-local.services.ai.azure.com',
            'https://challenges.cloudflare.com',
          ].includes(parsed.origin),
          `Unexpected outbound origin ${parsed.origin}`,
        );
        return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, options);
      });
      app = buildApp();
      await app.ready();
      async function signIn(name) {
        const email = `${randomUUID()}@example.com`;
        const sent = await app.inject({
          method: 'POST',
          url: '/v1/auth/sign-in/magic-link',
          headers: { origin, 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX' },
          payload: { email, name },
        });
        assert.equal(sent.statusCode, 200, sent.body);
        const delivery = (
          await identity.query('SELECT id,payload FROM app.email_deliveries ORDER BY created_at DESC LIMIT 1')
        ).rows[0];
        const message = decryptEmailDelivery(delivery.id, delivery.payload, {
          keyId: 'email-test',
          key: Buffer.from('44'.repeat(32), 'hex'),
          previous: new Map(),
        });
        const verified = await app.inject({ url: `/v1/auth/magic-link/verify${new URL(message.url).search}` });
        assert.equal(verified.statusCode, 302, verified.body);
        const cookie = []
          .concat(verified.headers['set-cookie'])
          .map(value => value.split(';')[0])
          .join('; ');
        const session = await app.inject({ url: '/v1/auth/get-session', headers: { cookie } });
        assert.equal(session.statusCode, 200, session.body);
        assert.equal(session.json().user.email, email);
        return { id: session.json().user.id, cookie };
      }
      const admin = await signIn('Runtime admin');
      const other = await signIn('Other admin');
      const adminMembership = randomUUID();
      await f.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        adminMembership,
        admin.id,
      ]);
      await f.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        other.id,
      ]);
      await identity.query(
        `INSERT INTO app.workspaces (id,request_id,created_by,name,slug,soul_commit,soul_bucket,soul_key,ready_at)
      VALUES ($1,$2,$3,'Runtime proof',$4,$5,'synthetic','synthetic',now())`,
        [workspace.id, randomUUID(), admin.id, `runtime-${workspace.id}`, 'a'.repeat(40)],
      );
      const credential = encryptCredential(
        f.login(workspace),
        { workspaceId: workspace.id, generation: 1, capability: 'runtime' },
        { keyId: 'runtime-test', key: Buffer.from('11'.repeat(32), 'hex') },
      );
      await identity.query(
        `INSERT INTO app.workspace_storage (workspace_id,stage,runtime_credential,migration_credential,confirmation_credential)
      VALUES ($1,'ready',$2,'{}','{}')`,
        [workspace.id, credential],
      );
      const agentId = randomUUID(),
        activationId = randomUUID(),
        teamId = randomUUID(),
        commandId = randomUUID(),
        tableId = randomUUID();
      const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
      const definition = {
        name: 'Runtime proof',
        instructions: 'Answer the synthetic prompt.',
        tools: ['schema.inspect'],
        modelFamilyId: 'claude-opus',
      };
      const revision = createHash('sha256').update(canonicalJson(definition)).digest('hex');
      await f.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Runtime team')`, [teamId]);
      await f.platform.query(`INSERT INTO ${table('tf_agents')} (id,owning_team_id) VALUES ($1,$2)`, [agentId, teamId]);
      await f.platform.query(
        `INSERT INTO ${table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
        [agentId, revision, definition],
      );
      await f.platform.query(
        `INSERT INTO ${table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input,status) VALUES ($1,$2,$3,$4,$5,'{}','accepted')`,
        [commandId, agentId, adminMembership, admin.id, randomUUID()],
      );
      await f.platform.query(
        `INSERT INTO ${table('tf_soul_revisions')} (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'synthetic',$3)`,
        ['a'.repeat(40), commandId, 'b'.repeat(64)],
      );
      await f.platform.query(
        `INSERT INTO ${table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
        [agentId, 'a'.repeat(40), revision],
      );
      await f.platform.query(
        `UPDATE ${table('tf_agents')} SET saved_revision=$2,display_name='Runtime proof' WHERE id=$1`,
        [agentId, 'a'.repeat(40)],
      );
      await f.platform.query(
        `INSERT INTO ${table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,$4)`,
        [activationId, agentId, revision, JSON.stringify(scope)],
      );
      await f.platform.query(`INSERT INTO ${table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
        agentId,
        teamId,
      ]);
      await f.platform.query(`INSERT INTO ${table('tf_agent_limits')} (agent_id,scope) VALUES ($1,$2)`, [
        agentId,
        JSON.stringify(scope),
      ]);
      await f.platform.query(
        `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [teamId, tableId],
      );
      await f.platform.query(
        `INSERT INTO ${table('tf_table_catalog')} (id,owning_team_id,display_name,target_revision,physical_table) VALUES ($1,$2,'Runtime resource',$3,$4)`,
        [tableId, teamId, 'a'.repeat(40), `r_${tableId.replaceAll('-', '')}`],
      );
      const base = `/v1/workspaces/${workspace.id}/agents/${agentId}/chat`;
      async function http(method, url, payload, status = 200, who = admin) {
        const response = await app.inject({
          method,
          url,
          headers: { cookie: who.cookie, origin },
          ...(payload === undefined ? {} : { payload }),
        });
        assert.equal(response.statusCode, status, response.body);
        return response.json();
      }
      async function submit(prompt, scenario) {
        scenarios.set(prompt, scenario);
        const input = { id: randomUUID(), activationId, scope, prompt };
        assert.deepEqual(await http('PUT', base, input), { id: input.id, revision, status: 'pending' });
        return input;
      }
      async function until(id, predicate) {
        let result;
        for (let i = 0; i < 80; i++) {
          assert.deepEqual(transportErrors, []);
          result = await http('GET', `${base}/${id}`);
          if (predicate(result)) return result;
          await delay(250);
        }
        assert.fail(`Runtime did not reach expected state: ${JSON.stringify(result)}`);
      }
      const providers = prompt =>
        requests.filter(request => request.prompt === prompt).map(request => request.provider);
      assert.equal((await app.inject({ url: `${base}/${randomUUID()}` })).statusCode, 401);
      const catalog = await http('GET', `/v1/workspaces/${workspace.id}/model-catalog`);
      assert.deepEqual(
        catalog.families
          .filter(family => family.available)
          .map(family => family.id)
          .sort(),
        ['claude-opus', 'gpt-astra'],
      );
      assert.deepEqual(await http('GET', `${base.replace('/chat', '')}/schedules`), []);

      const noRule = await submit('No fallback rule.', { primary: 'unavailable' });
      const first = await until(
        noRule.id,
        result =>
          result.model?.attempts.length === 1 &&
          result.model.attempts[0].status === 'failed' &&
          result.model.attempts[0].outcome !== null &&
          result.status === 'pending',
      );
      assert.match(first.model.bundleId, /^server-[0-9a-f]{64}$/);
      assert.equal(
        (
          await f.platform.query("SELECT payload->>'id' AS id FROM model_lifecycle.bundles WHERE id = $1", [
            first.model.bundleId,
          ])
        ).rows[0]?.id,
        first.model.bundleId,
      );
      assert.equal(first.model.activationRevision, 0);
      assert.deepEqual(first.model.preferred, {
        familyId: 'claude-opus',
        modelId: 'claude-opus-5-5',
        route: { id: 'server-claude-opus-5-5', provider: 'anthropic' },
      });
      assert.equal(first.model.attempts[0].outcome.reason, 'unavailable');
      await app.close();
      app = buildApp();
      await app.ready();
      const failed = await until(noRule.id, result => result.status === 'failed');
      assert.equal(failed.model.failure, 'attempts-exhausted');
      assert.equal(failed.model.generation, 0);
      assert.equal(failed.text, null);
      assert.deepEqual(
        failed.model.attempts.map(attempt => [attempt.ordinal, attempt.role, attempt.status]),
        [
          [1, 'primary', 'failed'],
          [2, 'primary', 'failed'],
        ],
      );
      assert.deepEqual(failed.model.attempts[0], first.model.attempts[0]);
      assert.deepEqual(providers(noRule.prompt), ['anthropic', 'anthropic']);
      await app.close();
      app = buildApp();
      await app.ready();
      assert.deepEqual(await http('GET', `${base}/${noRule.id}`), failed);
      assert.equal((await http('PUT', base, noRule)).status, 'failed');
      await delay(2200);
      assert.deepEqual(providers(noRule.prompt), ['anthropic', 'anthropic']);

      scenarios.set(noRule.prompt, { primary: 'answer' });
      const retry = { requestId: randomUUID(), expectedGeneration: 0 };
      const retryUrl = `${base}/${noRule.id}/retry`;
      await http('POST', retryUrl, retry, 404, other);
      const receipts = await Promise.all([http('POST', retryUrl, retry), http('POST', retryUrl, retry)]);
      assert.deepEqual(receipts, [
        { requestId: retry.requestId, runId: noRule.id, generation: 1 },
        { requestId: retry.requestId, runId: noRule.id, generation: 1 },
      ]);
      await http('POST', retryUrl, { ...retry, requestId: randomUUID() }, 409);
      const recovered = await until(noRule.id, result => result.status === 'answered');
      assert.equal(recovered.text, 'Primary answered over HTTP.');
      assert.equal(recovered.model.generation, 1);
      assert.equal(recovered.model.attempts.length, 1);
      assert.deepEqual(await http('POST', retryUrl, retry), receipts[0]);
      assert.equal(
        (await f.platform.query(`SELECT count(*)::int AS n FROM ${table('tf_model_retry_commands')}`)).rows[0].n,
        1,
      );
      assert.deepEqual(
        (
          await f.platform.query(
            `SELECT generation,status FROM ${table('tf_model_generations')} WHERE run_id=$1 ORDER BY generation`,
            [noRule.id],
          )
        ).rows,
        [
          { generation: 0, status: 'failed' },
          { generation: 1, status: 'committed' },
        ],
      );

      const rule = await http('PUT', `/v1/workspaces/${workspace.id}/model-policy`, {
        requestId: randomUUID(),
        sourceFamilyId: 'claude-opus',
        targetFamilyId: 'gpt-astra',
        expectedRevision: 0,
      });
      assert.equal(rule.revision, 1);
      assert.equal(rule.targetFamilyId, 'gpt-astra');
      const fallback = await submit('Use the optional fallback.', { primary: 'unavailable' });
      const answered = await until(fallback.id, result => result.status === 'answered');
      assert.equal(answered.text, 'Fallback answered over HTTP.');
      assert.deepEqual(providers(fallback.prompt), ['anthropic', 'anthropic', 'azure']);
      assert.deepEqual(
        answered.model.attempts.map(attempt => [attempt.ordinal, attempt.role, attempt.status]),
        [
          [1, 'primary', 'failed'],
          [2, 'primary', 'failed'],
          [3, 'fallback', 'succeeded'],
        ],
      );
      const winner = answered.model.attempts[2];
      assert.equal(answered.model.winner, winner.id);
      assert.equal(winner.resolution.familyId, 'gpt-astra');
      assert.deepEqual(answered.model.preferred, first.model.preferred);
      assert.equal(winner.outcome.actualModel, 'gpt-6-astra-2026-09-22');
      assert.match(winner.outcome.requestId, /^loopback-\d+$/);
      assert.deepEqual(winner.usage, {
        kind: 'known',
        tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      });
      assert.deepEqual(winner.cost, {
        kind: 'known',
        providerPicoUsd: '200000000',
        pricingRevision: initialModelMapping.pricingRevision,
        modelId: 'gpt-6-astra',
        date: winner.cost.date,
        promptTokensAbove: null,
      });
      assert.match(winner.cost.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual(
        (await f.platform.query(`SELECT usage,cost FROM ${table('tf_model_attempts')} WHERE id=$1`, [winner.id])).rows,
        [{ usage: winner.usage, cost: winner.cost }],
      );
      await app.close();
      app = buildApp();
      await app.ready();
      assert.deepEqual(await http('GET', `${base}/${fallback.id}`), answered);
      const preferred = await submit('A new turn prefers primary.', { primary: 'answer' });
      assert.equal(
        (await until(preferred.id, result => result.status === 'answered')).text,
        'Primary answered over HTTP.',
      );
      assert.deepEqual(providers(preferred.prompt), ['anthropic']);

      const availabilityUrl = `/v1/workspaces/${workspace.id}/model-policy/availability`;
      const pause = { started: Promise.withResolvers(), release: Promise.withResolvers() };
      const disabling = await submit('Disable during a real HTTP response.', { primary: 'answer', pause });
      try {
        await Promise.race([
          pause.started.promise,
          delay(15000).then(() => assert.fail('Provider request was not dispatched')),
        ]);
        const command = { requestId: randomUUID(), familyId: 'claude-opus', enabled: false, expectedRevision: 0 };
        assert.deepEqual(await http('PUT', availabilityUrl, command), {
          requestId: command.requestId,
          familyId: 'claude-opus',
          enabled: false,
          revision: 1,
        });
        assert.equal(
          (await http('GET', `/v1/workspaces/${workspace.id}/model-catalog`)).families.find(
            row => row.id === 'claude-opus',
          ).unavailableReason,
          'workspace-disabled',
        );
        await http('PUT', base, { id: randomUUID(), activationId, scope: [], prompt: 'Blocked admission.' }, 400);
      } finally {
        pause.release.resolve();
      }
      const disabledResult = await until(disabling.id, result => result.status === 'failed');
      assert.equal(disabledResult.model.failure, 'policy-revoked');
      assert.equal(disabledResult.text, null);
      assert.equal(disabledResult.model.attempts[0].usage.kind, 'known');
      assert.deepEqual(providers(disabling.prompt), ['anthropic']);
      await http('PUT', availabilityUrl, {
        requestId: randomUUID(),
        familyId: 'claude-opus',
        enabled: true,
        expectedRevision: 1,
      });

      const setEnabled = async (familyId, enabled) => {
        const current = (await http('GET', availabilityUrl)).items.find(row => row.familyId === familyId);
        return http('PUT', availabilityUrl, {
          requestId: randomUUID(),
          familyId,
          enabled,
          expectedRevision: current.revision,
        });
      };
      for (const { familyId, provider, tool } of [
        { familyId: 'claude-opus', provider: 'anthropic', tool: false },
        { familyId: 'claude-opus', provider: 'azure', tool: false },
        { familyId: 'gpt-astra', provider: 'azure', tool: false },
        { familyId: 'claude-opus', provider: 'anthropic', tool: true },
        { familyId: 'gpt-astra', provider: 'azure', tool: true },
      ]) {
        await t.test(
          `disable and re-enable ${familyId} rejects held ${provider} ${tool ? 'tool' : 'answer'} and charges usage`,
          async () => {
            const pause = { started: Promise.withResolvers(), release: Promise.withResolvers() };
            const decision = tool
              ? { kind: 'tool', text: 'Inspect', call: { tool: 'schema.inspect', tableId } }
              : undefined;
            const scenario = {
              primary: provider === 'anthropic' ? 'answer' : 'unavailable',
              pause,
              pauseProvider: provider,
              decision,
            };
            const turn = await submit(`Revocation ${familyId} ${provider} ${tool}`, scenario);
            try {
              await Promise.race([
                pause.started.promise,
                delay(15000).then(() => assert.fail('Provider request was not dispatched')),
              ]);
              await setEnabled(familyId, false);
              await setEnabled(familyId, true);
              assert.equal(
                (await http('GET', availabilityUrl)).items.find(row => row.familyId === familyId).enabled,
                true,
              );
            } finally {
              pause.release.resolve();
            }
            const rejected = await until(turn.id, result => result.status === 'failed');
            assert.equal(rejected.model.failure, 'policy-revoked');
            assert.equal(rejected.model.winner, null);
            assert.equal(rejected.text, null);
            assert.equal(rejected.call, null);
            const attempt = rejected.model.attempts.at(-1);
            assert.deepEqual(attempt.usage, {
              kind: 'known',
              tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
            });
            assert.equal(attempt.cost.kind, 'known');
            const accounting = (
              await f.platform.query(
                `SELECT spent_pico_usd::text, (SELECT sum(CASE WHEN a.cost->>'kind'='known' THEN (a.cost->>'providerPicoUsd')::numeric ELSE a.reserved_pico_usd END)::text FROM ${table('tf_model_attempts')} a WHERE a.run_id=g.run_id AND a.generation=g.generation) AS charged FROM ${table('tf_model_generations')} g WHERE run_id=$1`,
                [turn.id],
              )
            ).rows[0];
            assert.equal(accounting.spent_pico_usd, accounting.charged);
            assert.deepEqual(
              providers(turn.prompt),
              provider === 'anthropic' ? ['anthropic'] : ['anthropic', 'anthropic', 'azure'],
            );
            assert.equal(
              (
                await f.platform.query(
                  `SELECT count(*)::int AS count FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`,
                  [turn.id],
                )
              ).rows[0].count,
              0,
            );
            const fresh = await submit(`Fresh ${familyId} ${provider} ${tool}`, { ...scenario, pause: undefined });
            const accepted = await until(
              fresh.id,
              result => result.model?.status === 'committed' && (tool ? result.call !== null : result.text !== null),
            );
            assert.equal(
              accepted.model.attempts.at(-1).resolution.familyId,
              provider === 'anthropic' ? 'claude-opus' : 'gpt-astra',
            );
            if (tool) {
              assert.deepEqual(accepted.call, decision.call);
              assert.equal(
                (
                  await f.platform.query(
                    `SELECT count(*)::int AS count FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`,
                    [fresh.id],
                  )
                ).rows[0].count,
                1,
              );
            } else
              assert.equal(
                accepted.text,
                provider === 'anthropic' ? 'Primary answered over HTTP.' : 'Fallback answered over HTTP.',
              );
          },
        );
      }

      await f.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=now() WHERE id=$1`, [
        activationId,
      ]);
      const concealed = await http('GET', `${base}/${fallback.id}`);
      assert.equal(concealed.status, 'failed');
      assert.equal(concealed.text, null);
      assert.equal(concealed.model, undefined);
      assert.deepEqual(concealed.execution, { status: 'blocked', result: null });
      assert.deepEqual(transportErrors, []);
    } finally {
      try {
        await app?.close();
        if (server) {
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
        await identity?.end();
        await f?.close();
      } finally {
        process.env = previousEnvironment;
      }
    }
  },
);
