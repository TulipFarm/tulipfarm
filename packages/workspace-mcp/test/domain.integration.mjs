import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mcpFixture } from './fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('fresh and populated migrations, restricted SQL, owner privacy and explicit grants', async () => {
  const f = await mcpFixture();
  try {
    const personal = await f.connect();
    for (const actor of [f.admin, f.members[1]]) {
      assert.deepEqual(await f.service.list(f.one.id, actor), []);
      await assert.rejects(f.service.status(f.one.id, actor, personal.id), /Resource not found/);
    }
    const sql = statement => f.runtime.transaction(f.one.id, commonCompatibility, tx => tx.client.query(statement));
    await assert.rejects(sql(`SELECT * FROM ${f.table('integrations', f.two)}`), error => error.code === '42501');
    for (const table of ['actions', 'decisions', 'claims', 'receipts', 'reconciliations', 'tool_revisions']) {
      await assert.rejects(sql(`DELETE FROM ${f.table(table)}`), error => error.code === '42501');
      await assert.rejects(
        sql(
          `UPDATE ${f.table(table)} SET ${table === 'tool_revisions' ? 'name=name' : table === 'actions' || table === 'reconciliations' ? 'id=id' : 'action_id=action_id'}`,
        ),
        error => error.code === '42501',
      );
    }
    for (const table of ['decisions', 'reconciliations'])
      await assert.rejects(sql(`INSERT INTO ${f.table(table)} DEFAULT VALUES`), error => error.code === '42501');
    const stored = (
      await f.db.platform.query(`SELECT credential FROM ${f.table('integrations')} WHERE id=$1`, [personal.id])
    ).rows[0];
    assert.ok(!JSON.stringify(stored).includes('synthetic-private-mcp-secret'));
    const shared = await f.connect(f.admin, 'shared');
    await assert.rejects(f.select(shared, f.members[1]), /Resource not found/);
    const teamId = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'MCP users')`, [teamId]);
    await assert.rejects(
      f.service.setGrants(f.one.id, f.admin, shared.id, { expectedVersion: 1, memberIds: [], teamIds: [teamId] }),
      /Resource not found/,
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2),($3,$2)`,
      [f.members[1].membershipId, teamId, f.admin.membershipId],
    );
    await f.service.setGrants(f.one.id, f.admin, shared.id, {
      expectedVersion: 1,
      memberIds: [f.members[0].membershipId],
      teamIds: [teamId],
    });
    for (const actor of f.members)
      assert.equal((await f.service.status(f.one.id, actor, shared.id)).capabilities.use, true);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.members[0].membershipId,
    ]);
    const rejoined = { ...f.members[0], membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      rejoined.membershipId,
      rejoined.userId,
    ]);
    await assert.rejects(f.service.status(f.one.id, rejoined, personal.id), /Resource not found/);
    await assert.rejects(f.service.status(f.one.id, rejoined, shared.id), /Resource not found/);
    await assert.rejects(f.service.status(f.one.id, f.members[0], personal.id), /Resource not found/);
  } finally {
    await f.close();
  }
});

test('private input requires exact confirmation despite standing policy, dispatch once and retain protected receipt', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect();
    const action = await f.propose(integration);
    assert.equal(action.status, 'awaiting-approval');
    assert.equal(action.requiresConsent, true);
    await assert.rejects(f.service.dispatch(f.one.id, action.id), /approval-required/);
    await assert.rejects(
      f.service.decide(f.one.id, f.members[1], action.id, { digest: action.digest, decision: 'approve' }),
      /Resource not found/,
    );
    await assert.rejects(
      f.service.decide(f.one.id, f.members[0], action.id, { digest: 'changed', decision: 'approve' }),
      /conflict/,
    );
    await f.approve(action);
    const outcomes = await Promise.all([
      f.service.dispatch(f.one.id, action.id),
      f.make().dispatch(f.one.id, action.id),
    ]);
    assert.ok(outcomes.every(outcome => ['succeeded', 'dispatched'].includes(outcome.status)));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].arguments, { text: 'private input' });
    const claim = (
      await f.db.platform.query(`SELECT deadline FROM ${f.table('claims')} WHERE action_id=$1`, [action.id])
    ).rows[0];
    assert.equal(f.calls[0].deadline, claim.deadline.getTime());
    assert.equal(
      (await f.service.action(f.one.id, f.members[0], action.id)).receipt.result.content[0].text,
      'provider result',
    );
    assert.equal((await f.make().dispatch(f.one.id, action.id)).status, 'succeeded');
    assert.equal(f.calls.length, 1);
    await f.service.setLifecycle(f.one.id, f.members[0], integration.id, 'disabled');
    await assert.rejects(f.service.action(f.one.id, f.members[0], action.id), /integration-unavailable/);
    await assert.rejects(
      f.service.requireSource(f.one.id, f.members[0], {
        kind: 'mcp-integration',
        integrationId: integration.id,
        authorizationEpoch: 1,
      }),
    );
  } finally {
    await f.close();
  }
});

