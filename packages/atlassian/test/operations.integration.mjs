import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { operationFixture, boardId, listId, cardId, card, cloudId, toolNames } from './operation-fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('persisted operations enforce exact protected approval and durable no-replay execution', async t => {
  const f = await operationFixture();
  const { operations: s, one: w, member: m, db, table } = f;
  const execute = proposal => s.execute(w.id, m.userId, proposal.id);
  try {
    await t.test(
      'runtime cannot approve, mutate an intent, extend expiry, replace sources or delete receipts',
      async () => {
        const proposal = await f.propose();
        for (const sql of [
          `INSERT INTO ${table('tf_atlassian_decisions')} (proposal_id,membership_id,digest,decision) VALUES ('${proposal.id}','${m.membershipId}','${proposal.digest}','approve')`,
          `UPDATE ${table('tf_atlassian_proposals')} SET operation='{}'`,
          `UPDATE ${table('tf_atlassian_proposals')} SET expires_at=clock_timestamp()+interval '1 day'`,
          `UPDATE ${table('tf_atlassian_sources')} SET binding='{}'`,
          `UPDATE ${table('tf_atlassian_decisions')} SET decision='approve'`,
          `DELETE FROM ${table('tf_atlassian_decisions')}`,
          `DELETE FROM ${table('tf_atlassian_receipts')}`,
          `SELECT * FROM ${table('tf_atlassian_sources', f.two)}`,
        ])
          await assert.rejects(
            f.runtime.transaction(w.id, commonCompatibility, tx => tx.client.query(sql)),
            error => error.code === '42501',
          );
        await assert.rejects(execute(proposal), /operation-approval-required/);
        assert.equal(f.providerCalls.length, 0);
      },
    );
    await t.test('exact payload approval commits executing before network and replay returns the receipt', async () => {
      const input = {
        commandId: randomUUID(),
        sourceId: f.source.id,
        operation: { kind: 'card.create', listId, name: card.name, desc: card.desc },
      };
      const proposal = await s.propose(w.id, m.userId, input);
      input.operation.name = 'mutated after proposal';
      await assert.rejects(s.propose(w.id, m.userId, input), /operation-conflict/);
      await assert.rejects(
        f.approve(w.id, m.userId, proposal.id, { digest: 'a'.repeat(64), decision: 'approve' }),
        /operation-conflict/,
      );
      await assert.rejects(
        f.approve(w.id, w.userId, proposal.id, { digest: proposal.digest, decision: 'approve' }),
        AccessDenied,
      );
      assert.equal((await f.decide(proposal)).decision, 'approve');
      const gate = Promise.withResolvers(),
        entered = Promise.withResolvers();
      f.setProvider(async (_url, init) => {
        assert.equal(
          (
            await db.platform.query(`SELECT status FROM ${table('tf_atlassian_receipts')} WHERE proposal_id=$1`, [
              proposal.id,
            ])
          ).rows[0].status,
          'executing',
        );
        if (init.method === 'POST') {
          assert.deepEqual(JSON.parse(init.body), { idList: listId, name: card.name, desc: card.desc });
          entered.resolve();
          await gate.promise;
        }
      });
      const pending = execute(proposal);
      await entered.promise;
      assert.deepEqual(await f.makeOperations().execute(w.id, m.userId, proposal.id), {
        status: 'executing',
        result: null,
        error: null,
      });
      gate.resolve();
      const result = await pending;
      assert.equal(result.status, 'succeeded');
      assert.equal(result.result.untrusted, true);
      assert.equal(result.result.data.card.name, card.name);
      const count = f.providerCalls.length;
      assert.deepEqual(await f.makeOperations().execute(w.id, m.userId, proposal.id), result);
      assert.equal(f.providerCalls.length, count);
      await assert.rejects(
        f.runtime.transaction(w.id, commonCompatibility, tx =>
          tx.client.query(
            `UPDATE ${table('tf_atlassian_receipts')} SET status='executing',result=NULL WHERE proposal_id=$1`,
            [proposal.id],
          ),
        ),
        /Receipt is terminal/,
      );
      f.setProvider(undefined);
    });
    await t.test('expiry, rejection, removed grant and generation changes invalidate pending approvals', async () => {
      const expired = await f.propose();
      await db.platform.query(
        `UPDATE ${table('tf_atlassian_proposals')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [expired.id],
      );
      await assert.rejects(f.decide(expired), /operation-expired/);
      await assert.rejects(execute(expired), /operation-expired/);
      const approvedExpired = await f.propose();
      await f.decide(approvedExpired);
      await db.platform.query(
        `UPDATE ${table('tf_atlassian_proposals')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [approvedExpired.id],
      );
      await assert.rejects(execute(approvedExpired), /operation-expired/);
      const rejected = await f.propose();
      await f.decide(rejected, 'reject');
      await assert.rejects(f.decide(rejected), /operation-conflict/);
      await assert.rejects(execute(rejected), /operation-approval-required/);
      const stale = await f.propose();
      await f.decide(stale);
      await db.platform.query(
        `UPDATE ${table('tf_atlassian_accounts')} SET grants_version=grants_version+1 WHERE id=$1`,
        [f.accountId],
      );
      await assert.rejects(execute(stale), /operation-conflict/);
      const generation = await f.propose();
      await f.decide(generation);
      await f.service.reconnect(w.id, m.userId, 'session', f.accountId);
      await assert.rejects(execute(generation), /operation-conflict/);
      const started = await f.service.reconnect(w.id, m.userId, 'test-session', f.accountId);
      await f.service.complete('code', new URL(started.url).searchParams.get('state'), 'test-session', m.userId);
      await assert.rejects(execute(generation), /operation-conflict/);
    });
    await t.test(
      'source ownership and workspace isolation fence reads, proposals, approvals and execution',
      async () => {
        const proposal = await f.propose();
        for (const [workspaceId, userId] of [
          [w.id, w.userId],
          [f.two.id, f.two.userId],
        ]) {
          await assert.rejects(
            s.read(workspaceId, userId, { sourceId: f.source.id, operation: { kind: 'card.read', cardId } }),
            AccessDenied,
          );
          await assert.rejects(s.proposal(workspaceId, userId, proposal.id), AccessDenied);
          await assert.rejects(s.execute(workspaceId, userId, proposal.id), AccessDenied);
          await assert.rejects(
            f.approve(workspaceId, userId, proposal.id, { digest: proposal.digest, decision: 'approve' }),
            AccessDenied,
          );
        }
      },
    );
    await t.test(
      'business admin needs explicit use grant and revoked grants prevent approval and dispatch',
      async () => {
        const id = await f.connect('trello', 'business');
        const binding = { kind: 'trello', boardId };
        await assert.rejects(s.createSource(w.id, w.userId, { name: 'Admin', accountId: id, binding }), AccessDenied);
        await f.service.setGrants(w.id, m.userId, id, {
          expectedVersion: 1,
          memberIds: [m.membershipId, w.membershipId],
          teamIds: [],
        });
        assert.equal((await s.createSource(w.id, w.userId, { name: 'Admin', accountId: id, binding })).name, 'Admin');
        const source = await s.createSource(w.id, m.userId, { name: 'Business', accountId: id, binding });
        const proposal = await f.propose(undefined, source.id);
        await f.decide(proposal);
        await f.service.setGrants(w.id, m.userId, id, { expectedVersion: 2, memberIds: [], teamIds: [] });
        await assert.rejects(execute(proposal), AccessDenied);
        await assert.rejects(f.decide(proposal), AccessDenied);
      },
    );
    await t.test('provider failure and abandoned executing receipt cannot replay after service restart', async () => {
      const proposal = await f.propose();
      await f.decide(proposal);
      f.setProvider(async (_url, init) => {
        if (init.method === 'POST') throw new Error('synthetic-access-token');
      });
      const result = await execute(proposal);
      assert.deepEqual(result, { status: 'outcome-unknown', result: null, error: 'provider-outcome-unknown' });
      const count = f.providerCalls.length;
      assert.deepEqual(await f.makeOperations().execute(w.id, m.userId, proposal.id), result);
      assert.equal(f.providerCalls.length, count);
      const abandoned = await f.propose();
      await f.decide(abandoned);
      await f.runtime.transaction(w.id, commonCompatibility, tx =>
        tx.client.query(`INSERT INTO ${table('tf_atlassian_receipts')} (proposal_id) VALUES ($1)`, [abandoned.id]),
      );
      assert.equal((await f.makeOperations().execute(w.id, m.userId, abandoned.id)).status, 'executing');
      assert.equal(f.providerCalls.length, count);
      f.setProvider(undefined);
    });
    await t.test('Trello reads need no approval and writes reject foreign containers', async () => {
      assert.equal(
        (await s.read(w.id, m.userId, { sourceId: f.source.id, operation: { kind: 'card.search', query: 'Exact' } }))
          .data.cards[0].id,
        cardId,
      );
      assert.equal(
        (await s.read(w.id, m.userId, { sourceId: f.source.id, operation: { kind: 'card.read', cardId } })).data.card
          .id,
        cardId,
      );
      for (const operation of [
        { kind: 'card.update', cardId, changes: { name: card.name, closed: false } },
        { kind: 'card.delete', cardId },
      ]) {
        const proposal = await f.propose(operation);
        await f.decide(proposal);
        assert.equal((await execute(proposal)).status, 'succeeded');
      }
      f.setProvider(async url =>
        url.includes('/lists/') ? Response.json({ id: listId, idBoard: 'f'.repeat(24) }) : undefined,
      );
      const proposal = await f.propose();
      await f.decide(proposal);
      const count = f.providerCalls.filter(call => call.method === 'POST').length;
      assert.equal((await execute(proposal)).status, 'failed');
      assert.equal(f.providerCalls.filter(call => call.method === 'POST').length, count);
      f.setProvider(undefined);
    });
    await t.test('revocation during preflight fences the write without holding a provider transaction', async () => {
      const id = await f.connect('trello', 'business', w.userId);
      await f.service.setGrants(w.id, w.userId, id, { expectedVersion: 1, memberIds: [m.membershipId], teamIds: [] });
      const source = await s.createSource(w.id, m.userId, {
        name: 'Revocable',
        accountId: id,
        binding: { kind: 'trello', boardId },
      });
      const proposal = await f.propose(undefined, source.id);
      await f.decide(proposal);
      f.setProvider(async url => {
        if (url.includes('/lists/'))
          await f.service.setGrants(w.id, w.userId, id, { expectedVersion: 2, memberIds: [], teamIds: [] });
      });
      const writes = f.providerCalls.filter(call => call.method === 'POST').length;
      await assert.rejects(execute(proposal), AccessDenied);
      assert.equal(f.providerCalls.filter(call => call.method === 'POST').length, writes);
      f.setProvider(undefined);
    });
    await t.test('disabled sources and replaced memberships cannot reuse a source or approve a proposal', async () => {
      const source = await s.createSource(w.id, m.userId, {
        accountId: f.accountId,
        name: 'Temporary',
        binding: { kind: 'trello', boardId },
      });
      const proposal = await f.propose(undefined, source.id);
      await s.disableSource(w.id, m.userId, source.id);
      await assert.rejects(f.decide(proposal), /operation-conflict/);
      await assert.rejects(
        s.read(w.id, m.userId, { sourceId: source.id, operation: { kind: 'card.read', cardId } }),
        /operation-conflict/,
      );
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        m.membershipId,
      ]);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        m.userId,
      ]);
      await assert.rejects(f.decide(proposal), AccessDenied);
      await assert.rejects(
        s.read(w.id, m.userId, { sourceId: f.source.id, operation: { kind: 'card.read', cardId } }),
        AccessDenied,
      );
    });
  } finally {
    await f.close();
  }
});

