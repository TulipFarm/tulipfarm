import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, canAccessTable, lockAuthorization, resolveActor } from '@tulipfarm/access';
import { rolloutCommonMigrations } from '@tulipfarm/workspace-storage/provisioning';
import { conversationFixture } from '../fixture.mjs';
import { seedLegacyChat } from '../legacy-chat.mjs';
import { projectProvenanceMigrations } from '../../src/provenance-migrations.ts';
import { createProjectMembership } from '../../src/project-membership.ts';
import { approvalFixture } from '../approval-fixture.mjs';
import { createConversationRequests } from '../../src/requests.ts';
import { createConversations } from '../../src/index.ts';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import {
  recordProvenance,
  bindArtifactProvenance,
  registerProjectRevisionProvenance,
  recordConversationResultProvenance,
  artifactSourceVisibility,
  ProvenanceConflict,
} from '../../src/provenance.ts';
import { createConversationExecutor } from '../../src/runtime.ts';

const known = (...dependencies) => ({ kind: 'known', dependencies });
const compose = async stream => projectProvenanceMigrations(stream);
const provenanceVersion = (await compose(await workspaceTableMigrations())).length;
const range = { minimum: provenanceVersion, maximum: provenanceVersion };
const actor = person => ({ kind: 'human', userId: person.userId, membershipId: person.membershipId });
const transaction = (f, action) => f.runtime.transaction(f.workspace.id, range, action);
async function member(f) {
  const person = { membershipId: randomUUID(), userId: randomUUID(), teamId: randomUUID() };
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    person.membershipId,
    person.userId,
  ]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,$2)`, [
    person.teamId,
    `Source readers ${person.teamId}`,
  ]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    person.membershipId,
    person.teamId,
  ]);
  return person;
}
async function resource(f, person) {
  const id = randomUUID();
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,$3,'Source','revision')`,
    [id, person.teamId, `r_${id.replaceAll('-', '')}`],
  );
  return id;
}
const status = (f, person, id) =>
  transaction(f, async tx => {
    await lockAuthorization(tx);
    const actor = await resolveActor(tx, person.userId);
    if (
      !(await canAccessTable(tx, actor, id, 'table.row.read')) &&
      !(await canAccessTable(tx, actor, id, 'table.schema.manage'))
    )
      throw new AccessDenied();
  });