test('drift invalidates only changed tool, expired approvals cannot dispatch and source revocation blocks disclosure', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect();
    const action = await f.propose(integration);
    await f.approve(action);
    f.setTools(
      f.getTools().map(tool => (tool.name === 'write' ? { ...tool, description: 'Changed instructions' } : tool)),
    );
    await assert.rejects(f.service.dispatch(f.one.id, action.id), /incompatible-tool/);
    assert.equal(f.calls.length, 0);
    const policies = await f.service.tools(f.one.id, f.members[0], integration.id);
    assert.equal(policies.find(tool => tool.name === 'write').standing_exception, false);
    assert.ok(policies.find(tool => tool.name === 'read').enabled_revision);
    const expired = await f.propose(integration, f.members[0], undefined, 'read');
    await f.approve(expired);
    await f.db.platform.query(
      `UPDATE ${f.table('actions')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [expired.id],
    );
    await assert.rejects(f.service.dispatch(f.one.id, expired.id), /expired/);
    const origin = f.origin();
    const tableId = randomUUID();
    f.sources.add(tableId);
    f.origins.get(origin.conversationId).sources = [{ kind: 'table', tableId }];
    await f.select(integration, f.members[0], origin);
    const protectedAction = await f.propose(integration, f.members[0], origin, 'read');
    await f.approve(protectedAction);
    f.sources.delete(tableId);
    await assert.rejects(f.service.dispatch(f.one.id, protectedAction.id), /source denied/);
    await assert.rejects(f.service.action(f.one.id, f.members[0], protectedAction.id), /source denied/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('unknown outcomes barrier the integration, observations never rewrite receipts and claims never replay', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect();
    const action = await f.propose(integration);
    await f.approve(action);
    f.setCall(async () => {
      throw new Error('provider may have executed synthetic-private-mcp-secret');
    });
    assert.deepEqual(await f.service.dispatch(f.one.id, action.id), { id: action.id, status: 'outcome-unknown' });
    assert.equal((await f.service.status(f.one.id, f.members[0], integration.id)).blocked, true);
    const origin = await f.select(integration);
    assert.equal((await f.service.catalog(f.one.id, f.members[0], origin)).tools.length, 0);
    await f.service.reconcile(f.one.id, f.members[0], action.id, {
      observation: 'still-unknown',
      notes: 'No reliable external evidence yet',
    });
    assert.equal((await f.service.status(f.one.id, f.members[0], integration.id)).blocked, true);
    await f.service.replaceCredential(f.one.id, f.members[0], integration.id, {
      expectedSecretVersion: 1,
      credential: { kind: 'none' },
    });
    assert.equal((await f.service.status(f.one.id, f.members[0], integration.id)).blocked, true);
    await f.service.reconcile(f.one.id, f.members[0], action.id, {
      observation: 'not-performed',
      notes: 'Checked the external audit log',
    });
    assert.equal((await f.service.status(f.one.id, f.members[0], integration.id)).blocked, false);
    assert.equal((await f.make().dispatch(f.one.id, action.id)).status, 'outcome-unknown');
    assert.equal(f.calls.length, 1);
    const receipt = (await f.db.platform.query(`SELECT * FROM ${f.table('receipts')} WHERE action_id=$1`, [action.id]))
      .rows[0];
    assert.equal(receipt.status, 'outcome-unknown');
    assert.equal(receipt.result, null);
    assert.ok(!JSON.stringify(receipt).includes('synthetic-private-mcp-secret'));
  } finally {
    await f.close();
  }
});

test('crash after claim and after provider success before receipt commit recovers without replay', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect();
    const action = await f.propose(integration);
    await f.approve(action);
    await f.runtime.transaction(f.one.id, commonCompatibility, tx =>
      tx.client.query(
        `INSERT INTO ${f.table('claims')} (action_id,integration_id,token,deadline) VALUES ($1,$2,$3,clock_timestamp()-interval '1 second')`,
        [action.id, integration.id, randomUUID()],
      ),
    );
    assert.deepEqual(await f.make().recover(f.one.id), { recovered: 1 });
    assert.equal((await f.service.dispatch(f.one.id, action.id)).status, 'outcome-unknown');
    assert.equal(f.calls.length, 0);
    await f.service.reconcile(f.one.id, f.members[0], action.id, {
      observation: 'not-performed',
      notes: 'Verified no provider operation',
    });
    const next = await f.propose(integration);
    await f.approve(next);
    let failReceipt = true;
    const failingRuntime = {
      transaction: (workspaceId, range, operation) =>
        f.runtime.transaction(workspaceId, range, tx =>
          operation({
            ...tx,
            client: {
              query: (sql, values) => {
                if (failReceipt && sql.startsWith('INSERT INTO') && sql.includes('tf_mcp_receipts')) {
                  failReceipt = false;
                  throw new Error('process lost before receipt commit');
                }
                return tx.client.query(sql, values);
              },
            },
          }),
        ),
    };
    await assert.rejects(f.make({ runtime: failingRuntime }).dispatch(f.one.id, next.id), /process lost/);
    assert.equal(f.calls.length, 1);
    await f.db.platform.query(
      `UPDATE ${f.table('claims')} SET deadline=clock_timestamp()-interval '1 second' WHERE action_id=$1`,
      [next.id],
    );
    assert.equal((await f.make().dispatch(f.one.id, next.id)).status, 'outcome-unknown');
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('revocation while a call is in flight retains evidence and prevents publication', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect();
    const action = await f.propose(integration);
    await f.approve(action);
    let entered;
    const started = new Promise(resolve => {
      entered = resolve;
    });
    let finish;
    f.setCall(() => {
      entered();
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const pending = f.service.dispatch(f.one.id, action.id);
    await started;
    await f.service.setLifecycle(f.one.id, f.members[0], integration.id, 'disconnected');
    finish({ content: [{ type: 'text', text: 'private completed output' }] });
    assert.equal((await pending).status, 'succeeded');
    await assert.rejects(f.service.action(f.one.id, f.members[0], action.id), /integration-unavailable/);
    assert.equal(
      (await f.db.platform.query(`SELECT result FROM ${f.table('receipts')} WHERE action_id=$1`, [action.id])).rows[0]
        .result.content[0].text,
      'private completed output',
    );
  } finally {
    await f.close();
  }
});

test('paused claim transaction return cannot send after deadline recovery and reconciliation', async () => {
  const f = await mcpFixture();
  const committed = Promise.withResolvers(),
    resume = Promise.withResolvers();
  let pending;
  try {
    const integration = await f.connect();
    const action = await f.propose(integration);
    await f.approve(action);
    const runtime = {
      transaction: async (...args) => {
        const result = await f.runtime.transaction(...args);
        if (result?.token && result?.action) {
          committed.resolve();
          await resume.promise;
        }
        return result;
      },
    };
    pending = f.make({ runtime }).dispatch(f.one.id, action.id);
    await committed.promise;
    await delay(31_100);
    assert.deepEqual(await f.make().recover(f.one.id), { recovered: 1 });
    assert.equal(f.calls.length, 0);
    assert.equal((await f.service.status(f.one.id, f.members[0], integration.id)).blocked, true);
    await f.service.reconcile(f.one.id, f.members[0], action.id, {
      observation: 'not-performed',
      notes: 'No request reached the provider',
    });
    assert.equal((await f.service.status(f.one.id, f.members[0], integration.id)).blocked, false);
    resume.resolve();
    assert.deepEqual(await pending, { id: action.id, status: 'outcome-unknown' });
    assert.equal(f.calls.length, 0, 'expired reconciled dispatcher must never send');
    assert.deepEqual(await f.make().dispatch(f.one.id, action.id), { id: action.id, status: 'outcome-unknown' });
    assert.equal(f.calls.length, 0);
    const receipt = await f.service.action(f.one.id, f.members[0], action.id);
    assert.equal(receipt.receipt.status, 'outcome-unknown');
    assert.equal(receipt.receipt.result, null);
  } finally {
    resume.resolve();
    await pending?.catch(() => undefined);
    await f.close();
  }
});

test('transport authorization refuses a claim after integration revocation during protocol preparation', async () => {
  const f = await mcpFixture();
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  let pending,
    sends = 0;
  try {
    const integration = await f.connect();
    const action = await f.propose(integration);
    await f.approve(action);
    const service = f.make({
      protocol: {
        ...f.options.protocol,
        call: async input => {
          entered.resolve();
          await resume.promise;
          await input.authorize();
          sends++;
          return { content: [{ type: 'text', text: 'sent' }] };
        },
      },
    });
    pending = service.dispatch(f.one.id, action.id);
    await entered.promise;
    await f.service.setLifecycle(f.one.id, f.members[0], integration.id, 'disconnected');
    resume.resolve();
    assert.deepEqual(await pending, { id: action.id, status: 'outcome-unknown' });
    assert.equal(sends, 0);
    assert.equal((await f.service.status(f.one.id, f.members[0], integration.id)).blocked, true);
  } finally {
    resume.resolve();
    await pending?.catch(() => undefined);
    await f.close();
  }
});

test('OAuth one-use state, secret-version refresh continuity, and changed account epochs', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect();
    const credential = {
      kind: 'oauth',
      accessToken: 'first-access-secret',
      refreshToken: 'first-refresh-secret',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      issuer: 'https://auth.example.com/',
      resource: integration.endpoint,
      clientId: 'client',
      authMethod: 'none',
      scopes: ['read'],
      accountId: 'account-one',
    };
    const sessionId = 'session-binding-test-0001';
    const started = await f.service.beginOAuth(f.one.id, f.members[0], integration.id, {
      sessionId,
      material: { verifier: 'secret-pkce-verifier', issuer: credential.issuer },
    });
    await assert.rejects(
      f.service.consumeOAuth(f.one.id, f.members[0], { state: started.state, sessionId: 'different-session-0001' }),
      /oauth-conflict/,
    );
    const consumed = await f.service.consumeOAuth(f.one.id, f.members[0], { state: started.state, sessionId });
    assert.equal(consumed.material.verifier, 'secret-pkce-verifier');
    await assert.rejects(
      f.service.consumeOAuth(f.one.id, f.members[0], { state: started.state, sessionId }),
      /oauth-conflict/,
    );
    const connected = await f.service.completeOAuth(f.one.id, f.members[0], started.attemptId, credential);
    const claims = await Promise.allSettled([
      f.service.claimRefresh(f.one.id, f.members[0], integration.id),
      f.make().claimRefresh(f.one.id, f.members[0], integration.id),
    ]);
    assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
    const claim = claims.find(result => result.status === 'fulfilled').value;
    const refreshed = await f.service.completeRefresh(f.one.id, f.members[0], integration.id, claim, {
      ...credential,
      accessToken: 'second-access-secret',
      refreshToken: 'second-refresh-secret',
    });
    assert.equal(refreshed.authorizationEpoch, connected.authorizationEpoch);
    assert.equal(refreshed.secretVersion, connected.secretVersion + 1);
    const next = await f.service.claimRefresh(f.one.id, f.members[0], integration.id);
    const switched = await f.service.completeRefresh(f.one.id, f.members[0], integration.id, next, {
      ...credential,
      accountId: 'account-two',
    });
    assert.equal(switched.authorizationEpoch, connected.authorizationEpoch + 1);
    const dump = await f.db.platform.query(
      `SELECT to_jsonb(c) AS value FROM ${f.table('integrations')} c UNION ALL SELECT to_jsonb(a) FROM ${f.table('oauth_attempts')} a`,
    );
    for (const secret of [
      credential.accessToken,
      credential.refreshToken,
      'secret-pkce-verifier',
      started.state,
      sessionId,
    ])
      assert.ok(!JSON.stringify(dump.rows).includes(secret));
  } finally {
    await f.close();
  }
});

test('shared claims serialize across requesters and a departed requester leaves the integration paused without admin recovery', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect(f.admin, 'shared');
    await f.service.setGrants(f.one.id, f.admin, integration.id, {
      expectedVersion: 1,
      memberIds: f.members.map(member => member.membershipId),
      teamIds: [],
    });
    await f.service.reviewTools(
      f.one.id,
      f.admin,
      integration.id,
      (await f.service.tools(f.one.id, f.admin, integration.id)).map(tool => ({
        name: tool.name,
        revision: tool.discovered_revision,
        enabled: true,
        standingException: false,
      })),
    );
    const first = await f.propose(integration, f.members[0]);
    const second = await f.propose(integration, f.members[1]);
    await f.approve(first, f.members[0]);
    await f.approve(second, f.members[1]);
    let entered;
    const started = new Promise(resolve => {
      entered = resolve;
    });
    let fail;
    f.setCall(() => {
      entered();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });
    const executing = f.service.dispatch(f.one.id, first.id);
    await started;
    await assert.rejects(f.make().dispatch(f.one.id, second.id), /integration-blocked/);
    fail(new Error('unknown'));
    assert.equal((await executing).status, 'outcome-unknown');
    assert.deepEqual(await f.service.recoveryActions(f.one.id, f.admin, integration.id), []);
    await assert.rejects(f.service.action(f.one.id, f.admin, first.id), /Resource not found/);
    await assert.rejects(
      f.service.reconcile(f.one.id, f.admin, first.id, {
        observation: 'completed',
        notes: 'Admin cannot reconcile a current requester',
      }),
      /Resource not found/,
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.members[0].membershipId,
    ]);
    assert.deepEqual(await f.service.recoveryActions(f.one.id, f.admin, integration.id), []);
    await assert.rejects(f.service.actionStatus(f.one.id, f.admin, first.id), /Resource not found/);
    await assert.rejects(
      f.service.reconcile(f.one.id, f.admin, first.id, {
        observation: 'completed',
        notes: 'Admin cannot take over a departed requester',
      }),
      /Resource not found/,
    );
    assert.equal((await f.service.status(f.one.id, f.admin, integration.id)).blocked, true);
    await assert.rejects(f.make().dispatch(f.one.id, second.id), /integration-blocked/);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('named tasks require approved descriptors, exact tool revisions, private bindings, and current origin authority', async () => {
  const f = await mcpFixture();
  try {
    const integrations = await Promise.all(f.members.map(member => f.connect(member)));
    const taskOrigins = f.members.map(member => f.origin(member, 'named-task'));
    const policy = (await f.service.tools(f.one.id, f.members[0], integrations[0].id)).find(
      tool => tool.name === 'read',
    );
    for (let index = 0; index < f.members.length; index++) {
      const member = f.members[index],
        integration = integrations[index],
        origin = taskOrigins[index];
      const tableId = randomUUID();
      f.sources.add(tableId);
      const slots = [
        {
          slotId: 'reader',
          serverIdentity: integration.serverIdentity,
          tools: [{ name: 'read', revision: policy.discovered_revision }],
        },
      ];
      f.origins.set(origin.taskId, {
        membershipId: member.membershipId,
        sources: [{ kind: 'table', tableId }],
        slots,
        allowedTools: [
          {
            slotId: 'reader',
            integrationId: integration.id,
            serverIdentity: integration.serverIdentity,
            name: 'read',
            revision: policy.discovered_revision,
          },
        ],
      });
      await assert.rejects(
        f.service.selectFor(f.one.id, member, {
          origin: { kind: 'task', id: origin.taskId },
          requestId: randomUUID(),
          expectedVersion: 0,
          bindings: [{ integrationId: integration.id, slotId: 'reader' }],
        }),
        /Resource not found/,
      );
      await f.service.approveServerDescriptor(f.one.id, member, integration.id, integration.serverIdentity);
      await f.service.selectFor(f.one.id, member, {
        origin: { kind: 'task', id: origin.taskId },
        requestId: randomUUID(),
        expectedVersion: 0,
        bindings: [{ integrationId: integration.id, slotId: 'reader' }],
      });
      const catalog = await f.service.catalog(f.one.id, member, origin);
      assert.deepEqual(
        catalog.tools.map(tool => tool.tool.name),
        ['read'],
      );
      const action = await f.propose(integration, member, origin, 'read');
      assert.equal(action.requiresConsent, true);
      await f.approve(action, member);
      assert.equal((await f.service.dispatch(f.one.id, action.id)).status, 'succeeded');
      await assert.rejects(f.service.action(f.one.id, f.members[1 - index], action.id), /Resource not found/);
    }
    assert.notEqual(f.calls[0].requestId, f.calls[1].requestId);
    const origin = f.origin();
    await f.select(integrations[0], f.members[0], origin);
    const action = await f.propose(integrations[0], f.members[0], origin);
    await f.approve(action);
    f.origins.get(origin.conversationId).revoked = true;
    await assert.rejects(f.service.dispatch(f.one.id, action.id), /origin denied/);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test('disabled admission and dispatch, selection conflicts, limits, failures and reflected results fail closed', async () => {
  const f = await mcpFixture();
  try {
    const disabled = f.make({ admissionEnabled: false, dispatchEnabled: false });
    await assert.rejects(
      disabled.create(f.one.id, f.members[0], {
        name: 'disabled',
        ownership: 'personal',
        endpoint: 'https://example.com',
        credential: { kind: 'none' },
      }),
      /disabled/,
    );
    const integration = await f.connect();
    const origin = await f.select(integration);
    const taskOrigin = f.origin(f.members[0], 'named-task'),
      taskTable = randomUUID();
    f.sources.add(taskTable);
    f.origins.set(taskOrigin.taskId, {
      membershipId: f.members[0].membershipId,
      sources: [{ kind: 'table', tableId: taskTable }],
      allowedTools: [],
    });
    await f.select(integration, f.members[0], taskOrigin);
    await assert.rejects(
      f.service.setSelection(f.one.id, f.members[0], { origin: taskOrigin, expectedVersion: 0, integrationIds: [] }),
      /conflict/,
    );
    const catalog = await f.service.catalog(f.one.id, f.members[0], origin);
    await assert.rejects(
      f.service.propose(f.one.id, f.members[0], {
        id: randomUUID(),
        origin,
        handle: catalog.tools.find(tool => tool.tool.name === 'write').handle,
        arguments: { text: 'x'.repeat(128 * 1024) },
      }),
      /limit/,
    );
    const action = await f.propose(integration);
    await f.approve(action);
    await assert.rejects(disabled.dispatch(f.one.id, action.id), /disabled/);
    f.setDiscover(async () => {
      throw new Error('synthetic-private-mcp-secret');
    });
    await assert.rejects(
      f.service.dispatch(f.one.id, action.id),
      error => error.code === 'discovery-failed' && !error.message.includes('synthetic-private-mcp-secret'),
    );
    assert.equal(f.calls.length, 0);
    assert.ok((await f.service.tools(f.one.id, f.members[0], integration.id)).every(tool => tool.enabled_revision));
    f.setDiscover(async () => ({ tools: f.getTools() }));
    f.setCall(async () => ({ content: [{ type: 'text', text: 'synthetic-private-mcp-secret' }] }));
    assert.equal((await f.service.dispatch(f.one.id, action.id)).status, 'outcome-unknown');
    assert.equal((await f.service.action(f.one.id, f.members[0], action.id)).receipt.result, null);
    await f.service.reconcile(f.one.id, f.members[0], action.id, {
      observation: 'not-performed',
      notes: 'Provider log checked',
    });
    f.setDiscover(async () => ({
      tools: Array.from({ length: 201 }, (_, index) => ({ ...f.getTools()[0], name: `tool-${index}` })),
    }));
    await assert.rejects(f.service.discover(f.one.id, f.members[0], integration.id), /discovery-failed/);
    assert.ok((await f.service.tools(f.one.id, f.members[0], integration.id)).every(tool => tool.enabled_revision));
  } finally {
    await f.close();
  }
});

test('durable request IDs preserve results and optimistic mutations reject stale writes', async () => {
  const f = await mcpFixture();
  try {
    const input = {
      requestId: randomUUID(),
      name: 'Idempotent setup',
      ownership: 'personal',
      endpoint: 'https://mcp.example.com/tools',
      credential: { kind: 'none' },
    };
    const results = await Promise.all([
      f.service.create(f.one.id, f.members[0], input),
      f.make().create(f.one.id, f.members[0], input),
    ]);
    assert.deepEqual(results[0], results[1]);
    await assert.rejects(f.service.create(f.one.id, f.members[0], { ...input, name: 'Changed request' }), /conflict/);
    const integration = results[0];
    const discovery = { requestId: randomUUID(), expectedVersion: integration.version };
    const tools = await f.service.discover(f.one.id, f.members[0], integration.id, discovery);
    assert.deepEqual(await f.make().discover(f.one.id, f.members[0], integration.id, discovery), tools);
    const review = {
      requestId: randomUUID(),
      expectedVersion: (await f.service.status(f.one.id, f.members[0], integration.id)).version,
      tools: tools.map(tool => ({
        name: tool.name,
        revision: tool.discovered_revision,
        enabled: true,
        standingException: false,
      })),
    };
    const reviewed = await f.service.reviewTools(f.one.id, f.members[0], integration.id, review);
    assert.deepEqual(await f.make().reviewTools(f.one.id, f.members[0], integration.id, review), reviewed);
    await assert.rejects(
      f.service.reviewTools(f.one.id, f.members[0], integration.id, { ...review, requestId: randomUUID() }),
      /conflict/,
    );
    const context = f.origin();
    const subject = { kind: 'chat', id: context.conversationId };
    const selection = {
      origin: subject,
      requestId: randomUUID(),
      expectedVersion: 0,
      bindings: [{ integrationId: integration.id, slotId: null }],
    };
    const selected = await f.service.selectFor(f.one.id, f.members[0], selection);
    assert.deepEqual(await f.make().selectFor(f.one.id, f.members[0], selection), selected);
    assert.equal((await f.service.selectionFor(f.one.id, f.members[0], subject)).version, 1);
    await assert.rejects(f.service.selectionFor(f.one.id, f.members[1], subject), /selection denied/);
    const action = await f.propose(integration, f.members[0], context);
    const decision = { requestId: randomUUID(), digest: action.digest, decision: 'approve' };
    await f.service.decide(f.one.id, f.members[0], action.id, decision);
    assert.equal((await f.service.actionForOrigin(f.one.id, f.members[0], context)).id, action.id);
    assert.equal(
      (await f.service.actions(f.one.id, f.members[0], { kind: 'chat', originId: context.conversationId })).actions[0]
        .action.id,
      action.id,
    );
    f.setCall(async () => {
      throw new Error('unknown');
    });
    await f.service.dispatch(f.one.id, action.id);
    assert.equal((await f.service.decide(f.one.id, f.members[0], action.id, decision)).status, 'outcome-unknown');
    const reconciliation = {
      requestId: randomUUID(),
      digest: action.digest,
      observation: 'not-performed',
      notes: 'Checked provider audit',
    };
    const observed = await f.service.reconcile(f.one.id, f.members[0], action.id, reconciliation);
    assert.deepEqual(await f.make().reconcile(f.one.id, f.members[0], action.id, reconciliation), observed);
    await assert.rejects(
      f.service.reconcile(f.one.id, f.members[0], action.id, { ...reconciliation, notes: 'Changed evidence' }),
      /conflict/,
    );
    const lifecycle = {
      requestId: randomUUID(),
      expectedVersion: (await f.service.status(f.one.id, f.members[0], integration.id)).version,
      operation: 'disable',
    };
    const disabled = await f.service.setLifecycle(f.one.id, f.members[0], integration.id, lifecycle);
    assert.deepEqual(await f.make().setLifecycle(f.one.id, f.members[0], integration.id, lifecycle), disabled);
    await assert.rejects(
      f.service.setLifecycle(f.one.id, f.members[0], integration.id, { ...lifecycle, requestId: randomUUID() }),
      /conflict/,
    );
  } finally {
    await f.close();
  }
});

test('task draft claim commits with task creation, rolls back on failure, and cannot be reused', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0];
    const integration = await f.connect(actor);
    await f.service.approveServerDescriptor(f.one.id, actor, integration.id, integration.serverIdentity);
    const policy = (await f.service.tools(f.one.id, actor, integration.id)).find(tool => tool.name === 'read');
    const agentId = randomUUID(),
      activationId = randomUUID(),
      revision = 'a'.repeat(64),
      selectionId = randomUUID(),
      taskId = randomUUID();
    const slots = [
      {
        slotId: 'private-account',
        serverIdentity: integration.serverIdentity,
        tools: [{ name: 'read', revision: policy.discovered_revision }],
      },
    ];
    f.origins.set(selectionId, { membershipId: actor.membershipId, slots });
    f.origins.set(taskId, { membershipId: actor.membershipId, slots });
    await f.db.platform.query(`INSERT INTO ${f.table('tf_agents')} (id) VALUES ($1)`, [agentId]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,'{}')`,
      [agentId, revision],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,'[]')`,
      [activationId, agentId, revision],
    );
    const selected = await f.service.selectFor(f.one.id, actor, {
      origin: { kind: 'task-draft', id: selectionId, agentId },
      requestId: randomUUID(),
      expectedVersion: 0,
      bindings: [{ integrationId: integration.id, slotId: 'private-account' }],
    });
    const create = async (tx, rollback) => {
      await tx.client.query(
        `INSERT INTO ${f.table('tf_agent_tasks')} (id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id) VALUES ($1,$2,$3,$4,$5,$6,'[]','[]','{}',$7)`,
        [taskId, actor.userId, actor.membershipId, agentId, activationId, revision, randomUUID()],
      );
      const claimed = await f.service.claimTaskSelection(tx, actor, {
        selectionId,
        version: selected.version,
        taskId,
        agentId,
      });
      if (rollback) throw new Error('task start failed');
      return claimed;
    };
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx => create(tx, true)),
      /task start failed/,
    );
    assert.equal(
      (await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_agent_tasks')} WHERE id=$1`, [taskId])).rowCount,
      0,
    );
    assert.equal(
      (await f.service.selectionFor(f.one.id, actor, { kind: 'task-draft', id: selectionId, agentId })).claimedTaskId,
      null,
    );
    const claimed = await f.runtime.transaction(f.one.id, commonCompatibility, tx => create(tx, false));
    assert.equal(claimed.bindings[0].integrationId, integration.id);
    assert.equal(
      (await f.service.selectionFor(f.one.id, actor, { kind: 'task', id: taskId })).bindings[0].slotId,
      'private-account',
    );
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx =>
        f.service.claimTaskSelection(tx, actor, {
          selectionId,
          version: selected.version,
          taskId: randomUUID(),
          agentId,
        }),
      ),
      /conflict/,
    );
  } finally {
    await f.close();
  }
});

