import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '../../conversations/src/index.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createChatTools } from '../src/tools.ts';

test('in a chat that is not the member’s own, calls with secrets or to private hosts are refused unsent', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const owner = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const guest = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  await db.platform.query(
    `INSERT INTO "${w.names.schema}"."tf_memberships" (id,user_id,role) VALUES ($1,$2,'member')`,
    [guest.membershipId, guest.userId],
  );
  const chatId = randomUUID();
  await createConversations(runtime).create(w.id, w.userId, { chatId, commandId: randomUUID() });

  const uses = [];
  const tools = createChatTools(runtime, {
    apiSecrets: () => ({
      resolve: async () => ({
        secretId: randomUUID(),
        name: 'Billing token',
        version: 1,
        policyVersion: 1,
        placement: { kind: 'bearer' },
        value: { value: 'billing-0123456789' },
      }),
      recordUse: async (secretId, url) => uses.push({ secretId, url }),
    }),
    apiPrivateHosts: [{ host: 'metrics.invalid', port: null, http: false }],
  });
  const call = (actor, extra) =>
    tools.invokeWithSources(
      {
        workspaceId: w.id,
        actor,
        callId: randomUUID(),
        origin: { conversationId: chatId, turnId: randomUUID(), sources: [] },
      },
      { tool: 'api.request', method: 'GET', ...extra },
    );

  const secret = await call(guest, { url: 'https://api.example.com/v1', secrets: [{ variable: 'BILLING_TOKEN' }] });
  assert.equal(secret.result.code, 'unavailable');
  assert.equal(secret.result.secret, 'Billing token');
  assert.match(secret.result.message, /Nothing was sent/);
  const privateHost = await call(guest, { url: 'https://metrics.invalid/q' });
  assert.equal(privateHost.result.code, 'unavailable');
  assert.equal(uses.length, 0);

  // In the member's own chat the same call passes the check and goes on to the network.
  assert.notEqual((await call(owner, { url: 'https://metrics.invalid/q' })).result.code, 'unavailable');
});
