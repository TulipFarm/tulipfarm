import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { provisionWorkspace } from '@tulipfarm/workspace-storage/provisioning';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createIntegrationService } from '../dist/service.js';
import { registerPlatformWorkspace } from '../../workspace-storage/test/integration/fixture.mjs';
import { installExtensions } from '../../../apps/database/src/extensions.ts';

export async function fixture() {
  const workspaceId = randomUUID();
  const database = `integrations_${randomUUID().replaceAll('-', '')}`;
  const adminUrl =
    process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres';
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;
  const connectionString = databaseUrl.href;
  const owner = new Client({ connectionString });
  await owner.connect();
  const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  const passwords = { runtime: randomUUID(), migration: randomUUID(), confirmation: randomUUID() };
  let names;
  let runtime;
  async function close() {
    await runtime?.close();
    await owner.end();
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    if (names)
      for (const role of [names.runtime, names.migration, names.confirmation, names.customOwner])
        await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
  }
  try {
    await owner.query('CREATE SCHEMA app');
    await installExtensions(owner, false);
    await owner.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    names = await provisionWorkspace({
      connectionString,
      workspaceId,
      passwords,
      initialAdmin: { userId: actor.userId, membershipId: actor.membershipId },
      migrations,
    });
    await registerPlatformWorkspace(owner, workspaceId);
    const url = capability => {
      const login = new URL(connectionString);
      login.username = names[capability];
      login.password = passwords[capability];
      return login.href;
    };
    const storage = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: url('runtime') }),
    });
    // The coordinator updates application compatibility caps after combining domain migrations.
    runtime = {
      ...storage,
      transaction: (id, range, operation) =>
        storage.transaction(id, { ...range, maximum: migrations.length }, operation),
    };
    const table = name => `"${names.schema}".${name}`;
    const teamId = randomUUID();
    const otherTeamId = randomUUID();
    const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await owner.query(`INSERT INTO ${table('tf_teams')} (id, name) VALUES ($1, 'Engineering'), ($2, 'Other')`, [
      teamId,
      otherTeamId,
    ]);
    await owner.query(`INSERT INTO ${table('tf_memberships')} (id, user_id, role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
    await owner.query(`INSERT INTO ${table('tf_member_teams')} (membership_id, team_id) VALUES ($1,$2)`, [
      member.membershipId,
      teamId,
    ]);
    // An ordinary member who creates and manages integrations; admin status grants nothing here.
    const creator = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await owner.query(`INSERT INTO ${table('tf_memberships')} (id, user_id, role) VALUES ($1,$2,'member')`, [
      creator.membershipId,
      creator.userId,
    ]);
    await owner.query(
      `INSERT INTO ${table('tf_member_teams')} (membership_id, team_id, role) VALUES ($1,$2,'manager'), ($1,$3,'manager')`,
      [creator.membershipId, teamId, otherTeamId],
    );
    const keyring = { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } };
    const input = {
      id: randomUUID(),
      name: 'Triage',
      owningTeamId: teamId,
      token: 'private-test-token',
      repositories: [{ id: randomUUID(), owner: 'tulipfarm', repo: 'fixture' }],
    };
    const sourceGrant = actor => ({ memberId: actor.membershipId, sourceId: input.repositories[0].id });
    const request = () => ({
      requestId: randomUUID(),
      integrationId: input.id,
      sourceId: input.repositories[0].id,
      issueNumber: 17,
    });
    const calls = [];
    let provider = async () =>
      new Response(
        JSON.stringify({
          number: 17,
          title: 'Issue title',
          body: 'Issue body',
          state: 'open',
          secret_extra: 'ignored',
        }),
      );
    const service = createIntegrationService({
      runtime,
      keyring,
      providerFetch: async (...args) => {
        calls.push(args);
        return provider(...args);
      },
    });
    return {
      workspaceId,
      owner,
      actor,
      member,
      creator,
      teamId,
      otherTeamId,
      input,
      request,
      sourceGrant,
      service,
      runtime,
      table,
      calls,
      keyring,
      url,
      close,
      setProvider(value) {
        provider = value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