test('same-server task slots cannot lend write authority to the read-only bound account', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0],
      readAccount = await f.connect(actor),
      writeAccount = await f.connect(actor);
    for (const integration of [readAccount, writeAccount])
      await f.service.approveServerDescriptor(f.one.id, actor, integration.id, integration.serverIdentity);
    const policies = await f.service.tools(f.one.id, actor, readAccount.id);
    const read = policies.find(tool => tool.name === 'read'),
      write = policies.find(tool => tool.name === 'write');
    const origin = f.origin(actor, 'named-task');
    const slots = [
      {
        slotId: 'reader',
        serverIdentity: readAccount.serverIdentity,
        tools: [{ name: 'read', revision: read.discovered_revision }],
      },
      {
        slotId: 'writer',
        serverIdentity: readAccount.serverIdentity,
        tools: [{ name: 'write', revision: write.discovered_revision }],
      },
    ];
    const authority = {
      membershipId: actor.membershipId,
      sources: [{ kind: 'private-task', taskId: origin.taskId }],
      slots,
      allowedTools: slots.flatMap(slot =>
        slot.tools.map(tool => ({ ...tool, slotId: slot.slotId, serverIdentity: slot.serverIdentity })),
      ),
    };
    f.origins.set(origin.taskId, authority);
    await f.service.selectFor(f.one.id, actor, {
      origin: { kind: 'task', id: origin.taskId },
      requestId: randomUUID(),
      expectedVersion: 0,
      bindings: [
        { integrationId: readAccount.id, slotId: 'reader' },
        { integrationId: writeAccount.id, slotId: 'writer' },
      ],
    });
    const catalog = await f.service.catalog(f.one.id, actor, origin);
    assert.deepEqual(
      catalog.tools.map(tool => [tool.integrationId, tool.tool.name]),
      [
        [readAccount.id, 'read'],
        [writeAccount.id, 'write'],
      ],
    );
    const writer = catalog.tools.find(tool => tool.integrationId === writeAccount.id);
    const action = await f.service.propose(f.one.id, actor, {
      id: randomUUID(),
      origin,
      handle: writer.handle,
      arguments: { text: 'write only on selected writer' },
    });
    await f.approve(action);
    authority.allowedTools = authority.allowedTools.map(tool => ({ ...tool, slotId: 'reader' }));
    await assert.rejects(f.service.dispatch(f.one.id, action.id), /Resource not found/);
    assert.equal(f.calls.length, 0);
    authority.allowedTools = slots.flatMap(slot =>
      slot.tools.map(tool => ({ ...tool, slotId: slot.slotId, serverIdentity: slot.serverIdentity })),
    );
    assert.equal((await f.service.dispatch(f.one.id, action.id)).status, 'succeeded');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].requestId, action.id);
  } finally {
    await f.close();
  }
});

