import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';
import { createTableProposals, createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { TableProposalError } from '@tulipfarm/tables/proposal-contracts';
import { bindTableSourceAuthorization, requireTableSources } from '../../../agents/src/table-sources.ts';
import { connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { creationAccessFixture } from './creation-access-fixture.mjs';
import { tableDefinition } from '../fixture.mjs';

async function setup() {
  const f = await creationAccessFixture();
  const { db, workspace, s, creator, runtime, chat, team } = f;
  const skillId = randomUUID(),
    revision = 'b'.repeat(64);
  await db.platform.query('BEGIN');
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skills(id,creator_id,saved_revision,active_revision,enabled)
     VALUES($1,$2,$3,$3,true)`,
    [skillId, creator.membershipId, revision],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skill_revisions(skill_id,revision,definition,author_id) VALUES($1,$2,$3,$4)`,
    [
      skillId,
      revision,
      { name: 'Records procedure', instructions: 'Create a table.', sources: [] },
      creator.membershipId,
    ],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skill_reviews(skill_id,revision,reviewer_id) VALUES($1,$2,$3)`,
    [skillId, revision, creator.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_skill_person_grants(skill_id,membership_id,permission) VALUES($1,$2,'read')`,
    [skillId, creator.membershipId],
  );
  await db.platform.query('COMMIT');
  const turn = (await db.platform.query(`SELECT id FROM ${s}.tf_conversation_turns WHERE conversation_id=$1`, [chat]))
    .rows[0].id;
  const access = { requireSources: requireTableSources, bindSourceAuthorization: bindTableSourceAuthorization };
  const proposals = createTableProposals({ runtime, ...access });
  const decisions = createTableProposalDecisions({
    runtime,
    ...access,
    resolveConfirmationCredential: async () => db.login(workspace, 'confirmation'),
  });
  let revisionNumber = 0;
  const publish = createTablePublication({
    runtime,
    ...access,
    prepareRevision: async input => ({
      commit: (++revisionNumber).toString(16).padStart(40, '0'),
      parentCommit: input.expectedParentCommit,
      bundle: { key: `test/${input.commandId}`, sha256: 'c'.repeat(64) },
      projection: { definition: input.definition },
    }),
  });
  const executor = (overrides = {}) =>
    createTableExecution({
      ...access,
      resolveMigrationCredential: async () => db.login(workspace, 'migration'),
      ...overrides,
    });
  const propose = async () => {
    const definition = tableDefinition({ owningTeamId: team });
    const proposal = await proposals.propose(
      workspace.id,
      creator,
      randomUUID(),
      { conversationId: chat, turnId: turn, sources: [{ kind: 'workspace-skill', skillId, revision }] },
      {
        plans: [
          {
            kind: 'schema',
            tableId: definition.id,
            expectedRevision: null,
            dependsOn: [],
            target: definition,
            transforms: { outputs: [] },
          },
        ],
      },
    );
    await decisions.decide(workspace.id, creator.userId, chat, proposal.id, {
      commandId: randomUUID(),
      digest: proposal.digest,
      decision: 'approve',
    });
    return { ...proposal, tableId: definition.id };
  };
  const ready = async proposal => {
    assert.equal(await f.advance(workspace.id, proposal.id), 'publish');
    await publish(workspace.id, proposal.id);
    assert.equal(await f.advance(workspace.id, proposal.id), 'more');
  };
  const active = async proposal =>
    (
      await db.platform.query(`SELECT id FROM ${s}.tf_table_generations WHERE table_id=$1 AND state='active'`, [
        proposal.tableId,
      ])
    ).rowCount;
  const status = proposal => proposals.status(workspace.id, creator.userId, chat, proposal.id);
  return { ...f, skillId, access, proposals, decisions, executor, propose, ready, active, status };
}

test('ten skill-backed approvals survive authorization lock contention without a failed receipt', async () => {
  const f = await setup();
  const blocker = await connect(f.db.login(f.workspace));
  try {
    for (let run = 0; run < 10; run++) {
      const proposal = await f.propose();
      await f.ready(proposal);
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,518204))', [
        f.workspace.names.schema,
      ]);
      const advancing = f.executor()(f.workspace.id, proposal.id);
      await delay(350);
      await blocker.query('COMMIT');
      assert.notEqual(await advancing, 'blocked');
      await f.finish(proposal);
      assert.equal((await f.status(proposal)).status, 'completed');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT 1 FROM ${f.s}.tf_table_proposal_receipts WHERE proposal_id=$1 AND receipt->>'status'='failed'`,
            [proposal.id],
          )
        ).rowCount,
        0,
      );
      assert.equal(await f.active(proposal), 1);
    }
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
  }
});

test('a rolled-back subtransaction activation is retried before recording any failure', async () => {
  const f = await setup(),
    proposal = await f.propose();
  await f.ready(proposal);
  let checks = 0;
  const advance = f.executor({
    requireSources: async (...args) => {
      await requireTableSources(...args);
      if (++checks === 1) await args[0].client.query('SAVEPOINT activation_probe');
    },
  });
  assert.equal(await advance(f.workspace.id, proposal.id), 'more');
  assert.ok(checks >= 3, 'The failed activation must be retried in a fresh transaction');
  assert.equal(await f.advance(f.workspace.id, proposal.id), 'completed');
  assert.equal((await f.status(proposal)).plans[0].receipt.status, 'completed');
});

test('exhausted activation retries stay blocked until an explicit resume, which clears the old failure', async () => {
  const f = await setup(),
    proposal = await f.propose();
  await f.ready(proposal);
  let attempts = 0;
  const advance = f.executor({
    resolveMigrationCredential: async () => {
      attempts++;
      return f.db.login(f.workspace, 'migration');
    },
    requireSources: async (...args) => {
      await requireTableSources(...args);
      await args[0].client.query('SAVEPOINT activation_probe');
    },
  });
  assert.equal(await advance(f.workspace.id, proposal.id), 'blocked');
  assert.equal(attempts, 5, 'Four activation attempts and one failure-recording transaction');
  const failed = await f.status(proposal);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.plans[0].receipt.code, 'table-activation-unavailable');
  assert.equal(await f.active(proposal), 0);
  assert.equal(await f.advance(f.workspace.id, proposal.id), 'blocked');
  assert.equal(await f.active(proposal), 0, 'Background attempts cannot create a table after recording failure');
  const resumed = await f.control(proposal, 'resume');
  assert.equal(resumed.status, 'approved');
  assert.equal(resumed.plans[0].receipt, null);
  assert.equal(await f.advance(f.workspace.id, proposal.id), 'more');
  const running = await f.status(proposal);
  assert.equal(running.status, 'running');
  assert.equal(running.plans[0].receipt, null);
  await f.finish(proposal);
  assert.equal((await f.status(proposal)).status, 'completed');
  assert.equal(await f.active(proposal), 1);
});

test('disabled and unreadable skill sources block execution without a storage failure', async () => {
  for (const reason of ['disabled', 'unreadable']) {
    const f = await setup(),
      proposal = await f.propose();
    await f.ready(proposal);
    if (reason === 'disabled')
      await f.db.platform.query(`UPDATE ${f.s}.tf_workspace_skills SET enabled=false WHERE id=$1`, [f.skillId]);
    else await f.db.platform.query(`DELETE FROM ${f.s}.tf_skill_person_grants WHERE skill_id=$1`, [f.skillId]);
    assert.equal(await f.executor()(f.workspace.id, proposal.id), 'blocked');
    assert.equal(
      (await f.status(proposal)).plans[0].receipt.code,
      reason === 'disabled' ? 'skill-unavailable' : 'access-denied',
    );
    assert.equal(await f.active(proposal), 0);
    assert.equal(await f.executor()(f.workspace.id, proposal.id), 'blocked');
    assert.equal(await f.active(proposal), 0);
  }
});

test('an aborted attempt cannot block a successor that progressed before failure recovery', async () => {
  const f = await setup(),
    proposal = await f.propose();
  await f.ready(proposal);
  const recovering = Promise.withResolvers(),
    release = Promise.withResolvers();
  let connections = 0;
  const advance = f.executor({
    resolveMigrationCredential: async () => {
      if (++connections === 2) {
        recovering.resolve();
        await release.promise;
      }
      return f.db.login(f.workspace, 'migration');
    },
    requireSources: async () => {
      throw new TableProposalError('proposal-stale');
    },
  });
  const failed = advance(f.workspace.id, proposal.id);
  await recovering.promise;
  try {
    assert.equal(await f.advance(f.workspace.id, proposal.id), 'more');
  } finally {
    release.resolve();
  }
  assert.equal(await failed, 'wait');
  assert.equal(await f.advance(f.workspace.id, proposal.id), 'completed');
  assert.equal((await f.status(proposal)).plans[0].receipt.status, 'completed');
});
