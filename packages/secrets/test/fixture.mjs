import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AccessDenied } from '@tulipfarm/access';
import { commonCompatibility, createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { SecretError, createSecrets } from '../dist/index.js';
import { resolveForSend } from '../dist/send.js';

export const keyring = { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } };
export const code = code => error => error instanceof SecretError && error.code === code;
export const denied = error => error instanceof AccessDenied;

export async function setup() {
  const db = await fixture();
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  assert.equal(stream.length, commonCompatibility.maximum);
  const workspace = await db.create(stream);
  const table = name => qualified(workspace.names.schema, name);
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 2,
    connectionsPerPool: 4,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
  });
  const members = [];
  for (let index = 0; index < 3; index++) {
    const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
    members.push(member);
  }
  const admin = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
  let clock = new Date();
  const secrets = createSecrets({ runtime, keyring, now: () => clock });
  const input = (overrides = {}) => ({
    requestId: randomUUID(),
    name: 'PostHog',
    kind: 'api-key',
    value: { value: 'phx-synthetic-secret-value' },
    placement: { kind: 'bearer' },
    destinations: [{ kind: 'host', host: 'api.posthog.com' }],
    ...overrides,
  });
  const send = (member, secretId, url = 'https://api.posthog.com/v1/events', extra = {}) =>
    runtime.transaction(workspace.id, commonCompatibility, tx =>
      resolveForSend(secrets, tx, {
        workspaceId: workspace.id,
        membershipId: member.membershipId,
        secret: { kind: 'secret', secretId, ...extra.secret },
        url,
        expected: extra.expected,
      }),
    );
  return {
    db,
    workspace,
    table,
    runtime,
    members,
    admin,
    secrets,
    input,
    send,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
    async close() {
      await runtime.close();
      await db.close();
    },
  };
}