test('team removal and reenrollment never restore old selections or approvals', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0],
      teamId = randomUUID(),
      integration = await f.connect(f.admin, 'shared');
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Revocable MCP team')`, [
      teamId,
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2),($3,$2)`,
      [actor.membershipId, teamId, f.admin.membershipId],
    );
    await f.service.setGrants(f.one.id, f.admin, integration.id, {
      expectedVersion: 1,
      memberIds: [],
      teamIds: [teamId],
    });
    const review = async () =>
      f.service.reviewTools(
        f.one.id,
        f.admin,
        integration.id,
        (await f.service.tools(f.one.id, f.admin, integration.id)).map(tool => ({
          name: tool.name,
          revision: tool.discovered_revision,
          enabled: true,
          standingException: true,
        })),
      );
    await review();
    const action = await f.propose(integration);
    await f.approve(action);
    const before = await f.service.status(f.one.id, actor, integration.id);
    await f.runtime.transaction(f.one.id, commonCompatibility, async tx => {
      await tx.client.query(`DELETE FROM ${f.table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
        actor.membershipId,
        teamId,
      ]);
      await tx.client.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        actor.membershipId,
        teamId,
      ]);
    });
    const after = await f.service.status(f.one.id, actor, integration.id);
    assert.ok(after.authorizationEpoch > before.authorizationEpoch);
    assert.ok(
      (await f.service.tools(f.one.id, actor, integration.id)).every(
        tool => !tool.enabled_revision && !tool.standing_exception,
      ),
    );
    await assert.rejects(f.service.dispatch(f.one.id, action.id), /Resource not found/);
    await review();
    assert.deepEqual((await f.service.catalog(f.one.id, actor, action.origin)).sources, [
      { kind: 'mcp-integration', integrationId: integration.id, authorizationEpoch: after.authorizationEpoch },
    ]);
    await f.select(integration, actor, action.origin);
    await assert.rejects(f.service.dispatch(f.one.id, action.id), /Resource not found/);
    const fresh = await f.propose(integration);
    await f.approve(fresh);
    assert.equal((await f.service.dispatch(f.one.id, fresh.id)).status, 'succeeded');
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('requester metadata status conceals successful results and retained notes after disconnect', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect();
    const action = await f.propose(integration);
    await f.approve(action);
    f.setCall(async () => ({ content: [{ type: 'text', text: 'private successful result' }] }));
    assert.equal((await f.service.dispatch(f.one.id, action.id)).status, 'succeeded');
    await f.service.setLifecycle(f.one.id, f.members[0], integration.id, 'disconnected');
    const status = await f.service.actionStatus(f.one.id, f.members[0], action.id);
    assert.equal(status.kind, 'requester-metadata');
    assert.equal(status.status, 'succeeded');
    assert.equal(status.canReconcile, false);
    assert.equal(status.digest, action.digest);
    assert.equal(JSON.stringify(status).includes('private'), false);
    await assert.rejects(f.service.action(f.one.id, f.members[0], action.id), /integration-unavailable/);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.members[0].membershipId,
    ]);
    const replacement = { ...f.members[0], membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      replacement.membershipId,
      replacement.userId,
    ]);
    await assert.rejects(f.service.actionStatus(f.one.id, replacement, action.id));
    assert.deepEqual(
      (await f.service.actions(f.one.id, replacement, { kind: 'integration', originId: integration.id })).actions,
      [],
    );
  } finally {
    await f.close();
  }
});

