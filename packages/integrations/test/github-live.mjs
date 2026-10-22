import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { provisionWorkspace, workspaceNames } from '@tulipfarm/workspace-storage/provisioning';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createIntegrationService } from '../dist/service.js';
import { createAgentExecutor } from '../../agents/dist/executor.js';
import { createSoulAgentFixture, policyVersion } from '../../agents/test/soul-fixture.mjs';

export function check(condition, description) {
  if (!condition) throw new Error(description);
}

function github(args) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'GH_CONFIG_DIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]),
    );
    execFile('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, env }, (error, stdout) => {
      if (error) reject(new Error('GitHub read unavailable'));
      else resolve(stdout);
    });
  });
}

export function noDisclosure(text, values) {
  for (const value of values.filter(Boolean)) {
    check(!text.includes(value), 'Private value disclosed');
    check(!text.includes(Buffer.from(value).toString('base64')), 'Encoded private value disclosed');
    check(!text.includes(JSON.stringify(value).slice(1, -1)), 'Escaped private value disclosed');
  }
}

export async function denied(operation) {
  let rejected = false;
  try {
    await operation();
  } catch (error) {
    rejected = error?.message === 'Resource not found';
  }
  check(rejected, 'Expected access denial');
}

export async function withLiveIntegration(operation) {
  const workspaceId = randomUUID();
  const names = workspaceNames(workspaceId);
  const database = `integration_acceptance_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres' });
  const ownerURL = `postgresql://postgres:local-postgres@127.0.0.1:5432/${database}`;
  const owner = new Client({ connectionString: ownerURL });
  let runtime;
  let soul;
  let databaseCreated = false;
  let adminConnected = false;
  let cleanupFailed = false;
  try {
    await admin.connect();
    adminConnected = true;
    await admin.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    await owner.connect();
    await owner.query('CREATE SCHEMA app');
    await owner.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const passwords = { runtime: randomUUID(), migration: randomUUID(), confirmation: randomUUID() };
    const migrations = [...(await workspaceTableMigrations())].sort((a, b) => a.name.localeCompare(b.name));
    check(migrations.length === 1, 'Expected single baseline migration');
    await provisionWorkspace({ connectionString: ownerURL, workspaceId, passwords, initialAdmin: actor, migrations });
    const runtimeURL = `postgresql://${names.runtime}:${passwords.runtime}@127.0.0.1:5432/${database}`;
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        check(id === workspaceId, 'Unexpected workspace');
        return { workspaceId, generation: 1, connectionString: runtimeURL };
      },
    });
    const table = name => `"${names.schema}".${name}`;
    soul = await createSoulAgentFixture({ runtime, owner, table, workspaceId, createdBy: actor.userId });
    const receipts = (await owner.query(`SELECT name FROM ${table('tf_common_migrations')} ORDER BY name`)).rows.map(
      row => row.name,
    );
    check(
      JSON.stringify(receipts) === JSON.stringify(migrations.map(migration => migration.name)),
      'Migration receipts differ',
    );
    const teamId = randomUUID();
    await owner.query(`INSERT INTO ${table('tf_teams')} (id, name) VALUES ($1, 'Acceptance')`, [teamId]);
    await owner.query(`INSERT INTO ${table('tf_memberships')} (id, user_id, role) VALUES ($1, $2, 'member')`, [
      member.membershipId,
      member.userId,
    ]);
    await owner.query(`INSERT INTO ${table('tf_member_teams')} (membership_id, team_id) VALUES ($1, $2)`, [
      member.membershipId,
      teamId,
    ]);
    const reference = JSON.parse(
      await github([
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        'repos/TulipFarm/tulipfarm-cloud/issues/5',
        '--jq',
        '{number, state}',
      ]),
    );
    check(reference.number === 5 && ['open', 'closed'].includes(reference.state), 'Unexpected GitHub issue');
    const token = (await github(['auth', 'token', '--hostname', 'github.com'])).trim();
    check(token.length > 0, 'GitHub credential unavailable');
    const key = randomBytes(32).toString('hex');
    const service = createIntegrationService({
      runtime,
      keyring: { activeKeyId: 'acceptance', keys: { acceptance: key } },
    });
    const input = {
      id: randomUUID(),
      name: 'Read-only acceptance',
      owningTeamId: teamId,
      token,
      repositories: [{ id: randomUUID(), owner: 'TulipFarm', repo: 'tulipfarm-cloud' }],
    };
    const created = await service.create(workspaceId, actor, input);
    check(created.generation === 1, 'Integration creation failed');
    const secrets = [token, key, passwords.runtime, runtimeURL];
    noDisclosure(JSON.stringify(created), secrets);
    const grants = {
      grants: [{ teamId, permissions: ['read', 'use'] }],
      sourceGrants: [{ teamId, sourceId: input.repositories[0].id }],
    };
    const scope = [
      { assetId: input.id, permissions: ['integration.read', 'integration.use'] },
      { assetId: input.repositories[0].id, permissions: ['github.issue.read'] },
    ];
    const request = () => ({
      requestId: randomUUID(),
      integrationId: input.id,
      sourceId: input.repositories[0].id,
      issueNumber: 5,
    });
    await operation({
      workspaceId,
      owner,
      runtime,
      runtimeURL,
      actor,
      member,
      teamId,
      service,
      input,
      grants,
      scope,
      request,
      table,
      secrets,
      key,
      reference,
      saveAgent: soul.save,
    });
  } finally {
    async function cleanup(action) {
      try {
        await action();
      } catch {
        cleanupFailed = true;
      }
    }
    await cleanup(async () => soul?.close());
    await cleanup(async () => runtime?.close());
    await cleanup(() => owner.end());
    if (adminConnected) {
      if (databaseCreated) await cleanup(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`));
      for (const role of [names.runtime, names.migration, names.confirmation, names.customOwner]) {
        await cleanup(() => admin.query(`DROP ROLE IF EXISTS "${role}"`));
      }
      const remaining = await admin
        .query(
          'SELECT 1 FROM pg_database WHERE datname = $1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname = ANY($2)',
          [database, [names.runtime, names.migration, names.confirmation, names.customOwner]],
        )
        .catch(() => {
          cleanupFailed = true;
        });
      if (remaining?.rowCount) cleanupFailed = true;
    }
    await cleanup(() => admin.end());
    check(!cleanupFailed, 'Disposable database cleanup failed');
  }
}

export async function prepareAgent(f, executor = createAgentExecutor({ runtime: f.runtime, integrations: f.service })) {
  const agentId = randomUUID();
  const definition = await f.saveAgent(f.workspaceId, f.actor, agentId, f.teamId, {
    name: 'Read-only acceptance',
    instructions: 'Read the permitted issue',
    tools: ['github.issue.read'],
  });
  await f.owner.query(
    `INSERT INTO ${f.table('tf_agent_grants')} (team_id, agent_id, permission) VALUES ($1, $2, 'read'), ($1, $2, 'invoke')`,
    [f.teamId, agentId],
  );
  const activation = await executor.activate(f.workspaceId, f.actor, {
    agentId,
    revision: definition.revision,
    scope: f.scope,
  });
  await executor.configure(f.workspaceId, f.actor, {
    agentId,
    version: await policyVersion(f.owner, f.table, agentId),
    enabled: true,
    teamIds: [f.teamId],
    limits: f.scope,
  });
  async function queue(scope = f.scope, sequence = 0, runId) {
    runId ??= (await executor.startDelegated(f.workspaceId, f.member, { activationId: activation.activationId, scope }))
      .runId;
    const ids = { workspaceId: f.workspaceId, runId, callId: randomUUID() };
    await executor.queueCall(f.workspaceId, f.member, {
      runId,
      callId: ids.callId,
      sequence,
      call: {
        tool: 'github.issue.read',
        integrationId: f.input.id,
        sourceId: f.input.repositories[0].id,
        issueNumber: 5,
      },
    });
    return ids;
  }
  return { executor, agentId, activation, queue };
}

async function main() {
  let stage = 'fixture and credential lookup';
  try {
    let summary;
    await withLiveIntegration(async f => {
      const { workspaceId: w, service: s, input: i } = f;
      stage = 'source permission denial';
      await s.setGrants(w, f.actor, i.id, { ...f.grants, expectedGrantsVersion: 1, sourceGrants: [] });
      await denied(() => s.readIssue(w, f.member, f.request()));
      check(
        (await f.owner.query(`SELECT count(*)::int AS n FROM ${f.table('tf_integration_dispatches')}`)).rows[0].n === 0,
        'Denied read dispatched',
      );
      await s.setGrants(w, f.actor, i.id, { ...f.grants, expectedGrantsVersion: 2 });
      stage = 'default fetch human read';
      const issue = await s.readIssue(w, f.member, f.request());
      check(issue.number === 5 && issue.state === f.reference.state, 'Live issue mismatch');
      check(typeof issue.title === 'string' && typeof issue.body === 'string', 'Live issue fields missing');
      stage = 'exact persisted agent read';
      const agent = await prepareAgent(f);
      const ids = await agent.queue();
      await denied(() => s.readIssue(w, { kind: 'agent', runId: ids.runId }, f.request()));
      check((await agent.executor.execute(ids)) === 'completed', 'Agent read failed');
      const result = await agent.executor.readResult(ids, f.member);
      check(result.result.number === 5 && result.result.state === issue.state, 'Agent result mismatch');
      stage = 'missing agent scope denial';
      check(
        (await agent.executor.execute(await agent.queue([f.scope[0]]))) === 'blocked',
        'Missing source scope allowed',
      );
      await agent.executor.configure(w, f.actor, {
        agentId: agent.agentId,
        version: await policyVersion(f.owner, f.table, agent.agentId),
        enabled: true,
        teamIds: [f.teamId],
        limits: [f.scope[0]],
      });
      check((await agent.executor.execute(await agent.queue())) === 'blocked', 'Missing source limit allowed');
      stage = 'same-token rotation and reread';
      const before = JSON.stringify(
        (await f.owner.query(`SELECT credential FROM ${f.table('tf_integrations')} WHERE id = $1`, [i.id])).rows[0]
          .credential,
      );
      const rotated = await s.rotate(w, f.actor, i.id, { expectedGeneration: 1, token: i.token });
      check(rotated.generation === 2, 'Rotation did not advance generation');
      const request = f.request();
      const reread = await s.readIssue(w, f.member, request);
      check(reread.number === 5 && reread.state === issue.state, 'Rotated read mismatch');
      const row = (
        await f.owner.query(`SELECT credential, generation FROM ${f.table('tf_integrations')} WHERE id = $1`, [i.id])
      ).rows[0];
      check(row.generation === 2 && JSON.stringify(row.credential) !== before, 'Credential envelope was not rotated');
      check(
        (
          await f.owner.query(`SELECT generation FROM ${f.table('tf_integration_dispatches')} WHERE request_id = $1`, [
            request.requestId,
          ])
        ).rows[0].generation === 2,
        'Read used old generation',
      );
      stage = 'credential nondisclosure';
      const persisted = await f.owner.query(
        `SELECT row_to_json(c) FROM ${f.table('tf_integrations')} c UNION ALL SELECT row_to_json(d) FROM ${f.table('tf_integration_dispatches')} d UNION ALL SELECT row_to_json(t) FROM ${f.table('tf_agent_tool_calls')} t UNION ALL SELECT row_to_json(a) FROM ${f.table('tf_audit_events')} a`,
      );
      noDisclosure(JSON.stringify([persisted.rows, rotated, result]), f.secrets);
      check(
        (await f.owner.query(`SELECT count(*)::int AS n FROM ${f.table('tf_integration_dispatches')}`)).rows[0].n === 3,
        'Unexpected provider dispatch count',
      );
      summary = { number: reread.number, state: reread.state };
      stage = 'cleanup';
    });
    console.log(`github-live PASS ${JSON.stringify(summary)}`);
  } catch {
    console.error(`github-live FAIL at ${stage}; details suppressed`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