const grant = (f, person, id, permission = 'table.row.read') =>
  transaction(f, async tx => {
    await lockAuthorization(tx, 'write');
    await tx.client.query(`INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
      person.teamId,
      id,
      permission,
    ]);
  });
const revoke = (f, person, id) =>
  transaction(f, async tx => {
    await lockAuthorization(tx, 'write');
    await tx.client.query(`DELETE FROM ${f.table('tf_grants')} WHERE team_id=$1 AND asset_id=$2`, [person.teamId, id]);
  });
async function message(f) {
  const sent = await seedLegacyChat(f, randomUUID(), 'Retained content');
  return { kind: 'message', id: sent.messageId };
}
async function record(f, direct, inputs = [], artifact) {
  return transaction(f, async tx => {
    const id = await recordProvenance(tx, { id: randomUUID(), direct, inputs });
    if (artifact) await bindArtifactProvenance(tx, { artifact, provenanceId: id });
    return id;
  });
}
const visible = (f, person, artifacts) =>
  transaction(f, async tx =>
    (await artifactSourceVisibility(tx, { reader: actor(person), artifacts })).map(item => item.visible),
  );

test('canonical answers map into immutable provenance without dropping private, unknown, or source restrictions', async () => {
  const f = await conversationFixture();
  let restarted;
  try {
    const owner = actor(f.workspace),
      teamId = randomUUID(),
      tableId = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Canonical owner')`, [teamId]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,'canonical_records','Canonical source','revision')`,
      [tableId, teamId],
    );
    const integrationId = randomUUID(),
      sourceId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integrations')} (id,owning_team_id,name,credential,creation_intent,created_by) VALUES ($1,$2,'Canonical integration','{}','{}','{}')`,
      [integrationId, teamId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_sources')} (id,integration_id,owner,repo) VALUES ($1,$2,'owner','repo')`,
      [sourceId, integrationId],
    );
    async function answer(sources) {
      const chatId = randomUUID();
      await f.store.create(f.workspace.id, owner.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(f.workspace.id, owner.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'Read the source' }],
      });
      assert.equal(
        await createConversationExecutor(f.runtime, async () => ({
          text: 'Retained canonical answer',
          sources,
        })).process({ workspaceId: f.workspace.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      const result = (
        await f.db.platform.query(`SELECT * FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [sent.turnId])
      ).rows[0];
      return { result, artifact: { kind: 'message', id: result.message_id } };
    }
    const tableAnswer = await answer([
      { kind: 'table', tableId },
      { kind: 'public-web', url: 'https://example.com/' },
    ]);
    const unknownAnswer = await answer([{ kind: 'unknown' }]);
    const publicAnswer = await answer([{ kind: 'public-web', url: 'https://example.com/' }]);
    const integrationAnswer = await answer([{ kind: 'integration-source', integrationId, sourceId }]);
    const missingPrivate = await answer([{ kind: 'private-conversation', conversationId: randomUUID() }]);
    const emptyAnswer = await answer([]);
    const oversized = await answer(Array.from({ length: 513 }, () => ({ kind: 'table', tableId: randomUUID() })));
    const other = await member(f),
      otherChat = randomUUID();
    await f.store.create(f.workspace.id, other.userId, { chatId: otherChat, commandId: randomUUID() });
    const mixedPrivate = await answer([{ kind: 'private-conversation', conversationId: otherChat }]);
    const privateChats = Array.from({ length: 513 }, () => randomUUID());
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversations')} (id,owner_user_id,owner_membership_id) SELECT id,$2,$3 FROM unnest($1::uuid[]) AS id`,
      [privateChats, owner.userId, owner.membershipId],
    );
    const repeatedOwner = await answer([
      ...privateChats.map(conversationId => ({ kind: 'private-conversation', conversationId })),
      { kind: 'unknown' },
    ]);
    const before = (await f.db.platform.query(`SELECT * FROM ${f.table('tf_conversation_results')} ORDER BY turn_id`))
      .rows;
    const migrations = await compose(await workspaceTableMigrations());
    assert.deepEqual(
      (
        await rolloutCommonMigrations({
          connectionString: f.db.connectionString,
          migrations,
          listWorkspaceIds: async () => [f.workspace.id],
        })
      ).results,
      [{ workspaceId: f.workspace.id, status: 'applied', errorCode: null }],
    );
    const cases = [tableAnswer, unknownAnswer, publicAnswer, integrationAnswer];
    for (const item of cases) {
      assert.equal(
        await transaction(f, tx => recordConversationResultProvenance(tx, item.result.turn_id)),
        item.result.message_id,
      );
      assert.equal(
        await transaction(f, tx => recordConversationResultProvenance(tx, item.result.turn_id)),
        item.result.message_id,
      );
    }
    await assert.rejects(
      transaction(f, tx => recordConversationResultProvenance(tx, missingPrivate.result.turn_id)),
      AccessDenied,
    );
    await assert.rejects(
      transaction(f, tx => recordConversationResultProvenance(tx, randomUUID())),
      AccessDenied,
    );
    await assert.rejects(
      transaction(f, tx => recordConversationResultProvenance(tx, oversized.result.turn_id)),
      /Too big/,
    );
    assert.deepEqual(
      (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_provenance')} WHERE id=ANY($1::uuid[])`, [
          [missingPrivate.result.message_id, oversized.result.message_id],
        ])
      ).rows,
      [],
    );
    await transaction(f, tx => recordConversationResultProvenance(tx, emptyAnswer.result.turn_id));
    await transaction(f, tx => recordConversationResultProvenance(tx, mixedPrivate.result.turn_id));
    await transaction(f, tx => recordConversationResultProvenance(tx, repeatedOwner.result.turn_id));
    const policy = async item =>
      (
        await f.db.platform.query(`SELECT direct FROM ${f.table('tf_provenance')} WHERE id=$1`, [
          item.result.message_id,
        ])
      ).rows[0].direct;
    assert.deepEqual(await policy(publicAnswer), known({ kind: 'requester-only', membershipId: owner.membershipId }));
    assert.deepEqual(await policy(emptyAnswer), known({ kind: 'requester-only', membershipId: owner.membershipId }));
    assert.deepEqual(await policy(unknownAnswer), {
      kind: 'legacy-unknown',
      originalReaders: [owner.membershipId],
      dependencies: [{ kind: 'requester-only', membershipId: owner.membershipId }],
    });
    assert.deepEqual(await policy(repeatedOwner), {
      kind: 'legacy-unknown',
      originalReaders: [owner.membershipId],
      dependencies: [{ kind: 'requester-only', membershipId: owner.membershipId }],
    });
    assert.deepEqual(await visible(f, f.workspace, [repeatedOwner.artifact]), [true]);
    assert.deepEqual(await visible(f, other, [repeatedOwner.artifact]), [false]);
    assert.deepEqual(
      await policy(tableAnswer),
      known({ kind: 'requester-only', membershipId: owner.membershipId }, { kind: 'table-read', tableId }),
    );
    const artifacts = cases.map(item => item.artifact);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='admin' WHERE id=$1`, [other.membershipId]);
    assert.deepEqual(await visible(f, other, [mixedPrivate.artifact, emptyAnswer.artifact]), [false, false]);
    assert.deepEqual(await visible(f, f.workspace, [mixedPrivate.artifact, emptyAnswer.artifact]), [false, true]);
    assert.deepEqual(await visible(f, other, artifacts), [false, false, false, false]);
    // Admin status does not reveal integration results; the owner needs explicit integration and source grants.
    assert.deepEqual(await visible(f, f.workspace, artifacts), [true, true, true, false]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_person_grants')} (integration_id,membership_id,permission) VALUES ($1,$2,'read'),($1,$2,'use')`,
      [integrationId, owner.membershipId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_source_person_grants')} (integration_id,source_id,membership_id) VALUES ($1,$2,$3)`,
      [integrationId, sourceId, owner.membershipId],
    );
    assert.deepEqual(await visible(f, f.workspace, artifacts), [true, true, true, true]);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='member' WHERE id=$1`, [
      owner.membershipId,
    ]);
    restarted = f.createRuntime();
    assert.deepEqual(
      (
        await restarted.transaction(f.workspace.id, range, tx =>
          artifactSourceVisibility(tx, { reader: owner, artifacts }),
        )
      ).map(row => row.visible),
      [false, true, true, true],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='admin' WHERE id=$1`, [owner.membershipId]);
    await f.db.platform.query(`UPDATE ${f.table('tf_integrations')} SET enabled=false WHERE id=$1`, [integrationId]);
    assert.deepEqual(await visible(f, f.workspace, artifacts), [true, true, true, false]);
    assert.deepEqual(
      (await f.db.platform.query(`SELECT * FROM ${f.table('tf_conversation_results')} ORDER BY turn_id`)).rows,
      before,
    );
    assert.deepEqual(await visible(f, f.workspace, [{ kind: 'turn', id: tableAnswer.result.turn_id }]), [true]);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
      owner.membershipId,
    ]);
    const replacement = { userId: owner.userId, membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      replacement.membershipId,
      replacement.userId,
    ]);
    assert.deepEqual(await visible(f, replacement, artifacts), [false, false, false, false]);
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('opt-in upgrade preserves unclassified history and distinguishes known-empty from legacy unknown', async () => {
  const f = await conversationFixture();
  try {
    const a = await message(f),
      b = await message(f),
      c = await message(f);
    const before = (await f.db.platform.query(`SELECT * FROM ${f.table('tf_conversation_parts')} ORDER BY message_id`))
      .rows;
    await assert.rejects(
      transaction(f, tx => artifactSourceVisibility(tx, { reader: actor(f.workspace), artifacts: [a] })),
      /incompatible_version/,
    );
    const canonical = await workspaceTableMigrations();
    await assert.rejects(
      projectProvenanceMigrations(canonical.filter(m => m.name !== '0001_baseline.sql')),
      /0001_baseline/,
    );
    const migrations = await compose(canonical);
    for (let replay = 0; replay < 2; replay++)
      assert.deepEqual(
        (
          await rolloutCommonMigrations({
            connectionString: f.db.connectionString,
            migrations,
            listWorkspaceIds: async () => [f.workspace.id],
          })
        ).results,
        [{ workspaceId: f.workspace.id, status: 'applied', errorCode: null }],
      );
    assert.deepEqual(
      (await f.db.platform.query(`SELECT * FROM ${f.table('tf_conversation_parts')} ORDER BY message_id`)).rows,
      before,
    );
    const other = await member(f);
    await record(f, known(), [], a);
    await record(f, { kind: 'legacy-unknown', originalReaders: [f.workspace.membershipId], dependencies: [] }, [], b);
    assert.deepEqual(await visible(f, f.workspace, [a, b, c]), [true, true, false]);
    assert.deepEqual(await visible(f, other, [a, b, c]), [true, false, false]);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='admin' WHERE id=$1`, [other.membershipId]);
    assert.deepEqual(await visible(f, other, [a, b]), [true, false]);
    const store = createConversations({
      transaction: (workspace, _range, action) => f.runtime.transaction(workspace, range, action),
    });
    const chatId = (
      await f.db.platform.query(`SELECT conversation_id FROM ${f.table('tf_conversation_messages')} WHERE id=$1`, [
        a.id,
      ])
    ).rows[0].conversation_id;
    await assert.rejects(store.read(f.workspace.id, other.userId, chatId), AccessDenied);
    assert.equal((await store.read(f.workspace.id, f.workspace.userId, chatId)).id, chatId);
  } finally {
    await f.close();
  }
});

test('one immutable binding policy covers persisted turns, tool results, requests, responses and protected approval exchanges', async () => {
  const f = await approvalFixture();
  try {
    const w = f.workspace,
      approval = await f.pending();
    assert.equal(
      (
        await f.resolver.decide(w.id, w.userId, approval.conversationId, approval.requestId, {
          commandId: randomUUID(),
          expectedRevision: 1,
          decision: 'reject',
        })
      ).status,
      'rejected',
    );
    assert.equal((await f.maintenance.execute(w.id, approval.migrationId)).status, 'rejected');
    const requests = createConversationRequests(f.runtime),
      fence = await f.start();
    const request = await requests.create(fence, {
      producerId: randomUUID(),
      prompt: 'Which day?',
      answerSchema: { kind: 'text' },
    });
    const responseId = randomUUID();
    assert.equal(
      (
        await requests.answer(w.id, w.userId, fence.origin.conversationId, request.requestId, responseId, {
          commandId: randomUUID(),
          expectedRevision: 1,
          answer: { kind: 'text', text: 'Tuesday' },
        })
      ).status,
      'answered',
    );
    const toolId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'schema.inspect','completed')`,
      [toolId, fence.origin.conversationId, fence.origin.turnId],
    );
    const migrations = await compose(await workspaceTableMigrations());
    assert.deepEqual(
      (
        await rolloutCommonMigrations({
          connectionString: f.db.connectionString,
          migrations,
          listWorkspaceIds: async () => [w.id],
        })
      ).results,
      [{ workspaceId: w.id, status: 'applied', errorCode: null }],
    );
    const person = await member(f);
    await grant(f, person, f.tableId);
    const messageId = (
      await f.db.platform.query(`SELECT source_message_id FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
        fence.origin.turnId,
      ])
    ).rows[0].source_message_id;
    const artifacts = [
      { kind: 'message', id: messageId },
      { kind: 'turn', id: fence.origin.turnId },
      { kind: 'tool-result', id: toolId },
      { kind: 'request', id: request.requestId },
      { kind: 'response', id: responseId },
      { kind: 'approval-request', id: approval.requestId },
      { kind: 'approval-resolution', id: approval.requestId },
    ];
    let previous = await record(f, known({ kind: 'table-read', tableId: f.tableId }));
    for (const artifact of artifacts) previous = await record(f, known(), [previous], artifact);
    assert.deepEqual(await visible(f, person, artifacts), [true, true, true, true, true, true, true]);
    await revoke(f, person, f.tableId);
    assert.deepEqual(await visible(f, person, artifacts), [false, false, false, false, false, false, false]);
    assert.deepEqual(await visible(f, w, artifacts), [true, true, true, true, true, true, true]);
    const confirmation = await connect(f.db.login(w, 'confirmation'));
    try {
      const tx = { client: confirmation, schema: w.names.schema };
      const receiptId = await recordProvenance(tx, { id: randomUUID(), direct: known(), inputs: [previous] });
      assert.equal(typeof receiptId, 'string');
      await assert.rejects(
        confirmation.query(`UPDATE ${f.table('tf_provenance')} SET inputs='{}'`),
        error => error.code === '42501',
      );
      await assert.rejects(
        confirmation.query(`DELETE FROM ${f.table('tf_provenance_artifacts')}`),
        error => error.code === '42501',
      );
      assert.deepEqual(
        (await confirmation.query(`SELECT closure FROM ${f.table('tf_provenance')} WHERE id=$1`, [receiptId])).rows[0]
          .closure,
        known({ kind: 'table-read', tableId: f.tableId }),
      );
    } finally {
      await confirmation.end();
    }
    const rolledBack = randomUUID();
    await assert.rejects(
      transaction(f, async tx => {
        const id = await recordProvenance(tx, { id: rolledBack, direct: known(), inputs: [] });
        await bindArtifactProvenance(tx, { artifact: { kind: 'request', id: randomUUID() }, provenanceId: id });
      }),
      error => error.code === '23503',
    );
    assert.deepEqual(
      (await f.db.platform.query(`SELECT id FROM ${f.table('tf_provenance')} WHERE id=$1`, [rolledBack])).rows,
      [],
    );
    assert.equal(
      (
        await f.db.platform.query(`SELECT answer FROM ${f.table('tf_conversation_responses')} WHERE id=$1`, [
          responseId,
        ])
      ).rows[0].answer.text,
      'Tuesday',
    );
  } finally {
    await f.close();
  }
});

test('derived closures survive restart, exact replay and attempted mutation; revocation is per reader', async () => {
  const f = await conversationFixture(compose);
  let restarted;
  try {
    const alice = await member(f),
      bob = await member(f),
      id = await resource(f, alice);
    await grant(f, alice, id);
    await grant(f, bob, id);
    const a = await message(f),
      b = await message(f),
      c = await message(f);
    const source = { kind: 'table-read', tableId: id };
    const tool = await record(f, known(source), [], a);
    const answer = await record(f, known(), [tool], b);
    const followup = await record(f, known(), [answer, tool, answer], c);
    const concurrent = { id: randomUUID(), direct: known(), inputs: [followup] };
    assert.deepEqual(
      await Promise.all([
        transaction(f, tx => recordProvenance(tx, concurrent)),
        transaction(f, tx => recordProvenance(tx, concurrent)),
      ]),
      [concurrent.id, concurrent.id],
    );
    assert.deepEqual(await visible(f, bob, [a, b, c]), [true, true, true]);
    assert.equal(
      await transaction(f, tx => recordProvenance(tx, { id: followup, direct: known(), inputs: [tool, answer] })),
      followup,
    );
    await assert.rejects(
      transaction(f, tx => recordProvenance(tx, { id: answer, direct: known(), inputs: [] })),
      ProvenanceConflict,
    );
    await assert.rejects(
      transaction(f, tx => bindArtifactProvenance(tx, { artifact: b, provenanceId: tool })),
      ProvenanceConflict,
    );
    await assert.rejects(record(f, known(), [randomUUID()]), AccessDenied);
    await assert.rejects(
      transaction(f, tx => recordProvenance(tx, { id: tool, direct: known(), inputs: [tool] })),
      ProvenanceConflict,
    );
    for (const sql of [
      `UPDATE ${f.table('tf_provenance')} SET closure='{"kind":"known","dependencies":[]}'`,
      `DELETE FROM ${f.table('tf_provenance')}`,
      `UPDATE ${f.table('tf_provenance_artifacts')} SET provenance_id='${tool}'`,
      `DELETE FROM ${f.table('tf_provenance_artifacts')}`,
    ]) {
      await assert.rejects(
        transaction(f, tx => tx.client.query(sql)),
        error => error.code === '42501',
      );
    }
    await revoke(f, bob, id);
    restarted = f.createRuntime();
    const readAfterRestart = person =>
      restarted.transaction(f.workspace.id, range, tx =>
        artifactSourceVisibility(tx, { reader: actor(person), artifacts: [a, b, c] }),
      );
    assert.deepEqual(
      (await readAfterRestart(bob)).map(item => item.visible),
      [false, false, false],
    );
    assert.deepEqual(
      (await readAfterRestart(alice)).map(item => item.visible),
      [true, true, true],
    );
    assert.deepEqual(
      (await readAfterRestart(f.workspace)).map(item => item.visible),
      [true, true, true],
    );
    await grant(f, bob, id);
    assert.deepEqual(await visible(f, bob, [a, b, c]), [true, true, true]);
    const closure = (
      await f.db.platform.query(`SELECT closure FROM ${f.table('tf_provenance')} WHERE id=$1`, [followup])
    ).rows[0].closure;
    assert.deepEqual(closure, known(source));
    const other = await f.db.create(await compose(await workspaceTableMigrations()));
    const isolated = await connect(f.db.login(other));
    try {
      await assert.rejects(
        isolated.query(`SELECT closure FROM ${f.table('tf_provenance')}`),
        error => error.code === '42501',
      );
    } finally {
      await isolated.end();
    }
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('schema reads use record-read OR schema-management without widening record reads', async () => {
  const f = await conversationFixture(compose);
  try {
    const person = await member(f),
      id = await resource(f, person),
      schema = await message(f),
      data = await message(f);
    await record(f, known({ kind: 'schema-read', tableId: id }), [], schema);
    await record(f, known({ kind: 'table-read', tableId: id }), [], data);
    for (const permission of ['table.row.read', 'table.schema.manage']) {
      await grant(f, person, id, permission);
      await status(f, person, id);
      assert.deepEqual(await visible(f, person, [schema, data]), [true, permission === 'table.row.read']);
      await revoke(f, person, id);
    }
    await assert.rejects(status(f, person, id), AccessDenied);
    assert.deepEqual(await visible(f, person, [schema, data]), [false, false]);
    assert.deepEqual(await visible(f, f.workspace, [schema, data]), [true, true]);
    const missing = await message(f);
    await record(f, known({ kind: 'schema-read', tableId: randomUUID() }), [], missing);
    assert.deepEqual(await visible(f, f.workspace, [missing]), [false]);
  } finally {
    await f.close();
  }
});

test('integration results require integration use, source permission and the live source binding; admin status grants none', async () => {
  const f = await conversationFixture(compose);
  try {
    const person = await member(f),
      integrationId = randomUUID(),
      otherIntegration = randomUUID(),
      sourceId = randomUUID(),
      a = await message(f);
    for (const id of [integrationId, otherIntegration])
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_integrations')} (id,owning_team_id,name,credential,creation_intent,created_by) VALUES ($1,$2,'Integration','{}','{}','{}')`,
        [id, person.teamId],
      );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_sources')} (id,integration_id,owner,repo) VALUES ($1,$2,'owner','repo')`,
      [sourceId, integrationId],
    );
    await record(f, known({ kind: 'integration-source', integrationId, sourceId }), [], a);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_grants')} (integration_id,team_id,permission) VALUES ($1,$2,'read'),($1,$2,'use')`,
      [integrationId, person.teamId],
    );
    assert.deepEqual(await visible(f, person, [a]), [false]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_source_grants')} (integration_id,source_id,team_id) VALUES ($1,$2,$3)`,
      [integrationId, sourceId, person.teamId],
    );
    assert.deepEqual(await visible(f, person, [a]), [true]);
    await f.db.platform.query(`DELETE FROM ${f.table('tf_integration_grants')} WHERE permission='use'`);
    assert.deepEqual(await visible(f, person, [a]), [false]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_grants')} (integration_id,team_id,permission) VALUES ($1,$2,'use')`,
      [integrationId, person.teamId],
    );
    assert.deepEqual(await visible(f, person, [a]), [true]);
    assert.deepEqual(await visible(f, f.workspace, [a]), [false]);
    await f.db.platform.query(`UPDATE ${f.table('tf_integrations')} SET enabled=false WHERE id=$1`, [integrationId]);
    for (const reader of [person, f.workspace]) assert.deepEqual(await visible(f, reader, [a]), [false]);
    await f.db.platform.query(`UPDATE ${f.table('tf_integrations')} SET enabled=true WHERE id=$1`, [integrationId]);
    await f.db.platform.query(
      `BEGIN; SET CONSTRAINTS ALL DEFERRED; DELETE FROM ${f.table('tf_integration_source_grants')}; UPDATE ${f.table('tf_integration_sources')} SET integration_id='${otherIntegration}' WHERE id='${sourceId}'; INSERT INTO ${f.table('tf_integration_source_grants')} (integration_id,source_id,team_id) VALUES ('${otherIntegration}','${sourceId}','${person.teamId}'); COMMIT`,
    );
    assert.deepEqual(await visible(f, person, [a]), [false]);
    await f.db.platform.query(
      `DELETE FROM ${f.table('tf_integration_source_grants')}; UPDATE ${f.table('tf_integration_sources')} SET integration_id='${integrationId}' WHERE id='${sourceId}'`,
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_source_grants')} (integration_id,source_id,team_id) VALUES ($1,$2,$3)`,
      [integrationId, sourceId, person.teamId],
    );
    assert.deepEqual(await visible(f, person, [a]), [true]);
    await f.db.platform.query(`UPDATE ${f.table('tf_integrations')} SET deleted_at=now(),credential=NULL WHERE id=$1`, [
      integrationId,
    ]);
    assert.deepEqual(await visible(f, person, [a]), [false]);
    assert.deepEqual(await visible(f, f.workspace, [a]), [false]);
  } finally {
    await f.close();
  }
});