test('expired claims recover with dispatch off after requester removal without exposing or delegating recovery to an admin', async () => {
  const f = await mcpFixture();
  try {
    const integration = await f.connect(f.admin, 'shared');
    await f.service.setGrants(f.one.id, f.admin, integration.id, {
      expectedVersion: 1,
      memberIds: [f.members[0].membershipId],
      teamIds: [],
    });
    await f.service.reviewTools(
      f.one.id,
      f.admin,
      integration.id,
      (await f.service.tools(f.one.id, f.admin, integration.id)).map(tool => ({
        name: tool.name,
        revision: tool.discovered_revision,
        enabled: true,
        standingException: false,
      })),
    );
    const action = await f.propose(integration);
    await f.approve(action);
    await f.runtime.transaction(f.one.id, commonCompatibility, tx =>
      tx.client.query(
        `INSERT INTO ${f.table('claims')} (action_id,integration_id,token,deadline) VALUES ($1,$2,$3,clock_timestamp()-interval '1 second')`,
        [action.id, integration.id, randomUUID()],
      ),
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.members[0].membershipId,
    ]);
    await f.service.setLifecycle(f.one.id, f.admin, integration.id, 'disconnected');
    const recovery = f.make({
      dispatchEnabled: false,
      authorizeOrigin: async () => {
        throw new Error('publication denied');
      },
      authorizeSources: async () => {
        throw new Error('publication denied');
      },
    });
    await assert.rejects(recovery.recoverAction(f.one.id, f.admin, action.id), /Resource not found/);
    await assert.rejects(recovery.actionStatus(f.one.id, f.admin, action.id), /Resource not found/);
    await assert.rejects(
      recovery.reconcile(f.one.id, f.admin, action.id, {
        requestId: randomUUID(),
        digest: action.digest,
        observation: 'not-performed',
        notes: 'Externally verified',
      }),
      /Resource not found/,
    );
    await recovery.recover(f.one.id);
    assert.deepEqual(
      (await f.db.platform.query(`SELECT status FROM ${f.table('receipts')} WHERE action_id=$1`, [action.id])).rows,
      [{ status: 'outcome-unknown' }],
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('tool review accepts every discovered entry and limits only the enabled set', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0];
    f.setTools(
      Array.from({ length: 200 }, (_, index) => ({
        name: `tool-${String(index).padStart(3, '0')}`,
        description: 'Read a record',
        inputSchema: { type: 'object', additionalProperties: false },
      })),
    );
    const integration = await f.service.create(f.one.id, actor, {
      name: 'Large catalog',
      endpoint: 'https://mcp.example.com/tools',
      ownership: 'personal',
      credential: { kind: 'none' },
    });
    const discovered = await f.service.discover(f.one.id, actor, integration.id);
    const review = async (entries, enabled) =>
      f.service.reviewTools(f.one.id, actor, integration.id, {
        requestId: randomUUID(),
        expectedVersion: (await f.service.status(f.one.id, actor, integration.id)).version,
        tools: discovered.slice(0, entries).map((tool, index) => ({
          name: tool.name,
          revision: tool.discovered_revision,
          enabled: index < enabled,
          standingException: false,
        })),
      });
    const enabledNames = policies => policies.filter(policy => policy.enabled_revision).map(policy => policy.name);
    assert.deepEqual(enabledNames(await review(101, 1)), ['tool-000']);
    assert.deepEqual(enabledNames(await review(200, 2)), ['tool-000', 'tool-001']);
    await assert.rejects(review(200, 101), /limit/);
    assert.equal(enabledNames(await review(200, 100)).length, 100);
    await assert.rejects(
      async () =>
        f.service.reviewTools(
          f.one.id,
          actor,
          integration.id,
          [...discovered, discovered[0]].map(tool => ({
            name: tool.name,
            revision: tool.discovered_revision,
            enabled: false,
            standingException: false,
          })),
        ),
      /too_big|Too big/,
    );
  } finally {
    await f.close();
  }
});

