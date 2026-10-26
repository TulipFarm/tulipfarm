import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from 'pg';
import { provisionWorkspace } from '@tulipfarm/workspace-storage/provisioning';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { AccessDenied } from '@tulipfarm/access';
import { createAgentChat, createModelRouteHealth } from '../dist/chat.js';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { createModelPolicyService } from '../dist/model-policy.js';
import { inferDecision } from '../dist/inference.js';
import { provisionTestPgvector } from '../../workspace-storage/test/integration/pgvector.fixture.mjs';
import { registerPlatformWorkspace } from '../../workspace-storage/test/integration/fixture.mjs';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension, installCreditAccount } from '@tulipfarm/workspace-storage/credit-account';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });
// They also assert whole-credit charges, so usage is priced as a billing extension would.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

const unavailable = {
  kind: 'failure',
  reason: 'unavailable',
  status: 503,
  retryAfterMs: null,
  actualModel: null,
  requestId: null,
  usage: { kind: 'unknown' },
};
const answer = {
  kind: 'success',
  decision: { kind: 'answer', text: 'Synthetic answer' },
  actualModel: null,
  requestId: 'synthetic',
  usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
};
const routes = [
  { id: 'primary', modelId: 'claude-opus-5-5', provider: 'anthropic', deployment: 'claude-opus-5-5' },
  { id: 'fallback', modelId: 'gpt-6-astra', provider: 'azure', deployment: 'synthetic-astra' },
].map(route => ({
  ...route,
  location: 'test',
  adapterVersion: 1,
  qualification: 'synthetic local protocol fixture only',
  lifecycle: 'current',
  maxInputTokens: 20000,
  maxOutputTokens: 4096,
  boundedDecision: true,
}));
const bundle = modelBundleSchema.parse({
  format: 1,
  id: 'synthetic-bundle',
  mapping: {
    ...initialModelMapping,
    revision: 'synthetic-mapping',
    families: initialModelMapping.families.filter(family => ['claude-opus', 'gpt-astra'].includes(family.id)),
  },
  models: initialBundleModels,
  routes,
});