test('project revision identity retains inherited restrictions and requester-only never transfers to a new incarnation', async () => {
  const f = await conversationFixture(compose);
  try {
    const person = await member(f),
      tableId = await resource(f, person),
      projectId = randomUUID(),
      revisionId = randomUUID();
    const projects = createProjectMembership(f.runtime, range);
    await projects.create(f.workspace.id, person.userId, { id: projectId, name: 'Retained revisions' });
    await grant(f, person, tableId);
    const origin = await record(f, known({ kind: 'table-read', tableId }));
    await transaction(f, tx => registerProjectRevisionProvenance(tx, { projectId, revisionId, provenanceId: origin }));
    const a = await message(f),
      b = await message(f),
      c = await message(f);
    await record(f, known({ kind: 'project-revision', projectId, revisionId }), [], a);
    await record(f, known({ kind: 'requester-only', membershipId: person.membershipId }), [], b);
    const legacy = await record(f, {
      kind: 'legacy-unknown',
      originalReaders: [person.membershipId],
      dependencies: [],
    });
    await record(f, known(), [legacy], c);
    const mixed = await message(f);
    const adminLegacy = await record(f, {
      kind: 'legacy-unknown',
      originalReaders: [f.workspace.membershipId],
      dependencies: [],
    });
    await record(f, known(), [legacy, adminLegacy], mixed);
    assert.deepEqual(await visible(f, person, [mixed]), [false]);
    assert.deepEqual(await visible(f, f.workspace, [mixed]), [false]);
    assert.deepEqual(await visible(f, person, [a, b, c]), [true, true, true]);
    // The admin is not a project member, so project-derived content stays hidden.
    assert.deepEqual(await visible(f, f.workspace, [a, b, c]), [false, false, false]);
    const replacement = await record(f, known());
    await assert.rejects(
      transaction(f, tx => registerProjectRevisionProvenance(tx, { projectId, revisionId, provenanceId: replacement })),
      ProvenanceConflict,
    );
    await projects.edit(f.workspace.id, person.userId, projectId, {
      expectedRevision: 0,
      name: 'Retained revisions',
      instructions: 'New instructions',
      archived: true,
    });
    assert.deepEqual(await visible(f, person, [a]), [true]);
    await revoke(f, person, tableId);
    assert.deepEqual(await visible(f, person, [a]), [false]);
    await grant(f, person, tableId);
    const successor = await member(f);
    await projects.member(f.workspace.id, person.userId, projectId, {
      membershipId: successor.membershipId,
      role: 'manager',
      removed: false,
    });
    await projects.member(f.workspace.id, person.userId, projectId, {
      membershipId: person.membershipId,
      role: 'manager',
      removed: true,
    });
    assert.deepEqual(await visible(f, person, [a]), [false]);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
      person.membershipId,
    ]);
    await assert.rejects(visible(f, person, [a, b, c]), AccessDenied);
    const replacementMember = { ...person, membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      replacementMember.membershipId,
      person.userId,
    ]);
    assert.deepEqual(await visible(f, replacementMember, [a, b, c]), [false, false, false]);
  } finally {
    await f.close();
  }
});