test('authority changes during refresh rotation require reconnection instead of reusing the submitted refresh token', async () => {
  const f = await mcpFixture();
  try {
    const teamId = randomUUID();
    const oauth = token => ({
      kind: 'oauth',
      accessToken: `${token}-access`,
      refreshToken: `${token}-refresh`,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      issuer: 'https://auth.example.com/',
      resource: 'https://mcp.example.com/tools',
      clientId: 'client',
      authMethod: 'none',
      scopes: ['read'],
      accountId: 'account-one',
    });
    const integration = await f.service.create(f.one.id, f.admin, {
      name: 'Shared OAuth',
      endpoint: 'https://mcp.example.com/tools',
      ownership: 'shared',
      credential: oauth('first'),
    });
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Rotating team')`, [teamId]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2),($3,$2)`,
      [f.members[1].membershipId, teamId, f.admin.membershipId],
    );
    const status = () => f.service.status(f.one.id, f.admin, integration.id);
    const replace = async token =>
      f.service.replaceCredential(f.one.id, f.admin, integration.id, {
        credential: oauth(token),
        expectedSecretVersion: (await status()).secretVersion,
      });

    const grantClaim = await f.service.claimRefresh(f.one.id, f.admin, integration.id);
    assert.equal(grantClaim.credential.refreshToken, 'first-refresh');
    await f.service.setGrants(f.one.id, f.admin, integration.id, {
      expectedVersion: (await status()).grantsVersion,
      memberIds: [f.admin.membershipId, f.members[0].membershipId],
      teamIds: [teamId],
    });
    await assert.rejects(
      f.service.completeRefresh(f.one.id, f.admin, integration.id, grantClaim, oauth('rotated')),
      /oauth-conflict/,
    );
    assert.deepEqual(await f.service.failRefresh(f.one.id, f.admin, integration.id, grantClaim), {
      integrationId: integration.id,
    });
    assert.equal((await status()).lifecycle, 'reconnect-required');
    await assert.rejects(f.service.claimRefresh(f.one.id, f.admin, integration.id), /integration-unavailable/);

    await replace('second');
    const teamClaim = await f.service.claimRefresh(f.one.id, f.admin, integration.id);
    assert.equal(teamClaim.credential.refreshToken, 'second-refresh');
    await f.db.platform.query(`DELETE FROM ${f.table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
      f.members[1].membershipId,
      teamId,
    ]);
    assert.deepEqual(await f.service.failRefresh(f.one.id, f.admin, integration.id, teamClaim), {
      integrationId: integration.id,
    });
    assert.equal((await status()).lifecycle, 'reconnect-required');
    await assert.rejects(f.service.claimRefresh(f.one.id, f.admin, integration.id), /integration-unavailable/);

    await replace('third');
    const replacedClaim = await f.service.claimRefresh(f.one.id, f.admin, integration.id);
    await replace('fourth');
    await assert.rejects(
      f.service.completeRefresh(f.one.id, f.admin, integration.id, replacedClaim, oauth('stale')),
      /oauth-conflict/,
    );
    assert.deepEqual(await f.service.failRefresh(f.one.id, f.admin, integration.id, replacedClaim), {
      integrationId: integration.id,
    });
    assert.equal((await status()).lifecycle, 'active');
    const current = await f.service.claimRefresh(f.one.id, f.admin, integration.id);
    assert.equal(current.credential.refreshToken, 'fourth-refresh');
    const completed = await f.service.completeRefresh(f.one.id, f.admin, integration.id, current, oauth('fifth'));
    assert.equal(completed.lifecycle, 'active');
    assert.equal(completed.secretVersion, current.secretVersion + 1);
  } finally {
    await f.close();
  }
});

test('expired unclaimed actions are terminal, never dispatch, and leave room for a fresh proposal', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0];
    const integration = await f.connect();
    const origin = await f.select(integration);
    const waiting = await f.propose(integration, actor, origin);
    assert.equal(waiting.status, 'awaiting-approval');
    const expire = id =>
      f.db.platform.query(
        `UPDATE ${f.table('actions')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [id],
      );
    await expire(waiting.id);
    assert.equal((await f.service.action(f.one.id, actor, waiting.id)).status, 'expired');
    assert.equal((await f.service.actionStatus(f.one.id, actor, waiting.id, true)).status, 'expired');
    await assert.rejects(f.approve(waiting), /expired/);
    await assert.rejects(f.service.dispatch(f.one.id, waiting.id), /expired/);
    assert.equal(f.calls.length, 0);
    const fresh = await f.propose(integration, actor, { ...origin, stepId: randomUUID() });
    assert.notEqual(fresh.id, waiting.id);
    assert.equal(fresh.status, 'awaiting-approval');
    await f.approve(fresh);
    assert.equal((await f.service.dispatch(f.one.id, fresh.id)).status, 'succeeded');
    await expire(fresh.id);
    assert.equal((await f.service.action(f.one.id, actor, fresh.id)).status, 'succeeded');
    const cancelled = await f.propose(integration, actor, { ...origin, stepId: randomUUID() });
    await expire(cancelled.id);
    assert.equal((await f.service.cancel(f.one.id, actor, cancelled.id)).status, 'cancelled-before-dispatch');
    assert.equal((await f.service.action(f.one.id, actor, cancelled.id)).status, 'cancelled-before-dispatch');
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('a stale draft selection returns its version for explicit reselection without authorizing the old binding', async () => {
  const f = await mcpFixture();
  try {
    const actor = f.members[0];
    const integration = await f.connect(actor);
    await f.service.approveServerDescriptor(f.one.id, actor, integration.id, integration.serverIdentity);
    const policy = (await f.service.tools(f.one.id, actor, integration.id)).find(tool => tool.name === 'read');
    const agentId = randomUUID(),
      selectionId = randomUUID();
    const subject = { kind: 'task-draft', id: selectionId, agentId };
    f.origins.set(selectionId, {
      membershipId: actor.membershipId,
      slots: [
        {
          slotId: 'private-account',
          serverIdentity: integration.serverIdentity,
          tools: [{ name: 'read', revision: policy.discovered_revision }],
        },
      ],
    });
    const selected = await f.service.selectFor(f.one.id, actor, {
      origin: subject,
      requestId: randomUUID(),
      expectedVersion: 0,
      bindings: [{ integrationId: integration.id, slotId: 'private-account' }],
    });
    assert.equal((await f.service.selectionFor(f.one.id, actor, subject)).stale, false);
    const before = await f.service.status(f.one.id, actor, integration.id);
    await f.service.replaceCredential(f.one.id, actor, integration.id, {
      credential: { kind: 'bearer', token: 'replacement-private-secret' },
      expectedSecretVersion: before.secretVersion,
    });
    await assert.rejects(
      f.service.selectFor(f.one.id, actor, {
        origin: subject,
        requestId: randomUUID(),
        expectedVersion: selected.version,
        bindings: [{ integrationId: integration.id, slotId: 'private-account' }],
      }),
      /Resource not found/,
    );
    const discovered = await f.service.discover(f.one.id, actor, integration.id);
    await f.service.reviewTools(
      f.one.id,
      actor,
      integration.id,
      discovered.map(tool => ({
        name: tool.name,
        revision: tool.discovered_revision,
        enabled: true,
        standingException: false,
      })),
    );
    await f.service.approveServerDescriptor(f.one.id, actor, integration.id, integration.serverIdentity);
    const stale = await f.service.selectionFor(f.one.id, actor, subject);
    assert.deepEqual(stale, {
      version: 1,
      bindings: [
        { integrationId: integration.id, slotId: 'private-account', authorizationEpoch: before.authorizationEpoch },
      ],
      claimedTaskId: null,
      stale: true,
    });
    await assert.rejects(f.service.selectionFor(f.one.id, f.members[1], subject), /selection denied/);
    const repaired = await f.service.selectFor(f.one.id, actor, {
      origin: subject,
      requestId: randomUUID(),
      expectedVersion: stale.version,
      bindings: [{ integrationId: integration.id, slotId: 'private-account' }],
    });
    assert.deepEqual(repaired, {
      version: 2,
      bindings: [
        { integrationId: integration.id, slotId: 'private-account', authorizationEpoch: before.authorizationEpoch + 1 },
      ],
    });
    assert.equal((await f.service.selectionFor(f.one.id, actor, subject)).stale, false);
  } finally {
    await f.close();
  }
});
