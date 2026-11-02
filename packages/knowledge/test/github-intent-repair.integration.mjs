import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { lockRolloutTarget } from '../../workspace-storage/src/migrations.ts';
import { provisionWorkspace } from '../../workspace-storage/src/provisioning.ts';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createDefaultKnowledge, recordDefaultKnowledgeIntent } from '../dist/index.js';

test('a GitHub intent left on a removed account row follows its GitHub user', { timeout: 300000 }, async () => {
  const db = await fixture();
  try {
    const stream = await workspaceTableMigrations();
    const ws = await db.create(stream.slice(0, 28));
    const t = name => qualified(ws.names.schema, name);
    const q = (sql, params) => db.platform.query(sql, params);
    const member = async () => {
      const id = randomUUID();
      await q(`INSERT INTO ${t('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [id, randomUUID()]);
      return id;
    };
    const account = async (membership, login, userId) => {
      const id = randomUUID();
      await q(
        `INSERT INTO ${t('tf_github_accounts')} (id,owner_membership_id,state,config_hash,identity,credential) VALUES ($1,$2,'active','h',$3,'{}')`,
        [id, membership, { id: userId, login }],
      );
      return id;
    };
    const intent = async (membership, accountKey, label, created = 'now()') => {
      const id = randomUUID();
      await q(
        `INSERT INTO ${t('tf_knowledge_default_intents')} (id,product,membership_id,account_key,account_label,sync_state,failure,attempts,created_at)
        VALUES ($1,'github',$2,$3,$4,'failed','not-linked',3,${created})`,
        [id, membership, accountKey, label],
      );
      return id;
    };
    const source = async (membership, intentId, binding) => {
      const id = randomUUID();
      await q(
        `INSERT INTO ${t('tf_knowledge_sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,'github',$2,jsonb_build_object('id',$4::text),$3)`,
        [id, binding.githubUserId, membership, id],
      );
      await q(
        `INSERT INTO ${t('tf_knowledge_github_sources')} (source_id,binding,selection,title,fingerprint,cursor,sync_state,failure)
        VALUES ($1,$2,$3,'all','f',$4,'failed','not-linked')`,
        [
          id,
          binding,
          { scope: 'all', repositories: [], kinds: ['docs'] },
          { phase: 'listing', index: 0, page: null, after: null, pages: 0 },
        ],
      );
      await q(
        `INSERT INTO ${t('tf_knowledge_default_sources')} (source_id,intent_id,ordinal,selection,state) VALUES ($1,$2,1,'{}','created')`,
        [id, intentId],
      );
      return id;
    };

    // One stuck intent whose login still matches the member's new account row.
    const owner = ws.membershipId;
    const fresh = await account(owner, 'octo', '101');
    const stuck = await intent(owner, randomUUID(), 'octo');
    const oldSource = await source(owner, stuck, {
      accountId: randomUUID(),
      accountGeneration: 1,
      githubUserId: '101',
      login: 'octo',
    });
    // A renamed user is found through the sources the intent created; two stuck intents for that user keep only the oldest.
    const renamed = await member();
    const renamedAccount = await account(renamed, 'new-name', '303');
    const older = await intent(renamed, randomUUID(), 'old-name', "now()-interval '2 days'");
    const newer = await intent(renamed, randomUUID(), 'old-name');
    for (const id of [older, newer])
      await source(renamed, id, {
        accountId: randomUUID(),
        accountGeneration: 1,
        githubUserId: '303',
        login: 'old-name',
      });
    // A stuck intent whose user already has a working intent stops.
    const both = await member();
    const working = await account(both, 'hubot', '202');
    const healthy = await intent(both, working, 'hubot');
    const duplicate = await intent(both, randomUUID(), 'hubot');

    await q('BEGIN');
    await lockRolloutTarget(db.platform, stream, true);
    await q('COMMIT');
    await provisionWorkspace({
      connectionString: db.connectionString,
      workspaceId: ws.id,
      passwords: ws.passwords,
      initialAdmin: { userId: ws.userId, membershipId: ws.membershipId },
      migrations: stream,
    });
    const rows = Object.fromEntries(
      (
        await q(
          `SELECT id,state,account_key,account_label,github_user_id,sync_state,failure FROM ${t('tf_knowledge_default_intents')}`,
        )
      ).rows.map(row => [row.id, row]),
    );
    const view = id => {
      const { state, account_key, account_label, github_user_id, sync_state, failure } = rows[id];
      return { state, account_key, account_label, github_user_id, sync_state, failure };
    };
    const moved = (accountKey, label, userId) => ({
      state: 'active',
      account_key: accountKey,
      account_label: label,
      github_user_id: userId,
      sync_state: 'queued',
      failure: null,
    });
    assert.deepEqual(view(stuck), moved(fresh, 'octo', '101'));
    assert.deepEqual(view(older), moved(renamedAccount, 'new-name', '303'));
    assert.equal(rows[newer].state, 'opted-out');
    assert.equal(rows[newer].github_user_id, null);
    assert.equal(rows[healthy].github_user_id, '202');
    assert.equal(rows[healthy].state, 'active');
    assert.equal(rows[duplicate].state, 'opted-out');

    const runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
    });
    try {
      // The next pass retries the source still bound to the removed row.
      const retried = [];
      const github = {
        discover: async () => ({ items: [], nextCursor: null }),
        configure: async () => assert.fail('a covered intent creates no source'),
        manage: async (_ws, _user, sourceId, value) => retried.push({ sourceId, action: value.action }),
      };
      const defaults = createDefaultKnowledge({ runtime, engines: { github }, enabled: async () => true });
      for (const work of (await defaults.due(ws.id)).filter(w => w.intentId === stuck)) await defaults.process(work);
      assert.deepEqual(retried, [{ sourceId: oldSource, action: 'retry' }]);

      // A later account row for the same GitHub user takes the intent over instead of adding one.
      const record = input =>
        runtime.transaction(ws.id, commonCompatibility, tx => recordDefaultKnowledgeIntent(tx, input));
      const other = await account(owner, 'octo-alt', '102');
      assert.notEqual(
        (
          await record({
            product: 'github',
            membershipId: owner,
            accountKey: other,
            accountLabel: 'octo-alt',
            githubUserId: '102',
          })
        ).intentId,
        stuck,
      );
      await q(`DELETE FROM ${t('tf_github_accounts')} WHERE id=$1`, [fresh]);
      const next = await account(owner, 'octo', '101');
      const taken = await record({
        product: 'github',
        membershipId: owner,
        accountKey: next,
        accountLabel: 'octo',
        githubUserId: '101',
      });
      assert.deepEqual(taken, { intentId: stuck, created: true });
      assert.equal(
        (await q(`SELECT account_key FROM ${t('tf_knowledge_default_intents')} WHERE id=$1`, [stuck])).rows[0]
          .account_key,
        next,
      );
    } finally {
      await runtime.close?.();
    }
  } finally {
    await db.close();
  }
});
