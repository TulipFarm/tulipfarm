import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import { applyCommonMigrations, inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { creationAccessFixture, permissions, assertCreationReplayDenied } from './creation-access-fixture.mjs';
import { tableDefinition } from '../fixture.mjs';

describe('unactivated creation upgrade', () => {
  let fixture;
  before(async () => {
    fixture = await creationAccessFixture(53);
  });
  test('a cancelled unactivated creation resumes with editor access after an upgrade', { timeout: 60000 }, async () => {
    const {
      db,
      workspace,
      s,
      team,
      creator,
      teammate,
      propose,
      approve,
      advance,
      publish,
      control,
      finish,
      permitted,
    } = fixture;
    const definition = tableDefinition({ owningTeamId: team }),
      proposal = await propose(definition);
    await approve(proposal);
    assert.equal(await advance(workspace.id, proposal.id), 'publish');
    await publish(workspace.id, proposal.id);
    assert.equal(await advance(workspace.id, proposal.id), 'more');
    assert.equal(
      (await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_catalog WHERE id=$1`, [definition.id]))
        .rows[0].n,
      1,
    );
    await control(proposal, 'cancel');
    assert.equal(await advance(workspace.id, proposal.id), 'blocked');
    await inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, db.baseline));
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::int n FROM ${s}.tf_table_creation_access_receipts WHERE table_id=$1`,
          [definition.id],
        )
      ).rows[0].n,
      0,
      'An unactivated catalog entry must not receive a creation-access receipt',
    );
    await control(proposal, 'resume');
    await finish(proposal);
    for (const actor of [creator, teammate])
      for (const permission of permissions) assert.equal(await permitted(actor, definition.id, permission), true);
  });
});

describe('completed creation upgrade', () => {
  let fixture;
  before(async () => {
    fixture = await creationAccessFixture(53);
  });
  test(
    'completed older creations stay completed without automatic access after upgrade',
    { timeout: 60000 },
    async () => {
      const { db, workspace, s, team, creator, teammate, chat, proposals, propose, approve, finish, permitted } =
        fixture;
      const legacy = tableDefinition({ owningTeamId: team }),
        proposal = await propose(legacy);
      await approve(proposal);
      await finish(proposal);
      assert.equal((await proposals.status(workspace.id, creator.userId, chat, proposal.id)).status, 'completed');
      assert.equal(await permitted(creator, legacy.id), false);
      const next = tableDefinition({ owningTeamId: team, label: 'Later records' }),
        pending = await propose(next);
      await approve(pending);
      await inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, db.baseline));
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${s}.tf_table_creation_access_receipts WHERE table_id=$1`,
            [legacy.id],
          )
        ).rows[0].n,
        1,
      );
      await finish(proposal);
      assert.equal((await proposals.status(workspace.id, creator.userId, chat, proposal.id)).status, 'completed');
      assert.equal(await permitted(creator, legacy.id), false);
      assert.equal(await permitted(teammate, legacy.id), false);
      await assertCreationReplayDenied(fixture, proposal.id, legacy.id);
      await finish(pending);
      assert.equal(await permitted(creator, next.id), true);
      assert.equal(await permitted(teammate, next.id), true);
    },
  );
});