test(
  'durable model generations fence recovery, policy, spend, private retries and committed calls',
  { timeout: 180000 },
  async t => {
    const base =
      process.env.CONTINUITY_POSTGRES_URL ??
      process.env.TEST_ADMIN_DATABASE_URL ??
      'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres';
    const database = `continuity_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await provisionTestPgvector(admin, database);
    const url = new URL(base);
    url.pathname = `/${database}`;
    const owner = new Client({ connectionString: url.toString() });
    await owner.connect();
    const workspaceId = randomUUID(),
      ownerUserId = randomUUID(),
      membershipId = randomUUID(),
      agentId = randomUUID(),
      activationId = randomUUID(),
      teamId = randomUUID(),
      tableId = randomUUID();
    let names, runtime;
    try {
      await owner.query('CREATE SCHEMA app');
      await owner.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const passwords = { runtime: randomUUID(), migration: randomUUID(), confirmation: randomUUID() };
      names = await provisionWorkspace({
        connectionString: url.toString(),
        workspaceId,
        passwords,
        initialAdmin: { userId: ownerUserId, membershipId },
        migrations: await workspaceTableMigrations(),
      });
      await registerPlatformWorkspace(owner, workspaceId, ownerUserId);
      await installCreditAccount(owner, workspaceId);
      const runtimeUrl = new URL(url);
      runtimeUrl.username = names.runtime;
      runtimeUrl.password = passwords.runtime;
      const openRuntime = () =>
        createWorkspaceRuntime({
          replicaCount: 1,
          reservedConnections: 2,
          databaseConnectionBudget: 20,
          resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: runtimeUrl.toString() }),
        });
      runtime = openRuntime();
      const table = name => `"${names.schema}".${name}`;
      const definition = {
        name: 'Synthetic agent',
        instructions: 'Inspect synthetic records',
        tools: ['schema.inspect'],
        modelFamilyId: 'claude-opus',
      };
      const revision = createHash('sha256').update(canonicalJson(definition)).digest('hex');
      const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
      await owner.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Synthetic team')`, [teamId]);
      await owner.query(`INSERT INTO ${table('tf_agents')} (id,owning_team_id) VALUES ($1,$2)`, [agentId, teamId]);
      await owner.query(
        `INSERT INTO ${table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
        [agentId, revision, definition],
      );
      const commandId = randomUUID();
      await owner.query(
        `INSERT INTO ${table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input) VALUES ($1,$2,$3,$5,$4,'{}')`,
        [commandId, agentId, membershipId, randomUUID(), ownerUserId],
      );
      await owner.query(
        `INSERT INTO ${table('tf_soul_revisions')} (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'synthetic',$3)`,
        ['a'.repeat(40), commandId, 'b'.repeat(64)],
      );
      await owner.query(
        `INSERT INTO ${table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
        [agentId, 'a'.repeat(40), revision],
      );
      await owner.query(
        `UPDATE ${table('tf_agents')} SET saved_revision=$2,display_name='Synthetic agent' WHERE id=$1`,
        [agentId, 'a'.repeat(40)],
      );
      await owner.query(
        `INSERT INTO ${table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,$4)`,
        [activationId, agentId, revision, JSON.stringify(scope)],
      );
      await owner.query(`INSERT INTO ${table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [agentId, teamId]);
      // The owner invokes through an explicit team grant. Admin status grants no agent access.
      await owner.query(
        `INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [membershipId, teamId],
      );
      await owner.query(
        `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'read'),($1,$2,'invoke') ON CONFLICT DO NOTHING`,
        [agentId, teamId],
      );
      await owner.query(`INSERT INTO ${table('tf_agent_limits')} (agent_id,scope) VALUES ($1,$2)`, [
        agentId,
        JSON.stringify(scope),
      ]);
      await owner.query(
        `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [teamId, tableId],
      );
      await owner.query(
        `INSERT INTO ${table('tf_table_catalog')} (id,owning_team_id,display_name,target_revision,physical_table) VALUES ($1,$2,'Synthetic resource',$3,$4)`,
        [tableId, teamId, 'a'.repeat(40), `r_${tableId.replaceAll('-', '')}`],
      );
      const health = createModelRouteHealth(
        owner,
        resolution => `${resolution.route.provider}/${resolution.route.deployment}`,
      );
      const config = (infer, paused) => ({
        ...(paused ? { paused } : {}),
        activeBundle: () => ({ bundle, activationRevision: 1 }),
        restrictions: () => ({ allowedProviders: ['anthropic', 'azure'], allowedLocations: ['test'] }),
        trustedBundle: id => {
          assert.equal(id, bundle.id);
          return bundle;
        },
        allowed: () => true,
        actualModelIds: resolution => [resolution.modelId],
        health,
        infer: async (...args) => {
          const result = await infer(...args);
          return { ...result, actualModel: result.actualModel ?? args[0].modelId };
        },
        budgetPicoUsd: () => '10000000000000',
      });
      const submit = async chat => {
        const id = randomUUID();
        await chat.submit(workspaceId, ownerUserId, agentId, {
          id,
          activationId,
          scope,
          prompt: 'Inspect synthetic data',
        });
        return id;
      };
      const attempts = async id =>
        (
          await owner.query(`SELECT * FROM ${table('tf_model_attempts')} WHERE run_id=$1 ORDER BY generation,ordinal`, [
            id,
          ])
        ).rows;
      const clearWait = async () => {
        await owner.query(`UPDATE ${table('tf_model_generations')} SET next_at=clock_timestamp()`);
        await owner.query('UPDATE app.model_route_health SET until_at=clock_timestamp(),probe_until=NULL');
      };
      const exhaust = async (chat, id) => {
        for (let i = 0; i < 4; i++) {
          await clearWait();
          await chat.processTurn(workspaceId, id);
        }
      };
      const rule = async target =>
        owner.query(
          `INSERT INTO ${table('tf_model_fallback_rules')} (source_family_id,target_family_id,revision,editor_membership_id) VALUES ('claude-opus',$1,1,$2) ON CONFLICT (source_family_id) DO UPDATE SET target_family_id=EXCLUDED.target_family_id,revision=${table('tf_model_fallback_rules')}.revision+1`,
          [target, membershipId],
        );
      const setEnabled = async (familyId, enabled) => {
        const policy = createModelPolicyService(runtime);
        const current = (await policy.availability(workspaceId, ownerUserId)).items.find(
          row => row.familyId === familyId,
        );
        return policy.saveAvailability(workspaceId, ownerUserId, {
          requestId: randomUUID(),
          familyId,
          enabled,
          expectedRevision: current.revision,
        });
      };
      await t.test(
        'workspace credits block admission and queued continuations, then settle actual usage once',
        async () => {
          let calls = 0;
          const chat = createAgentChat(
            runtime,
            config(async () => {
              calls++;
              return answer;
            }),
          );
          const id = await submit(chat);
          await owner.query(`UPDATE ${table('tf_credit_account')} SET available=0`);
          await assert.rejects(submit(chat), error => error.code === 'credits-exhausted');
          await chat.processTurn(workspaceId, id);
          assert.equal(calls, 0);
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).model.failure, 'credits-exhausted');
          await assert.rejects(
            chat.retry(workspaceId, ownerUserId, agentId, id, { requestId: randomUUID(), expectedGeneration: 0 }),
            error => error.code === 'credits-exhausted',
          );
          await owner.query(`UPDATE ${table('tf_credit_account')} SET available=1000000000000000`);
          const next = await submit(chat);
          await chat.processTurn(workspaceId, next);
          await chat.processTurn(workspaceId, next);
          assert.equal(calls, 1);
          const receipt = (await attempts(next))[0];
          const usage = (
            await owner.query(`SELECT charged,agent_id,activity FROM ${table('tf_credit_usage')} WHERE id=$1`, [
              receipt.id,
            ])
          ).rows[0];
          assert.equal(usage.charged, '1000000000000');
          assert.equal(usage.agent_id, agentId);
          assert.equal(usage.activity, 'agent');
        },
      );
      await t.test('disabled source blocks admission and a queued primary cannot escape through fallback', async () => {
        await rule('gpt-astra');
        const called = [];
        const chat = createAgentChat(
          runtime,
          config(async resolution => {
            called.push(resolution.familyId);
            return unavailable;
          }),
        );
        const id = await submit(chat);
        await setEnabled('claude-opus', false);
        await assert.rejects(submit(chat), error => error.code === 'workspace-disabled');
        await setEnabled('claude-opus', true);
        await exhaust(chat, id);
        assert.deepEqual(called, []);
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).model.failure, 'policy-revoked');
        await setEnabled('claude-opus', true);
        await rule(null);
      });
      await t.test(
        'local adapter configuration failure releases credits but an unknown dispatched transport failure retains them',
        async t => {
          let called = 0;
          t.mock.method(globalThis, 'fetch', async () => {
            called++;
            throw new Error('Unknown dispatched result');
          });
          const route = {
            provider: 'anthropic',
            endpoint: 'https://api.anthropic.com/',
            model: 'claude-opus-5-5',
            apiKey: 'invalid key',
          };
          const chat = createAgentChat(
            runtime,
            config(async (_resolution, input) => inferDecision(route, input)),
          );
          const before = (await owner.query(`SELECT available FROM ${table('tf_credit_account')}`)).rows[0].available;
          const id = await submit(chat);
          await chat.processTurn(workspaceId, id);
          assert.equal(called, 0);
          assert.equal(
            (await owner.query(`SELECT available FROM ${table('tf_credit_account')}`)).rows[0].available,
            before,
          );
          const attempt = (await attempts(id))[0];
          assert.equal(
            (await owner.query(`SELECT charged FROM ${table('tf_credit_usage')} WHERE id=$1`, [attempt.id])).rows[0]
              .charged,
            '0',
          );
          route.apiKey = 'synthetic-only';
          const dispatched = await submit(chat);
          await chat.processTurn(workspaceId, dispatched);
          assert.equal(called, 1);
          const unknown = (await attempts(dispatched))[0];
          assert.equal(
            (await owner.query(`SELECT charged FROM ${table('tf_credit_usage')} WHERE id=$1`, [unknown.id])).rows[0]
              .charged,
            null,
          );
          assert.ok(
            BigInt((await owner.query(`SELECT available FROM ${table('tf_credit_account')}`)).rows[0].available) <
              BigInt(before),
          );
        },
      );
      await t.test('disable queued during a route claim wins before provider dispatch', async () => {
        let enter, release;
        const entered = new Promise(resolve => {
          enter = resolve;
        });
        const gate = new Promise(resolve => {
          release = resolve;
        });
        const settings = config(async () => {
          assert.fail('disabled claim reached provider');
        });
        settings.health = {
          ...health,
          claim: async (...args) => {
            enter();
            await gate;
            return health.claim(...args);
          },
        };
        const chat = createAgentChat(runtime, settings);
        const id = await submit(chat);
        await clearWait();
        const work = chat.processTurn(workspaceId, id);
        await entered;
        const current = (
          await owner.query(`SELECT revision FROM ${table('tf_model_availability')} WHERE family_id='claude-opus'`)
        ).rows[0];
        const disable = createModelPolicyService(runtime).saveAvailability(workspaceId, ownerUserId, {
          requestId: randomUUID(),
          familyId: 'claude-opus',
          enabled: false,
          expectedRevision: current.revision,
        });
        for (let i = 0; i < 100; i++) {
          const waiting = (
            await owner.query(`SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'`, [
              names.runtime,
            ])
          ).rowCount;
          if (waiting) break;
          if (i === 99) assert.fail('disable did not wait for the claim lock');
          await delay(5);
        }
        release();
        await disable;
        await work;
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).model.failure, 'policy-revoked');
        await setEnabled('claude-opus', true);
      });
      for (const familyId of ['claude-opus', 'gpt-astra'])
        await t.test(
          `disabling ${familyId} while fallback provider is pending rejects the result but records usage`,
          async () => {
            await rule('gpt-astra');
            let enter, release;
            const entered = new Promise(resolve => {
              enter = resolve;
            });
            const gate = new Promise(resolve => {
              release = resolve;
            });
            const called = [];
            const chat = createAgentChat(
              runtime,
              config(async resolution => {
                called.push(resolution.familyId);
                if (resolution.familyId !== 'gpt-astra') return unavailable;
                enter();
                await gate;
                return answer;
              }),
            );
            const id = await submit(chat);
            for (let i = 0; i < 2; i++) {
              await clearWait();
              await chat.processTurn(workspaceId, id);
            }
            await clearWait();
            const work = chat.processTurn(workspaceId, id);
            await entered;
            await setEnabled(familyId, false);
            await setEnabled(familyId, true);
            release();
            await work;
            const result = await chat.read(workspaceId, ownerUserId, agentId, id);
            assert.equal(result.text, null);
            assert.equal(result.model.failure, 'policy-revoked');
            assert.deepEqual(called, ['claude-opus', 'claude-opus', 'gpt-astra']);
            assert.equal((await attempts(id))[2].usage.kind, 'known');
            await setEnabled(familyId, true);
            await rule(null);
          },
        );
      for (const familyId of ['claude-opus', 'gpt-astra'])
        await t.test(`disable and re-enable ${familyId} after claim prevents dispatch`, async () => {
          await rule('gpt-astra');
          const called = [];
          const settings = config(async resolution => {
            called.push(resolution.familyId);
            return unavailable;
          });
          const chat = createAgentChat(runtime, settings);
          const id = await submit(chat);
          if (familyId === 'gpt-astra')
            for (let i = 0; i < 2; i++) {
              await clearWait();
              await chat.processTurn(workspaceId, id);
            }
          let transactions = 0;
          const interrupted = {
            ...runtime,
            transaction: async (...args) => {
              const result = await runtime.transaction(...args);
              if (++transactions === 1) {
                await setEnabled(familyId, false);
                await setEnabled(familyId, true);
              }
              return result;
            },
          };
          await clearWait();
          await createAgentChat(interrupted, settings).processTurn(workspaceId, id);
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).model.failure, 'policy-revoked');
          assert.deepEqual(called, familyId === 'claude-opus' ? [] : ['claude-opus', 'claude-opus']);
          await rule(null);
        });
      await t.test('an enabled-to-enabled save does not revoke admitted work', async () => {
        const chat = createAgentChat(
          runtime,
          config(async () => answer),
        );
        const id = await submit(chat);
        await setEnabled('claude-opus', true);
        await clearWait();
        await chat.processTurn(workspaceId, id);
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).text, 'Synthetic answer');
      });
      await t.test('primary result pending behind disable cannot become a tool call', async () => {
        const chat = createAgentChat(
          runtime,
          config(async () => {
            await setEnabled('claude-opus', false);
            await setEnabled('claude-opus', true);
            return {
              ...answer,
              decision: { kind: 'tool', text: 'Inspect', call: { tool: 'schema.inspect', tableId } },
            };
          }),
        );
        const id = await submit(chat);
        await clearWait();
        await chat.processTurn(workspaceId, id);
        const result = await chat.read(workspaceId, ownerUserId, agentId, id);
        assert.equal(result.model.failure, 'policy-revoked');
        assert.equal(result.call, null);
        assert.equal(
          (await owner.query(`SELECT 1 FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`, [id])).rowCount,
          0,
        );
        await setEnabled('claude-opus', true);
      });
      await t.test(
        'disabled fallback is omitted on admission and cannot be dispatched from an older binding',
        async () => {
          await rule('gpt-astra');
          const called = [];
          const chat = createAgentChat(
            runtime,
            config(async resolution => {
              called.push(resolution.familyId);
              return unavailable;
            }),
          );
          const pinned = await submit(chat);
          await setEnabled('gpt-astra', false);
          const fresh = await submit(chat);
          await setEnabled('gpt-astra', true);
          await exhaust(chat, pinned);
          await exhaust(chat, fresh);
          assert.deepEqual(called, ['claude-opus', 'claude-opus', 'claude-opus', 'claude-opus']);
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, pinned)).model.failure, 'policy-revoked');
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, fresh)).model.failure, 'attempts-exhausted');
          assert.equal(
            (
              await owner.query(
                `SELECT target_family_id FROM ${table('tf_model_fallback_rules')} WHERE source_family_id='claude-opus'`,
              )
            ).rows[0].target_family_id,
            'gpt-astra',
          );
          await setEnabled('gpt-astra', true);
          await rule(null);
        },
      );

      await t.test(
        'dispatch transaction rollback aborts and observes a rejecting provider without accepting a decision',
        async () => {
          const started = Promise.withResolvers();
          const aborted = Promise.withResolvers();
          let calls = 0;
          const failingRuntime = {
            ...runtime,
            transaction: (workspace, compatibility, operation) =>
              runtime.transaction(workspace, compatibility, async tx => {
                const result = await operation(tx);
                if (++calls === 2) {
                  await started.promise;
                  await tx.client.query('SELECT 1 / 0');
                }
                return result;
              }),
          };
          const settings = config(async (_resolution, _input, _timeout, signal) => {
            started.resolve();
            await new Promise((resolve, reject) =>
              signal.addEventListener(
                'abort',
                () => {
                  aborted.resolve();
                  reject(new Error('provider aborted'));
                },
                { once: true },
              ),
            );
            return answer;
          });
          const chat = createAgentChat(runtime, settings);
          const id = await submit(chat);
          await clearWait();
          await assert.rejects(
            createAgentChat(failingRuntime, settings).processTurn(workspaceId, id),
            /division by zero/,
          );
          assert.equal(
            await Promise.race([aborted.promise.then(() => 'aborted'), delay(1000).then(() => 'still running')]),
            'aborted',
          );
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).text, null);
          const [attempt] = await attempts(id);
          assert.equal(attempt.status, 'running');
          assert.deepEqual(attempt.usage, { kind: 'unknown', reason: 'abandoned' });
          assert.equal(
            (
              await owner.query(`SELECT spent_pico_usd::text FROM ${table('tf_model_generations')} WHERE run_id=$1`, [
                id,
              ])
            ).rows[0].spent_pico_usd,
            attempt.reserved_pico_usd,
          );
          await owner.query(
            `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [attempt.id],
          );
          const recovered = createAgentChat(
            runtime,
            config(async () => answer),
          );
          await clearWait();
          await recovered.processTurn(workspaceId, id);
          assert.equal((await recovered.read(workspaceId, ownerUserId, agentId, id)).text, 'Synthetic answer');
        },
      );
      for (const failImmediately of [true, false])
        await t.test(
          `real adapter is bounded before dispatch transaction ${failImmediately ? 'rollback' : 'completion'}`,
          async t => {
            const started = Promise.withResolvers();
            const closed = Promise.withResolvers();
            const observed = Promise.withResolvers();
            const server = createServer(async (request, response) => {
              const chunks = [];
              for await (const chunk of request) chunks.push(chunk);
              assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, 'claude-opus-5-5');
              response.on('close', () => closed.resolve('closed'));
              started.resolve();
            });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            const fetch = globalThis.fetch;
            t.mock.method(globalThis, 'fetch', (url, options) => {
              assert.equal(url, 'https://api.anthropic.com/v1/messages');
              return fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, options);
            });
            try {
              let calls = 0;
              const heldRuntime = {
                ...runtime,
                transaction: (workspace, compatibility, operation) =>
                  runtime.transaction(workspace, compatibility, async tx => {
                    const result = await operation(tx);
                    if (++calls === 2) {
                      await started.promise;
                      if (failImmediately) await tx.client.query('SELECT 1 / 0');
                      assert.equal(await Promise.race([closed.promise, delay(2000).then(() => 'open')]), 'closed');
                    }
                    return result;
                  }),
              };
              const settings = config(async (resolution, input, _timeout, signal) => {
                const result = await inferDecision(
                  {
                    provider: 'anthropic',
                    endpoint: 'https://api.anthropic.com/',
                    model: resolution.modelId,
                    apiKey: 'synthetic-key',
                    timeoutMs: 45000,
                  },
                  input,
                  signal,
                );
                observed.resolve(result);
                return result;
              });
              const chat = createAgentChat(runtime, settings);
              const id = await submit(chat);
              await clearWait();
              await owner.query(
                `UPDATE ${table('tf_model_generations')} SET deadline=clock_timestamp()+interval '3 seconds' WHERE run_id=$1`,
                [id],
              );
              const work = createAgentChat(heldRuntime, settings).processTurn(workspaceId, id);
              if (failImmediately) await assert.rejects(work, /division by zero/);
              else await work;
              assert.equal(await Promise.race([closed.promise, delay(2000).then(() => 'open')]), 'closed');
              assert.deepEqual(await observed.promise, {
                kind: 'failure',
                reason: 'cancelled',
                status: null,
                actualModel: null,
                requestId: null,
                retryAfterMs: null,
                usage: { kind: 'unknown' },
              });
              assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).text, null);
            } finally {
              server.closeAllConnections();
              await new Promise(resolve => server.close(resolve));
            }
          },
        );
      await t.test('no rule dispatches only two primary attempts and restart cannot reset them', async () => {
        const called = [];
        let chat = createAgentChat(
          runtime,
          config(async resolution => {
            called.push(resolution.familyId);
            return unavailable;
          }),
        );
        const id = await submit(chat);
        await exhaust(chat, id);
        assert.deepEqual(called, ['claude-opus', 'claude-opus']);
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).status, 'failed');
        await runtime.close();
        runtime = openRuntime();
        chat = createAgentChat(
          runtime,
          config(async () => {
            assert.fail('Restart reset budget');
          }),
        );
        await chat.processTurn(workspaceId, id);
        assert.equal((await attempts(id)).length, 2);
      });
      await t.test(
        'killed processor consumes its attempt and fresh processes cannot reset the generation',
        async () => {
          const chat = createAgentChat(
            runtime,
            config(async () => {
              assert.fail('parent must not infer');
            }),
          );
          const id = await submit(chat);
          const script = fileURLToPath(new URL('./continuity-process.mjs', import.meta.url));
          const env = {
            ...process.env,
            CONTINUITY_RUNTIME_URL: runtimeUrl.toString(),
            CONTINUITY_WORKSPACE_ID: workspaceId,
            CONTINUITY_RUN_ID: id,
          };
          const child = spawn(process.execPath, [script], {
            env: { ...env, CONTINUITY_INTERRUPT: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let output = '';
          child.stderr.on('data', chunk => {
            output += chunk;
          });
          await new Promise((resolve, reject) => {
            child.stdout.once('data', () => resolve());
            child.once('error', reject);
            child.once('exit', code => reject(new Error(`Processor exited ${code}: ${output}`)));
          });
          const exited = new Promise(resolve => child.once('exit', resolve));
          child.kill('SIGKILL');
          await exited;
          const first = (await attempts(id))[0];
          assert.equal(first.status, 'running');
          assert.equal(first.usage.kind, 'unknown');
          await owner.query(
            `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [first.id],
          );
          for (let i = 0; i < 3; i++) {
            await clearWait();
            await promisify(execFile)(process.execPath, [script], { env, timeout: 10000 });
          }
          const rows = await attempts(id);
          assert.equal(rows.length, 2);
          assert.equal(rows[0].status, 'abandoned');
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).status, 'failed');
        },
      );
      await t.test(
        'admission pins one activation revision and filters disallowed sibling routes before resolution',
        async () => {
          const regional = modelBundleSchema.parse({
            ...bundle,
            id: 'regional-bundle',
            routes: [...bundle.routes, { ...bundle.routes[0], id: 'disallowed-region', location: 'elsewhere' }],
          });
          let revision = 7,
            calls = 0;
          const settings = {
            ...config(async () => answer),
            activeBundle: () => {
              calls++;
              return { bundle: regional, activationRevision: revision++ };
            },
            trustedBundle: () => regional,
          };
          const chat = createAgentChat(runtime, settings);
          const first = await submit(chat);
          const second = await submit(chat);
          const rows = (
            await owner.query(
              `SELECT binding FROM ${table('tf_model_generations')} WHERE run_id=ANY($1::uuid[]) ORDER BY created_at`,
              [[first, second]],
            )
          ).rows;
          assert.equal(calls, 2);
          assert.deepEqual(
            rows.map(row => row.binding.activationRevision),
            [7, 8],
          );
          assert.equal(rows[0].binding.primary.route.id, 'primary');
          assert.equal(rows[0].binding.bundleId, 'regional-bundle');
          await clearWait();
          await chat.processTurn(workspaceId, first);
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, first)).status, 'answered');
          assert.equal(calls, 2);
        },
      );
      await t.test(
        'one configured fallback wins, without following its own rule; new runs prefer primary',
        async () => {
          await rule('gpt-astra');
          await owner.query(
            `INSERT INTO ${table('tf_model_fallback_rules')} (source_family_id,target_family_id,revision,editor_membership_id) VALUES ('gpt-astra','claude-opus',1,$1)`,
            [membershipId],
          );
          const called = [];
          const chat = createAgentChat(
            runtime,
            config(async resolution => {
              called.push(resolution.familyId);
              return resolution.familyId === 'gpt-astra' ? answer : unavailable;
            }),
          );
          const id = await submit(chat);
          await exhaust(chat, id);
          assert.deepEqual(called, ['claude-opus', 'claude-opus', 'gpt-astra']);
          const rows = await attempts(id);
          assert.equal(rows[2].cost.kind, 'known');
          assert.notEqual(rows[2].cost.providerPicoUsd, '0');
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).text, 'Synthetic answer');
          const recovered = createAgentChat(
            runtime,
            config(async resolution => {
              assert.equal(resolution.familyId, 'claude-opus');
              return answer;
            }),
          );
          const next = await submit(recovered);
          await clearWait();
          await recovered.processTurn(workspaceId, next);
          assert.equal((await attempts(next)).length, 1);
        },
      );
      await t.test('a paused family runs on its fallback rule target, or keeps itself without one', async () => {
        const called = [];
        const chat = createAgentChat(
          runtime,
          config(
            async resolution => {
              called.push(resolution.familyId);
              return answer;
            },
            familyId => familyId === 'claude-opus',
          ),
        );
        await rule('gpt-astra');
        const replaced = await submit(chat);
        await clearWait();
        await chat.processTurn(workspaceId, replaced);
        assert.deepEqual(called, ['gpt-astra']);
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, replaced)).status, 'answered');
        await rule(null);
        const kept = await submit(chat);
        await clearWait();
        await chat.processTurn(workspaceId, kept);
        assert.deepEqual(called, ['gpt-astra', 'claude-opus']);
        await rule('gpt-astra');
      });
      await t.test('both routes failing terminate at three attempts and replay does not resume', async () => {
        const chat = createAgentChat(
          runtime,
          config(async () => unavailable),
        );
        const id = await submit(chat);
        await exhaust(chat, id);
        assert.equal((await attempts(id)).length, 3);
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).status, 'failed');
        await chat.processTurn(workspaceId, id);
        assert.equal((await attempts(id)).length, 3);
      });
      await t.test('revoked fallback stops before dispatch and before committing its result', async () => {
        const called = [];
        const chat = createAgentChat(
          runtime,
          config(async resolution => {
            called.push(resolution.familyId);
            return unavailable;
          }),
        );
        const id = await submit(chat);
        await clearWait();
        await chat.processTurn(workspaceId, id);
        await clearWait();
        await chat.processTurn(workspaceId, id);
        await rule(null);
        await exhaust(chat, id);
        assert.deepEqual(called, ['claude-opus', 'claude-opus']);
        await rule('gpt-astra');
        const revoked = createAgentChat(
          runtime,
          config(async resolution => {
            if (resolution.familyId === 'gpt-astra') {
              await rule(null);
              return answer;
            }
            return unavailable;
          }),
        );
        const other = await submit(revoked);
        await exhaust(revoked, other);
        const result = await revoked.read(workspaceId, ownerUserId, agentId, other);
        assert.equal(result.status, 'failed');
        assert.equal(result.text, null);
        assert.equal((await attempts(other))[2].usage.kind, 'known');
      });
      await t.test(
        'competing processors commit once; expired late success cannot replace the next attempt',
        async () => {
          let entered, release;
          const started = new Promise(resolve => {
            entered = resolve;
          });
          const gate = new Promise(resolve => {
            release = resolve;
          });
          let calls = 0;
          const chat = createAgentChat(
            runtime,
            config(async () => {
              calls++;
              entered();
              await gate;
              return answer;
            }),
          );
          const id = await submit(chat);
          await clearWait();
          const work = chat.processTurn(workspaceId, id);
          await started;
          await chat.processTurn(workspaceId, id);
          assert.equal(calls, 1);
          await owner.query(
            `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1`,
            [id],
          );
          await owner.query(
            `UPDATE ${table('tf_agent_chat_turns')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [id],
          );
          const restarted = createAgentChat(
            runtime,
            config(async () => ({ ...answer, decision: { kind: 'answer', text: 'Replacement before commit' } })),
          );
          await clearWait();
          await restarted.processTurn(workspaceId, id);
          release();
          await work;
          const rows = await attempts(id);
          assert.equal(rows.length, 2);
          assert.equal(rows[0].status, 'abandoned');
          assert.equal(rows[0].usage.kind, 'known');
          assert.equal(rows[0].outcome.kind, 'late');
          assert.equal((await restarted.read(workspaceId, ownerUserId, agentId, id)).text, 'Replacement before commit');
          assert.equal(
            (
              await owner.query(
                `SELECT count(*)::integer AS n FROM ${table('tf_model_generations')} WHERE run_id=$1 AND status='committed'`,
                [id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'retry command duplicates share a generation, competing commands conflict, private history stays private',
        async () => {
          const chat = createAgentChat(
            runtime,
            config(async () => unavailable),
          );
          const id = await submit(chat);
          await exhaust(chat, id);
          const input = { requestId: randomUUID(), expectedGeneration: 0 };
          const results = await Promise.all([
            chat.retry(workspaceId, ownerUserId, agentId, id, input),
            chat.retry(workspaceId, ownerUserId, agentId, id, input),
          ]);
          assert.deepEqual(results[0], results[1]);
          assert.equal(results[0].generation, 1);
          await assert.rejects(
            chat.retry(workspaceId, ownerUserId, agentId, id, { ...input, requestId: randomUUID() }),
            error => error.code === 'model-retry-conflict',
          );
          const success = createAgentChat(
            runtime,
            config(async () => answer),
          );
          await clearWait();
          await success.processTurn(workspaceId, id);
          assert.deepEqual(await chat.retry(workspaceId, ownerUserId, agentId, id, input), results[0]);
          await owner.query(
            `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'another-admin','admin')`,
            [randomUUID()],
          );
          await assert.rejects(chat.read(workspaceId, 'another-admin', agentId, id), AccessDenied);
          await assert.rejects(chat.retry(workspaceId, 'another-admin', agentId, id, input), AccessDenied);
        },
      );
      await t.test('committed tool keeps its call and rejects replacement even when its execution failed', async () => {
        const chat = createAgentChat(
          runtime,
          config(async () => ({
            ...answer,
            decision: { kind: 'tool', text: 'Inspect', call: { tool: 'schema.inspect', tableId } },
          })),
        );
        const id = await submit(chat);
        await clearWait();
        await chat.processTurn(workspaceId, id);
        const before = (await owner.query(`SELECT id,call FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`, [id]))
          .rows;
        assert.equal(before.length, 1);
        assert.deepEqual(before[0].call, { tool: 'schema.inspect', tableId });
        await owner.query(`UPDATE ${table('tf_agent_chat_turns')} SET status='failed' WHERE id=$1`, [id]);
        await assert.rejects(
          chat.retry(workspaceId, ownerUserId, agentId, id, { requestId: randomUUID(), expectedGeneration: 0 }),
          error => error.code === 'model-retry-conflict',
        );
        await owner.query(`UPDATE ${table('tf_agent_chat_turns')} SET status='tool' WHERE id=$1`, [id]);
        await createAgentChat(runtime, null).processTurn(workspaceId, id);
        assert.deepEqual(
          (await owner.query(`SELECT id,call FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`, [id])).rows,
          before,
        );
        assert.equal((await attempts(id)).length, 1);
      });
      await t.test('nonavailability failures never switch models and zero budget makes no outbound call', async () => {
        await owner.query(`UPDATE ${table('tf_credit_account')} SET available=1000000000000000`);
        await rule('gpt-astra');
        for (const reason of ['authentication', 'quota', 'refusal', 'invalid-decision', 'context-overflow']) {
          let count = 0;
          const chat = createAgentChat(
            runtime,
            config(async () => {
              count++;
              return { ...unavailable, reason };
            }),
          );
          const id = await submit(chat);
          await exhaust(chat, id);
          assert.equal(count, 1);
        }
        const chat = createAgentChat(runtime, {
          ...config(async () => {
            assert.fail('budget allowed a request');
          }),
          budgetPicoUsd: () => '0',
        });
        const id = await submit(chat);
        await exhaust(chat, id);
        assert.equal((await attempts(id)).length, 0);
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).model.failure, 'budget');
      });
      await t.test('deadline and live authority fences prevent results and retries', async () => {
        const chat = createAgentChat(
          runtime,
          config(async () => {
            await owner.query(`UPDATE ${table('tf_agent_runs')} SET status='cancelled' WHERE id=$1`, [id]);
            return answer;
          }),
        );
        const id = await submit(chat);
        await clearWait();
        await chat.processTurn(workspaceId, id);
        assert.equal(
          (await owner.query(`SELECT decision FROM ${table('tf_agent_chat_turns')} WHERE id=$1`, [id])).rows[0]
            .decision,
          null,
        );
        await assert.rejects(
          chat.retry(workspaceId, ownerUserId, agentId, id, { requestId: randomUUID(), expectedGeneration: 0 }),
          AccessDenied,
        );
        const bounded = createAgentChat(
          runtime,
          config(async () => {
            assert.fail('expired generation dispatched');
          }),
        );
        const expired = await submit(bounded);
        await owner.query(
          `UPDATE ${table('tf_model_generations')} SET deadline=clock_timestamp()-interval '1 second' WHERE run_id=$1`,
          [expired],
        );
        await bounded.processTurn(workspaceId, expired);
        assert.equal((await attempts(expired)).length, 0);
        assert.equal((await bounded.read(workspaceId, ownerUserId, agentId, expired)).model.failure, 'deadline');
      });
      await t.test('identity mismatch cannot commit or claim known pricing', async () => {
        const chat = createAgentChat(
          runtime,
          config(async () => ({ ...answer, actualModel: 'unexpected-model' })),
        );
        const id = await submit(chat);
        await clearWait();
        await chat.processTurn(workspaceId, id);
        const result = await chat.read(workspaceId, ownerUserId, agentId, id);
        assert.equal(result.status, 'failed');
        assert.equal(result.model.failure, 'model-identity-mismatch');
        assert.deepEqual((await attempts(id))[0].cost, { kind: 'unknown', reason: 'invalid' });
      });
      await t.test('unknown abandoned usage keeps reservation and prevents restart spending', async () => {
        let entered, release;
        const started = new Promise(resolve => {
          entered = resolve;
        });
        const gate = new Promise(resolve => {
          release = resolve;
        });
        const settings = config(async () => {
          entered();
          await gate;
          return unavailable;
        });
        const chat = createAgentChat(runtime, settings);
        const id = await submit(chat);
        await clearWait();
        const work = chat.processTurn(workspaceId, id);
        await started;
        const [attempt] = await attempts(id);
        await owner.query(`UPDATE ${table('tf_model_generations')} SET budget_pico_usd=$2 WHERE run_id=$1`, [
          id,
          attempt.reserved_pico_usd,
        ]);
        await owner.query(
          `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [attempt.id],
        );
        await clearWait();
        await createAgentChat(runtime, {
          ...settings,
          infer: async () => {
            assert.fail('abandoned reservation released');
          },
        }).processTurn(workspaceId, id);
        const rows = await attempts(id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'abandoned');
        assert.deepEqual(rows[0].usage, { kind: 'unknown', reason: 'abandoned' });
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).model.failure, 'budget');
        release();
        await work;
      });
      await t.test('Retry-After persists across restart and an oversized hint ends within the deadline', async () => {
        let calls = 0;
        const settings = config(async () => {
          calls++;
          return { ...unavailable, reason: 'rate-limit', retryAfterMs: 30000 };
        });
        const chat = createAgentChat(runtime, settings);
        const id = await submit(chat);
        await clearWait();
        await chat.processTurn(workspaceId, id);
        await createAgentChat(runtime, settings).processTurn(workspaceId, id);
        assert.equal(calls, 1);
        const wait = (
          await owner.query(
            `SELECT next_at>clock_timestamp()+interval '25 seconds' AS waiting FROM ${table('tf_model_generations')} WHERE run_id=$1`,
            [id],
          )
        ).rows[0];
        assert.equal(wait.waiting, true);
        const long = createAgentChat(
          runtime,
          config(async () => ({ ...unavailable, reason: 'rate-limit', retryAfterMs: Number.MAX_SAFE_INTEGER })),
        );
        const other = await submit(long);
        await clearWait();
        await long.processTurn(workspaceId, other);
        assert.equal((await long.read(workspaceId, ownerUserId, agentId, other)).model.failure, 'deadline');
        assert.equal(
          (
            await long.retry(workspaceId, ownerUserId, agentId, other, {
              requestId: randomUUID(),
              expectedGeneration: 0,
            })
          ).generation,
          1,
        );
      });
      await t.test(
        'attribution callback failure preserves terminal refusal rather than enabling fallback',
        async () => {
          let calls = 0;
          const chat = createAgentChat(runtime, {
            ...config(async () => {
              calls++;
              return { ...unavailable, reason: 'refusal' };
            }),
            actualModelIds: () => {
              throw new Error('identity configuration missing');
            },
          });
          const id = await submit(chat);
          await exhaust(chat, id);
          assert.equal(calls, 1);
          assert.equal((await attempts(id))[0].outcome.reason, 'refusal');
          assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).model.failure, 'refusal');
        },
      );
      await t.test(
        'current budget and grants revoke commit; removed grants prevent dispatch and conceal prior answers',
        async () => {
          let budget = '10000000000000';
          const settings = {
            ...config(async () => {
              budget = '0';
              return answer;
            }),
            budgetPicoUsd: () => budget,
          };
          const limited = createAgentChat(runtime, settings);
          const id = await submit(limited);
          await clearWait();
          await limited.processTurn(workspaceId, id);
          assert.equal((await limited.read(workspaceId, ownerUserId, agentId, id)).status, 'failed');
          const good = createAgentChat(
            runtime,
            config(async () => answer),
          );
          const previous = await submit(good);
          await clearWait();
          await good.processTurn(workspaceId, previous);
          const blocked = createAgentChat(
            runtime,
            config(async () => {
              assert.fail('revoked resource grant dispatched');
            }),
          );
          const next = await submit(blocked);
          await owner.query(`DELETE FROM ${table('tf_grants')} WHERE asset_id=$1`, [tableId]);
          await blocked.processTurn(workspaceId, next);
          assert.equal((await attempts(next)).length, 0);
          assert.equal((await good.read(workspaceId, ownerUserId, agentId, previous)).text, null);
          await owner.query(
            `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
            [teamId, tableId],
          );
        },
      );
      await t.test('legacy definitions require an explicit trusted binding', async () => {
        await owner.query(
          `UPDATE ${table('tf_agent_definitions')} SET definition=definition-'modelFamilyId' WHERE agent_id=$1`,
          [agentId],
        );
        const unresolved = createAgentChat(
          runtime,
          config(async () => answer),
        );
        await assert.rejects(submit(unresolved), error => error.code === 'legacy-model-binding-required');
        const explicit = createAgentChat(runtime, {
          ...config(async () => answer),
          defaultFamily: () => 'claude-opus',
        });
        const id = await submit(explicit);
        await clearWait();
        await explicit.processTurn(workspaceId, id);
        assert.equal((await explicit.read(workspaceId, ownerUserId, agentId, id)).status, 'answered');
      });
      await t.test('HTTP retry enforces private authorization and returns the same generation on replay', async () => {
        const require = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
        const Fastify = require('fastify');
        const { registerAgents } = await import('../../../apps/api/src/agents.ts');
        const { authConfig } = await import('../../../apps/api/src/auth.ts');
        const settings = { ...config(async () => unavailable), defaultFamily: () => 'claude-opus' };
        const chat = createAgentChat(runtime, settings);
        const id = await submit(chat);
        await exhaust(chat, id);
        const app = Fastify();
        registerAgents(app, {
          runtime,
          pool: owner,
          agentModel: settings,
          auth: {
            api: { getSession: async ({ headers }) => ({ user: { id: headers.get('x-test-user') ?? ownerUserId } }) },
          },
        });
        try {
          const url = `/workspaces/${workspaceId}/agents/${agentId}/chat/${id}/retry`;
          const payload = { requestId: randomUUID(), expectedGeneration: 0 };
          const headers = { origin: authConfig().webOrigin };
          const denied = await app.inject({
            method: 'POST',
            url,
            payload,
            headers: { ...headers, 'x-test-user': 'another-admin' },
          });
          assert.equal(denied.statusCode, 404);
          const [one, two] = await Promise.all([
            app.inject({ method: 'POST', url, payload, headers }),
            app.inject({ method: 'POST', url, payload, headers }),
          ]);
          assert.equal(one.statusCode, 200, one.body);
          assert.deepEqual(one.json(), two.json());
          assert.equal(one.json().generation, 1);
          assert.equal(
            (await app.inject({ method: 'POST', url, payload, headers: { origin: 'https://untrusted.example' } }))
              .statusCode,
            403,
          );
        } finally {
          await app.close();
        }
      });
      await t.test('request timeout respects remaining deadline and keeps late usage without a decision', async () => {
        let lateDone;
        const late = new Promise(resolve => {
          lateDone = resolve;
        });
        const settings = {
          ...config(async (_resolution, _input, timeoutMs, signal) => {
            assert.ok(timeoutMs > 0 && timeoutMs <= 1000);
            await delay(timeoutMs + 150);
            assert.equal(signal.aborted, true);
            lateDone();
            return answer;
          }),
          defaultFamily: () => 'claude-opus',
        };
        const chat = createAgentChat(runtime, settings);
        const id = await submit(chat);
        await clearWait();
        await owner.query(
          `UPDATE ${table('tf_model_generations')} SET deadline=clock_timestamp()+interval '3 seconds' WHERE run_id=$1`,
          [id],
        );
        const started = performance.now();
        await chat.processTurn(workspaceId, id);
        assert.ok(performance.now() - started < 2000);
        await late;
        for (let i = 0; i < 50 && (await attempts(id))[0].usage.kind !== 'known'; i++) await delay(20);
        const rows = await attempts(id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].usage.kind, 'known');
        assert.equal((await chat.read(workspaceId, ownerUserId, agentId, id)).text, null);
        await chat.processTurn(workspaceId, id);
        assert.equal((await attempts(id)).length, 1);
      });
      await delay(1);
    } finally {
      await runtime?.close();
      await owner.end();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (names)
        for (const role of [names.runtime, names.migration, names.confirmation, names.customOwner])
          await admin.query(`DROP ROLE "${role}"`);
      await admin.end();
    }
  },
);
