import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { conversationResult, mergeSources } from '../../conversations/src/results.ts';
import { requireDraftSources } from '../src/draft-sources.ts';
import { resultSources } from '../src/tool-sources.ts';
import { createChatTools } from '../src/tools.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('finite resource results retain every returned source and distinguish schema from record rights', async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    actor = { kind: 'human', membershipId: randomUUID(), userId: randomUUID() },
    team = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    actor.membershipId,
    actor.userId,
  ]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Source readers')`, [team]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    actor.membershipId,
    team,
  ]);
  const first = randomUUID(),
    second = randomUUID();
  for (const [id, permission] of [
    [first, 'table.schema.manage'],
    [second, 'table.row.read'],
  ]) {
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,$3,'Source','revision')`,
      [id, team, `r_${id.replaceAll('-', '')}`],
    );
    await f.db.platform.query(`INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
      team,
      id,
      permission,
    ]);
  }
  // Neither table has an applied definition yet, so listing omits both instead of failing.
  const { tables } = (
    await createChatTools(f.runtime).invokeWithSources(
      { workspaceId: w.id, actor, callId: randomUUID() },
      { tool: 'tables.list' },
    )
  ).result;
  assert.deepEqual(
    tables.filter(table => table.id === first || table.id === second),
    [],
  );
  const listed = {
    tables: [
      { id: first, savedRevision: 'revision' },
      { id: second, savedRevision: 'revision' },
    ],
    total: 2,
    nextCursor: null,
  };
  const sources = await f.runtime.transaction(w.id, commonCompatibility, tx =>
    resultSources(tx, { tool: 'tables.list', limit: 25 }, listed),
  );
  assert.deepEqual(sources, [
    { kind: 'table-schema', tableId: first, revision: 'revision' },
    { kind: 'table-schema', tableId: second, revision: 'revision' },
  ]);
  const check = sources =>
    f.runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await requireDraftSources(tx, actor, sources);
    });
  await check(sources);
  await assert.rejects(check([{ kind: 'table', tableId: first }]), AccessDenied);
  await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1`, [second]);
  await assert.rejects(check(sources), AccessDenied);
  assert.deepEqual(conversationResult('Legacy text'), { text: 'Legacy text', sources: [{ kind: 'unknown' }] });
  const overflow = mergeSources(
    Array.from({ length: 1001 }, (_, index) => ({ kind: 'public-web', url: `https://example.com/${index}` })),
  );
  assert.deepEqual(overflow, [{ kind: 'unknown' }]);
  await assert.rejects(check(overflow), AccessDenied);
  await assert.rejects(check([{ kind: 'unavailable' }]), AccessDenied);
});