test('protected confirmation evaluates integration provenance without credential access', async () => {
  const f = await conversationFixture(compose);
  let confirmation;
  try {
    const person = await member(f),
      integrationId = randomUUID(),
      sourceId = randomUUID(),
      artifact = await message(f);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integrations')} (id,owning_team_id,name,credential,creation_intent,created_by) VALUES ($1,$2,'Protected source','{}','{}','{}')`,
      [integrationId, person.teamId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_sources')} (id,integration_id,owner,repo) VALUES ($1,$2,'owner','repo')`,
      [sourceId, integrationId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_grants')} (integration_id,team_id,permission) VALUES ($1,$2,'read'),($1,$2,'use')`,
      [integrationId, person.teamId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_source_grants')} (integration_id,source_id,team_id) VALUES ($1,$2,$3)`,
      [integrationId, sourceId, person.teamId],
    );
    const provenanceId = await record(f, known({ kind: 'integration-source', integrationId, sourceId }), [], artifact);
    confirmation = await connect(f.db.login(f.workspace, 'confirmation'));
    const read = async reader => {
      await confirmation.query('BEGIN');
      try {
        return await artifactSourceVisibility(
          { client: confirmation, schema: f.workspace.names.schema },
          { reader: actor(reader), artifacts: [artifact] },
        );
      } finally {
        await confirmation.query('ROLLBACK');
      }
    };
    const expected = visible => [{ artifact, provenanceId, visible }];
    assert.deepEqual(await read(person), expected(true));
    assert.deepEqual(await read(f.workspace), expected(false), 'admin status grants no integration source access');
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_person_grants')} (integration_id,membership_id,permission) VALUES ($1,$2,'read'),($1,$2,'use')`,
      [integrationId, f.workspace.membershipId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_integration_source_person_grants')} (integration_id,source_id,membership_id) VALUES ($1,$2,$3)`,
      [integrationId, sourceId, f.workspace.membershipId],
    );
    assert.deepEqual(await read(f.workspace), expected(true));
    await f.db.platform.query(
      `DELETE FROM ${f.table('tf_integration_grants')} WHERE integration_id=$1 AND permission='use'`,
      [integrationId],
    );
    assert.deepEqual(await read(person), expected(false));
    assert.deepEqual(await read(f.workspace), expected(true));
    await f.db.platform.query(`UPDATE ${f.table('tf_integrations')} SET enabled=false WHERE id=$1`, [integrationId]);
    assert.deepEqual(await read(f.workspace), expected(false));
    await assert.rejects(
      confirmation.query(`SELECT credential FROM ${f.table('tf_integrations')}`),
      error => error.code === '42501',
    );
    await assert.rejects(
      confirmation.query(`UPDATE ${f.table('tf_integrations')} SET enabled=true`),
      error => error.code === '42501',
    );
  } finally {
    await confirmation?.end();
    await f.close();
  }
});