test('all MCP operations use reviewed official tools and source cloud; REST trash uses selected space', async t => {
  const f = await operationFixture();
  const { one: w, member: m, operations: s } = f;
  try {
    const mcpAccount = await f.connect('atlassian-mcp');
    const jira = await s.createSource(w.id, m.userId, {
      name: 'Jira site',
      accountId: mcpAccount,
      binding: { kind: 'jira', cloudId },
    });
    const confluence = await s.createSource(w.id, m.userId, {
      name: 'Confluence site',
      accountId: mcpAccount,
      binding: { kind: 'confluence', cloudId },
    });
    await t.test('qualification discovers without execution or claiming verified identity', async () => {
      const disabled = f.makeOperations({ bindings: [] });
      const catalog = await disabled.qualify(w.id, m.userId, jira.id);
      assert.equal(catalog.data.identityQualification, 'grant-bound-needs-qualification');
      assert.equal(catalog.data.catalog.length, 9);
      assert.equal((await disabled.sources(w.id, m.userId)).mcp.enabled, false);
      await assert.rejects(
        disabled.read(w.id, m.userId, { sourceId: jira.id, operation: { kind: 'jira.read', issueIdOrKey: 'OPS-1' } }),
        /operation-disabled/,
      );
      assert.equal(
        f.providerCalls.some(call => JSON.parse(call.body).method === 'tools/call'),
        false,
      );
    });
    const operations = [
      { kind: 'jira.search', jql: 'project = OPS' },
      { kind: 'jira.read', issueIdOrKey: 'OPS-1' },
      { kind: 'jira.create', projectKey: 'OPS', issueTypeName: 'Task', summary: 'Exact' },
      { kind: 'jira.update', issueIdOrKey: 'OPS-1', fields: { summary: 'Exact' } },
      { kind: 'jira.delete', issueIdOrKey: 'OPS-1' },
      { kind: 'confluence.search', cql: 'type = page' },
      { kind: 'confluence.read', id: '123' },
      { kind: 'confluence.create', spaceKey: 'OPS', title: 'Exact', body: '<p>Text</p>', representation: 'storage' },
      {
        kind: 'confluence.update',
        id: '123',
        title: 'Exact',
        body: '<p>Text</p>',
        representation: 'storage',
        version: 2,
      },
    ];
    for (const operation of operations)
      await t.test(operation.kind, async () => {
        const sourceId = operation.kind.startsWith('jira.') ? jira.id : confluence.id;
        if (operation.kind.endsWith('.read') || operation.kind.endsWith('.search'))
          await s.read(w.id, m.userId, { sourceId, operation });
        else {
          const proposal = await f.propose(operation, sourceId);
          await f.decide(proposal);
          assert.equal((await s.execute(w.id, m.userId, proposal.id)).status, 'succeeded');
        }
        const call = f.providerCalls
          .map(value => JSON.parse(value.body))
          .filter(value => value.method === 'tools/call')
          .at(-1);
        assert.equal(call.params.name, toolNames[operation.kind]);
        assert.equal(call.params.arguments.cloudId, cloudId);
        assert.equal(call.params.arguments.kind, undefined);
      });
    await t.test(
      'contract changes invalidate approved writes; arbitrary dispatch and cloud override are rejected',
      async () => {
        const proposal = await f.propose(operations[2], jira.id);
        await f.decide(proposal);
        await assert.rejects(
          f.makeOperations({ bindings: [] }).execute(w.id, m.userId, proposal.id),
          /operation-disabled/,
        );
        for (const operation of [
          { kind: 'executeWrite', arguments: {} },
          { ...operations[1], cloudId: randomUUID() },
          { kind: 'jira.update', issueIdOrKey: 'OPS-1', fields: { url: 'https://evil.test' } },
        ])
          await assert.rejects(f.propose(operation, jira.id));
      },
    );
    await t.test('provider text is untrusted, bounded to 128KB, and credential reflections are discarded', async () => {
      let text = 'x'.repeat(131073);
      f.setProvider(async (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.method === 'tools/call')
          return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text }] } });
      });
      await assert.rejects(s.read(w.id, m.userId, { sourceId: jira.id, operation: operations[1] }), /operation-limit/);
      const proposal = await f.propose(operations[2], jira.id);
      await f.decide(proposal);
      const result = await s.execute(w.id, m.userId, proposal.id);
      assert.deepEqual(result, { status: 'outcome-unknown', result: null, error: 'provider-outcome-unknown' });
      text = Buffer.from('synthetic-access-token').toString('base64');
      await assert.rejects(s.read(w.id, m.userId, { sourceId: jira.id, operation: operations[1] }));
      const stored = JSON.stringify(
        (await f.db.platform.query(`SELECT * FROM ${f.table('tf_atlassian_receipts')}`)).rows,
      );
      assert.equal(stored.includes(text), false);
      assert.equal(stored.includes('synthetic-access-token'), false);
      f.setProvider(undefined);
    });
    await t.test(
      'encoded credential keys reject MCP reads and leave approved writes outcome-unknown without persisted secrets',
      async () => {
        const token = 'synthetic-access-token';
        const encoded = Buffer.from(token).toString('base64');
        try {
          for (const nested of [{ [encoded]: 'innocent value' }, [[{ [encoded]: 'innocent value' }]]]) {
            f.setProvider(async (_url, init) => {
              const request = JSON.parse(init.body);
              if (request.method === 'tools/call')
                return Response.json({
                  jsonrpc: '2.0',
                  id: request.id,
                  result: { content: [], structuredContent: { nested } },
                });
            });
            await assert.rejects(
              s.read(w.id, m.userId, { sourceId: jira.id, operation: operations[1] }),
              error => error.message === 'account-unavailable' && !error.cause,
            );
            const proposal = await f.propose(operations[2], jira.id);
            await f.decide(proposal);
            const expected = { status: 'outcome-unknown', result: null, error: 'provider-outcome-unknown' };
            assert.deepEqual(await s.execute(w.id, m.userId, proposal.id), expected);
            assert.deepEqual(
              (
                await f.db.platform.query(
                  `SELECT status,result,error FROM ${f.table('tf_atlassian_receipts')} WHERE proposal_id=$1`,
                  [proposal.id],
                )
              ).rows,
              [expected],
            );
            const count = f.providerCalls.length;
            assert.deepEqual(await f.makeOperations().execute(w.id, m.userId, proposal.id), expected);
            assert.equal(f.providerCalls.length, count);
          }
          for (const name of [
            'tf_atlassian_sources',
            'tf_atlassian_proposals',
            'tf_atlassian_decisions',
            'tf_atlassian_receipts',
          ]) {
            const stored = JSON.stringify((await f.db.platform.query(`SELECT * FROM ${f.table(name)}`)).rows);
            assert.equal(stored.includes(encoded), false, name);
            assert.equal(stored.includes(token), false, name);
          }
        } finally {
          f.setProvider(undefined);
        }
      },
    );
    await t.test('qualification rejects catalog credential keys nested in schemas and arrays', async () => {
      const encoded = Buffer.from('synthetic-access-token').toString('base64');
      const count = f.providerCalls.filter(call => JSON.parse(call.body).method === 'tools/call').length;
      try {
        for (const nested of [{ [encoded]: 'innocent value' }, [[{ [encoded]: 'innocent value' }]]]) {
          f.setProvider(async (_url, init) => {
            const request = JSON.parse(init.body);
            if (request.method === 'tools/list')
              return Response.json({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  tools: [
                    {
                      name: toolNames['jira.read'],
                      inputSchema: { type: 'object', properties: { issue: { type: 'object', examples: [nested] } } },
                    },
                  ],
                },
              });
          });
          await assert.rejects(
            s.qualify(w.id, m.userId, jira.id),
            error => error.message === 'account-unavailable' && !error.cause,
          );
        }
        assert.equal(f.providerCalls.filter(call => JSON.parse(call.body).method === 'tools/call').length, count);
      } finally {
        f.setProvider(undefined);
      }
      assert.equal((await s.qualify(w.id, m.userId, jira.id)).data.catalog.length, 9);
    });
    await t.test('Confluence trash requires a verified accessible site and selected space', async () => {
      const accountId = await f.connect('atlassian-rest');
      await assert.rejects(
        s.createSource(w.id, m.userId, {
          name: 'Trash',
          accountId,
          binding: { kind: 'confluence-trash', cloudId, spaceId: '456' },
        }),
        AccessDenied,
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_atlassian_accounts')} SET resources=$2 WHERE id=$1`, [
        accountId,
        JSON.stringify([{ id: cloudId, name: 'Site', url: 'https://example.atlassian.net', scopes: ['read:me'] }]),
      ]);
      const source = await s.createSource(w.id, m.userId, {
        name: 'Trash',
        accountId,
        binding: { kind: 'confluence-trash', cloudId, spaceId: '456' },
      });
      const proposal = await f.propose({ kind: 'confluence.trash', pageId: '123' }, source.id);
      await f.decide(proposal);
      assert.equal((await s.execute(w.id, m.userId, proposal.id)).result.data.kind, 'trashed');
      assert.equal(
        f.providerCalls.at(-1).url,
        `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages/123`,
      );
      const foreign = await f.propose({ kind: 'confluence.trash', pageId: '123' }, source.id);
      await f.decide(foreign);
      f.setProvider(async url =>
        url.includes('/wiki/api/v2/pages/')
          ? Response.json({ id: '123', spaceId: '999', status: 'current' })
          : undefined,
      );
      const writes = f.providerCalls.filter(call => call.method === 'DELETE').length;
      assert.equal((await s.execute(w.id, m.userId, foreign.id)).status, 'failed');
      assert.equal(f.providerCalls.filter(call => call.method === 'DELETE').length, writes);
      f.setProvider(undefined);
    });
  } finally {
    await f.close();
  }
});
