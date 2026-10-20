import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mcpFixture } from './fixture.mjs';

test('MCP recommendation events track enabled tools, not command replay, repeated discovery or repeated review', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0];
    const input = {
      requestId: randomUUID(),
      name: 'MCP',
      ownership: 'personal',
      endpoint: 'https://mcp.example.com/tools',
      credential: { kind: 'bearer', token: 'synthetic-private-mcp-secret' },
    };
    const integration = await f.service.create(f.one.id, actor, input);
    const events = async () =>
      (
        await f.db.platform.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' AND source_id=$1 ORDER BY created_at,id`,
          [integration.id],
        )
      ).rows;
    assert.deepEqual(await events(), [{ membership_ids: [actor.membershipId], invalidate: false }]);
    await f.service.create(f.one.id, actor, input);
    const discovered = await f.service.discover(f.one.id, actor, integration.id);
    assert.equal((await events()).length, 1);
    const review = discovered.map(tool => ({
      name: tool.name,
      revision: tool.discovered_revision,
      enabled: true,
      standingException: false,
    }));
    await f.service.reviewTools(f.one.id, actor, integration.id, review);
    assert.equal((await events()).length, 2);
    await f.service.reviewTools(f.one.id, actor, integration.id, [...review].reverse());
    await f.service.discover(f.one.id, actor, integration.id);
    await f.service.setLifecycle(f.one.id, actor, integration.id, 'active');
    assert.equal((await events()).length, 2);
    f.setTools(f.getTools().filter(tool => tool.name !== 'read'));
    await f.service.discover(f.one.id, actor, integration.id);
    assert.deepEqual((await events()).at(-1), { membership_ids: [actor.membershipId], invalidate: true });
    await f.service.setLifecycle(f.one.id, actor, integration.id, 'disabled');
    const count = (await events()).length;
    await f.service.setLifecycle(f.one.id, actor, integration.id, 'disabled');
    assert.equal((await events()).length, count);
  } finally {
    await f.close();
  }
});

test('MCP shared grant revocation includes former readers and identical grants retain enabled tools', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0],
      other = f.members[1];
    const integration = await f.connect(actor, 'shared');
    const events = async () =>
      (
        await f.db.platform.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' AND source_id=$1 ORDER BY created_at,id`,
          [integration.id],
        )
      ).rows;
    const count = (await events()).length;
    await f.service.setGrants(f.one.id, actor, integration.id, {
      expectedVersion: 1,
      memberIds: [actor.membershipId],
      teamIds: [],
    });
    assert.equal((await events()).length, count);
    assert.ok((await f.service.tools(f.one.id, actor, integration.id)).every(tool => tool.enabled_revision));
    await f.service.setGrants(f.one.id, actor, integration.id, {
      expectedVersion: 2,
      memberIds: [actor.membershipId, other.membershipId],
      teamIds: [],
    });
    assert.ok((await events()).at(-1).membership_ids.includes(other.membershipId));
    await f.service.setGrants(f.one.id, actor, integration.id, {
      expectedVersion: 3,
      memberIds: [actor.membershipId],
      teamIds: [],
    });
    assert.deepEqual((await events()).at(-1), { membership_ids: [other.membershipId], invalidate: true });
  } finally {
    await f.close();
  }
});

test('MCP OAuth refresh ignores token and scope-order rotation but records scope loss and failed refresh', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0];
    const credential = {
      kind: 'oauth',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      issuer: 'https://auth.example.com',
      resource: 'https://mcp.example.com/tools',
      clientId: 'client',
      authMethod: 'none',
      scopes: ['read', 'write'],
      accountId: 'account',
    };
    const integration = await f.service.create(f.one.id, actor, {
      name: 'OAuth MCP',
      ownership: 'personal',
      endpoint: credential.resource,
      credential,
    });
    const events = async () =>
      (
        await f.db.platform.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' AND source_id=$1 ORDER BY created_at,id`,
          [integration.id],
        )
      ).rows;
    const first = await f.service.claimRefresh(f.one.id, actor, integration.id);
    await f.service.completeRefresh(f.one.id, actor, integration.id, first, {
      ...credential,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      scopes: ['write', 'read', 'read'],
    });
    assert.equal((await events()).length, 1);
    const second = await f.service.claimRefresh(f.one.id, actor, integration.id);
    await f.service.completeRefresh(f.one.id, actor, integration.id, second, { ...credential, scopes: ['read'] });
    assert.deepEqual((await events()).at(-1), { membership_ids: [actor.membershipId], invalidate: true });
    const third = await f.service.claimRefresh(f.one.id, actor, integration.id);
    await f.service.failRefresh(f.one.id, actor, integration.id, third);
    assert.equal((await events()).length, 3);
    assert.equal((await events()).at(-1).invalidate, true);
  } finally {
    await f.close();
  }
});
