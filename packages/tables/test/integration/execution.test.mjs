import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import {
  createTableProposals,
  createTableProposalDecisions,
  tableProposalDigest,
} from '../../../tables/dist/proposals.js';
import {
  createTableExecution,
  createTablePublication,
  executionCompatibility,
} from '../../../tables/dist/execution.js';
import { createTableCleanup } from '../../../tables/dist/cleanup.js';
import { generationProposalData, pruneHistoryValues } from '../../../tables/dist/store.js';
import { createTableService } from '../../../tables/dist/service.js';
import { AccessDenied } from '@tulipfarm/access';
import {
  readableTableFiles,
  requireTableFiles,
  requireTableImportReference,
  requireTableSources,
} from '../../../agents/src/table-sources.ts';
import { tableProposalOptions } from '../../../agents/src/table-proposals.ts';

const renameField = (definition, label) => ({
  ...definition,
  fields: definition.fields.map((field, index) => (index === 0 ? { ...field, label } : field)),
});

test(
  'approved creation, reviewed records, online exact transforms and atomic receipts under restricted roles',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const migrations = await workspaceTableMigrations();
    assert.equal(migrations.length, executionCompatibility.maximum);
    const ws = await db.create(migrations),
      s = `"${ws.names.schema}"`;
    runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
    const chat = randomUUID(),
      turn = randomUUID(),
      message = randomUUID(),
      team = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
      [chat, ws.userId, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
      [message, chat, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
      [turn, chat, message],
    );
    await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, ['a'.repeat(40)]);
    const access = { requireSources: requireTableSources };
    const proposals = createTableProposals({ runtime, ...access, data: generationProposalData });
    const decisions = createTableProposalDecisions({
      runtime,
      ...access,
      data: generationProposalData,
      resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
    });
    const advance = createTableExecution({
      ...access,
      resolveMigrationCredential: async () => db.login(ws, 'migration'),
      batchRows: 2,
      cutoverRows: 1,
    });
    const publications = [];
    const publish = createTablePublication({
      runtime,
      ...access,
      prepareRevision: async input => {
        publications.push(input);
        return {
          commit: String(publications.length).repeat(40),
          parentCommit: input.expectedParentCommit,
          bundle: { key: `test/${input.commandId}`, sha256: 'b'.repeat(64) },
          projection: { definition: input.definition },
        };
      },
    });
    const service = createTableService(runtime, { readableFiles: async () => new Set() }, executionCompatibility);
    const origin = {
      conversationId: chat,
      turnId: turn,
      sources: [{ kind: 'private-conversation', conversationId: chat }],
    };
    const approve = async plan => {
      const proposal = await proposals.propose(ws.id, actor, randomUUID(), origin, { plans: [plan] });
      await decisions.decide(ws.id, ws.userId, chat, proposal.id, {
        digest: proposal.digest,
        commandId: randomUUID(),
        decision: 'approve',
      });
      return proposal;
    };
    const finish = async proposal => {
      for (let i = 0; i < 100; i++) {
        const status = await advance(ws.id, proposal.id);
        if (status === 'completed' || status === 'blocked') return status;
        if (status === 'publish') await publish(ws.id, proposal.id);
      }
      assert.fail('execution did not converge');
    };
    const title = randomUUID(),
      notes = randomUUID(),
      table = randomUUID();
    const definition = {
      formatVersion: 2,
      id: table,
      owningTeamId: team,
      label: 'Tickets',
      fields: [title, notes].map(id => ({
        id,
        label: id === title ? 'Title' : 'Notes',
        kind: 'text',
        required: false,
        maxLength: 1000,
      })),
      uniqueKeys: [],
    };
    const create = await approve({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: null,
      target: definition,
      transforms: { outputs: [] },
    });
    const provenanceGrant = `SELECT(turn_id,sources) ON ${s}.tf_conversation_model_sources`,
      executors = `"${ws.names.migration}","${ws.names.customOwner}"`;
    await db.platform.query(`REVOKE ${provenanceGrant} FROM ${executors}`);
    assert.equal(await advance(ws.id, create.id), 'blocked');
    assert.deepEqual(
      [
        (await proposals.status(ws.id, ws.userId, chat, create.id)).status,
        (await proposals.status(ws.id, ws.userId, chat, create.id)).plans[0].receipt.code,
      ],
      ['failed', 'storage-fault'],
    );
    assert.equal(await advance(ws.id, create.id), 'blocked');
    await db.platform.query(`GRANT ${provenanceGrant} TO ${executors}`);
    await decisions.control(ws.id, ws.userId, chat, create.id, {
      digest: create.digest,
      commandId: randomUUID(),
      operation: 'resume',
    });
    assert.equal(await finish(create), 'completed');
    assert.equal(
      (await db.platform.query(`SELECT count(*)::int AS count FROM ${s}.tf_table_catalog WHERE id=$1`, [table])).rows[0]
        .count,
      1,
    );
    assert.deepEqual(publications[0].definition, definition);
    const revision = '1'.repeat(40);
    const record = randomUUID();
    const records = await approve({
      kind: 'records',
      tableId: table,
      dependsOn: [],
      expectedRevision: revision,
      changes: [
        {
          kind: 'create',
          recordId: record,
          values: { [title]: { kind: 'text', value: '  printer  ' }, [notes]: { kind: 'text', value: 'initial' } },
        },
      ],
    });
    assert.equal(await finish(records), 'completed');
    assert.equal(
      (await proposals.status(ws.id, ws.userId, chat, records.id)).plans[0].importProgress,
      null,
      'Record plans apply atomically and report no import progress',
    );
    assert.equal(
      (await service.read(ws.id, ws.userId, { tableId: table, revision, recordId: record })).values[title].value,
      '  printer  ',
    );
    const pendingRecord = await approve({
      kind: 'records',
      tableId: table,
      dependsOn: [],
      expectedRevision: revision,
      changes: [
        {
          kind: 'update',
          recordId: record,
          values: { [title]: { kind: 'text', value: 'must not overwrite transformed data' } },
        },
      ],
    });
    const versionsBefore = (
      await runtime.transaction(ws.id, executionCompatibility, tx =>
        generationProposalData.records(tx, table, null, [record]),
      )
    )[0];
    await assert.rejects(
      approve({
        kind: 'schema',
        tableId: table,
        dependsOn: [],
        expectedRevision: revision,
        target: { ...definition, label: 'Support tickets' },
        transforms: { outputs: [] },
      }),
      error => error.code === 'table-title-immutable',
    );
    const transform = await approve({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: revision,
      target: definition,
      transforms: { outputs: [{ fieldId: title, expression: { op: 'trim', input: { op: 'field', fieldId: title } } }] },
    });
    assert.equal((await proposals.status(ws.id, ws.userId, chat, transform.id)).status, 'approved');
    assert.equal(await advance(ws.id, transform.id), 'publish');
    assert.equal((await proposals.status(ws.id, ws.userId, chat, transform.id)).status, 'running');
    await publish(ws.id, transform.id);
    assert.equal(await advance(ws.id, transform.id), 'more');
    assert.equal(await advance(ws.id, transform.id), 'more');
    const before = await service.read(ws.id, ws.userId, { tableId: table, revision, recordId: record });
    await service.mutate(ws.id, ws.userId, {
      kind: 'update',
      tableId: table,
      revision,
      recordId: record,
      expectedToken: before.token,
      values: { [notes]: { kind: 'text', value: 'concurrent unrelated edit' } },
    });
    assert.equal(await finish(transform), 'completed');
    const after = await service.read(ws.id, ws.userId, { tableId: table, revision: '2'.repeat(40), recordId: record });
    assert.equal(after.values[title].value, 'printer');
    assert.equal(after.values[notes].value, 'concurrent unrelated edit');
    assert.equal(await finish(pendingRecord), 'blocked');
    assert.equal(
      (await proposals.status(ws.id, ws.userId, chat, pendingRecord.id)).plans[0].receipt.code,
      'proposal-stale',
    );
    const versionsAfter = (
      await runtime.transaction(ws.id, executionCompatibility, tx =>
        generationProposalData.records(tx, table, null, [record]),
      )
    )[0];
    assert.equal(versionsAfter.incarnation, versionsBefore.incarnation);
    assert.notEqual(versionsAfter.fieldVersions[title], versionsBefore.fieldVersions[title]);
    assert.equal(versionsAfter.fieldVersions[notes], after.token);
    const noteEdit = await service.mutate(ws.id, ws.userId, {
      kind: 'update',
      tableId: table,
      revision: '2'.repeat(40),
      recordId: record,
      expectedToken: after.token,
      values: { [notes]: after.values[notes] },
    });
    const versionsEdited = (
      await runtime.transaction(ws.id, executionCompatibility, tx =>
        generationProposalData.records(tx, table, null, [record]),
      )
    )[0];
    assert.equal(versionsEdited.fieldVersions[title], versionsAfter.fieldVersions[title]);
    assert.equal(versionsEdited.fieldVersions[notes], noteEdit.token);
    assert.equal(await advance(ws.id, transform.id), 'completed');
    assert.equal(
      (
        await db.platform.query(`SELECT count(*)::int AS n FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=$1`, [
          transform.id,
        ])
      ).rows[0].n,
      1,
    );
    const stale = await approve({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: '2'.repeat(40),
      target: definition,
      transforms: {
        outputs: [{ fieldId: title, expression: { op: 'literal', value: { kind: 'text', value: 'resolved' } } }],
      },
    });
    await publish(ws.id, stale.id);
    await advance(ws.id, stale.id);
    await advance(ws.id, stale.id);
    await service.mutate(ws.id, ws.userId, {
      kind: 'update',
      tableId: table,
      revision: '2'.repeat(40),
      recordId: record,
      expectedToken: noteEdit.token,
      values: { [title]: { kind: 'text', value: 'changed relevant value' } },
    });
    assert.equal(await finish(stale), 'blocked');
    assert.equal(
      (await service.read(ws.id, ws.userId, { tableId: table, revision: '2'.repeat(40), recordId: record })).values[
        title
      ].value,
      'changed relevant value',
    );
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::int AS n FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=$1 AND receipt->>'status'='completed'`,
          [stale.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal((await proposals.status(ws.id, ws.userId, chat, stale.id)).status, 'failed');
    const unapproved = await proposals.propose(ws.id, actor, randomUUID(), origin, {
      plans: [
        {
          kind: 'records',
          tableId: table,
          dependsOn: [],
          expectedRevision: '2'.repeat(40),
          changes: [
            { kind: 'update', recordId: record, values: { [title]: { kind: 'text', value: 'never approved' } } },
          ],
        },
      ],
    });
    assert.equal(await advance(ws.id, unapproved.id), 'blocked');
    assert.equal((await proposals.status(ws.id, ws.userId, chat, unapproved.id)).status, 'pending');
    assert.equal(
      (await service.read(ws.id, ws.userId, { tableId: table, revision: '2'.repeat(40), recordId: record })).values[
        title
      ].value,
      'changed relevant value',
    );
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT (SELECT count(*)::int FROM ${s}.tf_table_executions WHERE proposal_id=$1) executions,(SELECT count(*)::int FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=$1) receipts`,
          [unapproved.id],
        )
      ).rows[0],
      { executions: 0, receipts: 0 },
    );
    const corrected = await approve({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: '2'.repeat(40),
      target: definition,
      transforms: {
        outputs: [{ fieldId: title, expression: { op: 'literal', value: { kind: 'text', value: 'resolved' } } }],
      },
    });
    assert.equal(await finish(corrected), 'completed');
    const active = '4'.repeat(40);
    assert.equal(
      (await service.read(ws.id, ws.userId, { tableId: table, revision: active, recordId: record })).values[title]
        .value,
      'resolved',
    );
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const id = randomUUID();
      ids.push(id);
      await service.mutate(ws.id, ws.userId, {
        kind: 'create',
        tableId: table,
        revision: active,
        recordId: id,
        values: { [title]: { kind: 'text', value: 'stable' }, [notes]: { kind: 'text', value: 'before' } },
      });
    }
    const online = await approve({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: active,
      target: renameField(definition, 'Live rename'),
      transforms: { outputs: [] },
    });
    await publish(ws.id, online.id);
    await advance(ws.id, online.id);
    for (const id of ids) {
      const row = await service.read(ws.id, ws.userId, { tableId: table, revision: active, recordId: id });
      await service.mutate(ws.id, ws.userId, {
        kind: 'update',
        tableId: table,
        revision: active,
        recordId: id,
        expectedToken: row.token,
        values: { [notes]: { kind: 'text', value: 'after' } },
      });
    }
    assert.equal(await finish(online), 'completed');
    const live = await service.list(ws.id, ws.userId, { tableId: table, revision: '5'.repeat(40) });
    assert.equal(live.filter(row => ids.includes(row.id) && row.values[notes].value === 'after').length, 8);
    const continuous = await approve({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: '5'.repeat(40),
      target: renameField(definition, 'Continuous writes'),
      transforms: { outputs: [] },
    });
    const renameVersions = (
      await runtime.transaction(ws.id, executionCompatibility, tx =>
        generationProposalData.records(tx, table, null, [record]),
      )
    )[0];
    let stop = false,
      writes = 0;
    const writer = (async () => {
      while (!stop) {
        try {
          const row = await service.read(ws.id, ws.userId, {
            tableId: table,
            revision: '5'.repeat(40),
            recordId: record,
          });
          await service.mutate(ws.id, ws.userId, {
            kind: 'update',
            tableId: table,
            revision: '5'.repeat(40),
            recordId: record,
            expectedToken: row.token,
            values: { [notes]: { kind: 'text', value: `write-${writes + 1}` } },
          });
          writes++;
        } catch (error) {
          if (error.code !== 'stale-generation') throw error;
          break;
        }
      }
    })();
    try {
      assert.equal(await finish(continuous), 'completed');
    } finally {
      stop = true;
      await writer;
    }
    assert.ok(writes > 0);
    assert.equal(
      (await service.read(ws.id, ws.userId, { tableId: table, revision: '6'.repeat(40), recordId: record })).values[
        notes
      ].value,
      `write-${writes}`,
    );
    const renamedVersions = (
      await runtime.transaction(ws.id, executionCompatibility, tx =>
        generationProposalData.records(tx, table, null, [record]),
      )
    )[0];
    assert.equal(renamedVersions.fieldVersions[title], renameVersions.fieldVersions[title]);
    assert.equal(renamedVersions.incarnation, renameVersions.incarnation);
    for (const timing of ['before-copy', 'after-copy']) {
      const proposal = await approve({
        kind: 'schema',
        tableId: table,
        dependsOn: [],
        expectedRevision: '6'.repeat(40),
        target: definition,
        transforms: { outputs: [{ fieldId: title, expression: { op: 'field', fieldId: title } }] },
      });
      await publish(ws.id, proposal.id);
      await advance(ws.id, proposal.id);
      if (timing === 'after-copy') {
        for (let step = 0; step < 20; step++) {
          await advance(ws.id, proposal.id);
          if (
            (await db.platform.query(`SELECT phase FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [proposal.id]))
              .rows[0].phase === 'reconciling'
          )
            break;
        }
      }
      const row = await service.read(ws.id, ws.userId, { tableId: table, revision: '6'.repeat(40), recordId: record });
      await service.mutate(ws.id, ws.userId, {
        kind: 'update',
        tableId: table,
        revision: '6'.repeat(40),
        recordId: record,
        expectedToken: row.token,
        values: { [title]: row.values[title] },
      });
      assert.equal(await finish(proposal), 'blocked', timing);
      assert.equal(
        (await proposals.status(ws.id, ws.userId, chat, proposal.id)).plans[0].receipt.code,
        'proposal-stale',
      );
    }
    const recordProposal = await approve({
      kind: 'records',
      tableId: table,
      dependsOn: [],
      expectedRevision: '6'.repeat(40),
      changes: [
        { kind: 'update', recordId: record, values: { [title]: { kind: 'text', value: 'approved next value' } } },
      ],
    });
    const original = await service.read(ws.id, ws.userId, {
      tableId: table,
      revision: '6'.repeat(40),
      recordId: record,
    });
    const intermediate = await service.mutate(ws.id, ws.userId, {
      kind: 'update',
      tableId: table,
      revision: '6'.repeat(40),
      recordId: record,
      expectedToken: original.token,
      values: { [title]: { kind: 'text', value: 'temporary' } },
    });
    await service.mutate(ws.id, ws.userId, {
      kind: 'update',
      tableId: table,
      revision: '6'.repeat(40),
      recordId: record,
      expectedToken: intermediate.token,
      values: { [title]: original.values[title] },
    });
    assert.equal(await finish(recordProposal), 'blocked');
    assert.equal(
      (await proposals.status(ws.id, ws.userId, chat, recordProposal.id)).plans[0].receipt.code,
      'proposal-stale',
    );
    const restoredProposal = await approve({
      kind: 'records',
      tableId: table,
      dependsOn: [],
      expectedRevision: '6'.repeat(40),
      changes: [
        {
          kind: 'update',
          recordId: record,
          values: { [title]: { kind: 'text', value: 'must not apply after restore' } },
        },
      ],
    });
    const prior = await service.read(ws.id, ws.userId, { tableId: table, revision: '6'.repeat(40), recordId: record });
    const deleted = await service.mutate(ws.id, ws.userId, {
      kind: 'delete',
      tableId: table,
      revision: '6'.repeat(40),
      recordId: record,
      expectedToken: prior.token,
    });
    const historyId = (
      await db.platform.query(`SELECT id FROM ${s}.tf_table_row_history WHERE table_id=$1 AND row_id=$2 AND token=$3`, [
        table,
        record,
        deleted.token,
      ])
    ).rows[0].id;
    await service.mutate(ws.id, ws.userId, {
      kind: 'restore',
      tableId: table,
      revision: '6'.repeat(40),
      recordId: record,
      expectedToken: deleted.token,
      historyId,
      version: 'before',
    });
    assert.equal(await finish(restoredProposal), 'blocked');
    assert.equal(
      (await proposals.status(ws.id, ws.userId, chat, restoredProposal.id)).plans[0].receipt.code,
      'proposal-stale',
    );
    await assert.rejects(
      runtime.transaction(ws.id, executionCompatibility, tx =>
        tx.client.query(
          `INSERT INTO ${s}.tf_table_proposal_receipts(proposal_id,table_id,attempt,receipt) VALUES($1,$2,99,$3)`,
          [create.id, table, { status: 'completed', executionId: randomUUID(), revision: '6'.repeat(40) }],
        ),
      ),
      error => error.code === '42501',
    );
    const revoked = await approve({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: '6'.repeat(40),
      target: definition,
      transforms: { outputs: [] },
    });
    await publish(ws.id, revoked.id);
    await advance(ws.id, revoked.id);
    await db.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [ws.membershipId]);
    assert.equal(await advance(ws.id, revoked.id), 'blocked');
    assert.equal(
      (
        await db.platform.query(`SELECT revision FROM ${s}.tf_table_generations WHERE table_id=$1 AND state='active'`, [
          table,
        ])
      ).rows[0].revision,
      '6'.repeat(40),
    );
  },
);

test(
  'support relationships, file guards, staged history, import checkpoints and lifecycle',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const migrations = await workspaceTableMigrations();
    assert.equal(migrations.length, executionCompatibility.maximum);
    const ws = await db.create(migrations),
      s = `"${ws.names.schema}"`;
    runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId },
      chat = randomUUID(),
      turn = randomUUID(),
      message = randomUUID(),
      team = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
      [chat, ws.userId, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
      [message, chat, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
      [turn, chat, message],
    );
    await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, ['a'.repeat(40)]);
    const file = randomUUID(),
      allowed = new Set([file]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_files(id,kind,name,creator_membership_id,ready,object_key,size,media_type,sha256) VALUES($1,'file','Support attachment',$2,true,$3,1,'text/plain',$4)`,
      [file, ws.membershipId, randomUUID(), 'a'.repeat(64)],
    );
    let sourceAllowed = true,
      referenceAllowed = true,
      fileChecks = 0,
      referenceChecks = 0;
    const access = {
      requireSources: async (tx, actor, sources) => {
        if (!sourceAllowed) throw new AccessDenied();
        await requireTableSources(tx, actor, sources);
      },
      requireFiles: async (tx, actor, ids) => {
        fileChecks++;
        for (const id of ids) if (!allowed.has(id)) throw new AccessDenied();
        await requireTableFiles(tx, actor, ids);
      },
      readableFiles: async (tx, actor, ids) => {
        fileChecks++;
        return readableTableFiles(
          tx,
          actor,
          ids.filter(id => allowed.has(id)),
        );
      },
      requireImportReference: async (tx, actor, conversation, reference) => {
        assert.equal(conversation, chat);
        assert.equal(reference.kind, 'integration');
        referenceChecks++;
        if (!referenceAllowed) throw new AccessDenied();
        await requireTableImportReference(tx, actor, conversation, reference);
      },
    };
    const snapshots = new Map();
    const imports = { readSnapshot: async (_tx, _actor, _origin, reference) => snapshots.get(reference.resultId) };
    const proposals = createTableProposals({ ...tableProposalOptions(runtime), ...access, imports });
    const decisions = createTableProposalDecisions({
      ...tableProposalOptions(runtime),
      ...access,
      imports,
      resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
    });
    const advance = createTableExecution({
      ...access,
      resolveMigrationCredential: async () => db.login(ws, 'migration'),
      batchRows: 1,
      cutoverRows: 1,
    });
    let revisions = 0;
    const publish = createTablePublication({
      runtime,
      ...access,
      prepareRevision: async input => ({
        commit: (++revisions).toString(16).padStart(40, '0'),
        parentCommit: input.expectedParentCommit,
        bundle: { key: `test/${input.commandId}`, sha256: 'b'.repeat(64) },
        projection: { definition: input.definition },
      }),
    });
    const service = createTableService(
      runtime,
      { readableFiles: async (_tx, _actor, ids) => new Set(ids.filter(id => allowed.has(id))) },
      executionCompatibility,
    );
    const approve = async plan => {
      const p = await proposals.propose(
        ws.id,
        actor,
        randomUUID(),
        { conversationId: chat, turnId: turn, sources: [{ kind: 'private-conversation', conversationId: chat }] },
        { plans: [plan] },
      );
      await decisions.decide(ws.id, ws.userId, chat, p.id, {
        digest: p.digest,
        commandId: randomUUID(),
        decision: 'approve',
      });
      return p;
    };
    const finish = async p => {
      for (let i = 0; i < 100; i++) {
        const state = await advance(ws.id, p.id);
        if (state === 'completed' || state === 'blocked') return state;
        if (state === 'publish') await publish(ws.id, p.id);
      }
      assert.fail('did not converge');
    };
    const revision = async table =>
      (
        await db.platform.query(`SELECT revision FROM ${s}.tf_table_generations WHERE table_id=$1 AND state='active'`, [
          table,
        ])
      ).rows[0].revision;
    const schema = async (definition, transforms = { outputs: [] }) =>
      approve({
        kind: 'schema',
        tableId: definition.id,
        dependsOn: [],
        expectedRevision:
          (
            await db.platform.query(
              `SELECT revision FROM ${s}.tf_table_generations WHERE table_id=$1 AND state='active'`,
              [definition.id],
            )
          ).rows[0]?.revision ?? null,
        target: definition,
        transforms,
      });
    const text = label => ({ id: randomUUID(), label, kind: 'text', required: false, maxLength: 1000 });
    const customerName = text('Name'),
      customers = {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: team,
        label: 'Customers',
        fields: [customerName],
        uniqueKeys: [],
      };
    assert.equal(await finish(await schema(customers)), 'completed');
    const customer = await service.mutate(ws.id, ws.userId, {
      kind: 'create',
      tableId: customers.id,
      revision: await revision(customers.id),
      recordId: randomUUID(),
      values: { [customerName.id]: { kind: 'text', value: 'Acme' } },
    });
    const title = text('Title'),
      key = text('Source ID'),
      reverse = randomUUID(),
      relationship = {
        id: randomUUID(),
        label: 'Customer',
        kind: 'relationship',
        required: false,
        targetTableId: customers.id,
        cardinality: 'one',
        inverseCardinality: 'many',
        reverse: { fieldId: reverse, label: 'Tickets' },
        onDelete: 'restrict',
      },
      attachment = {
        id: randomUUID(),
        label: 'Files',
        kind: 'file',
        required: false,
        cardinality: 'many',
        access: 'independent',
      };
    const tickets = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Tickets',
      fields: [title, key, relationship, attachment],
      uniqueKeys: [{ id: randomUUID(), fieldIds: [key.id], nulls: 'distinct' }],
    };
    assert.equal(await finish(await schema(tickets)), 'completed');
    const record = randomUUID(),
      values = {
        [title.id]: { kind: 'text', value: '  printer  ' },
        [key.id]: { kind: 'text', value: 'T1' },
        [relationship.id]: { kind: 'relationship', tableId: customers.id, recordIds: [customer.id] },
        [attachment.id]: { kind: 'file', fileIds: [file] },
      };
    assert.equal(
      await finish(
        await approve({
          kind: 'records',
          tableId: tickets.id,
          dependsOn: [],
          expectedRevision: await revision(tickets.id),
          changes: [{ kind: 'create', recordId: record, values }],
        }),
      ),
      'completed',
    );
    assert.deepEqual(
      (await service.reverse(ws.id, ws.userId, { tableId: customers.id, recordId: customer.id, fieldId: reverse }))
        .recordIds,
      [record],
    );
    await assert.rejects(
      service.mutate(ws.id, ws.userId, {
        kind: 'delete',
        tableId: customers.id,
        revision: await revision(customers.id),
        recordId: customer.id,
        expectedToken: customer.token,
      }),
      /linked-record/,
    );
    const transform = await schema(tickets, {
      outputs: [{ fieldId: title.id, expression: { op: 'trim', input: { op: 'field', fieldId: title.id } } }],
    });
    await publish(ws.id, transform.id);
    await advance(ws.id, transform.id);
    await advance(ws.id, transform.id);
    assert.equal(
      (await service.history(ws.id, ws.userId, { tableId: tickets.id, recordId: record })).filter(
        entry => entry.operation === 'transform',
      ).length,
      0,
    );
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::int n FROM ${s}.tf_table_row_history_data WHERE operation='transform'`,
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      runtime.transaction(ws.id, executionCompatibility, tx =>
        tx.client.query(`SELECT * FROM ${s}.tf_table_row_history_data`),
      ),
      error => error.code === '42501',
    );
    assert.equal(await finish(transform), 'completed');
    const history = (await service.history(ws.id, ws.userId, { tableId: tickets.id, recordId: record })).find(
      entry => entry.operation === 'transform',
    );
    assert.equal(history.before_values[title.id].value, '  printer  ');
    assert.equal(history.values[title.id].value, 'printer');
    assert.equal(history.recoverable_until - history.created_at, 30 * 86400000);
    assert.deepEqual(
      (await service.reverse(ws.id, ws.userId, { tableId: customers.id, recordId: customer.id, fieldId: reverse }))
        .recordIds,
      [record],
    );
    const keptCutover = await schema(renameField(tickets, 'Kept file cutover'));
    await publish(ws.id, keptCutover.id);
    await advance(ws.id, keptCutover.id);
    await advance(ws.id, keptCutover.id);
    await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=clock_timestamp() WHERE id=$1`, [file]);
    assert.equal(
      await finish(keptCutover),
      'completed',
      'A copied row keeps a file reference its requester can no longer open',
    );
    await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=NULL WHERE id=$1`, [file]);
    const cancel = await schema(renameField(tickets, 'Resumed tickets'));
    await publish(ws.id, cancel.id);
    await advance(ws.id, cancel.id);
    await advance(ws.id, cancel.id);
    const control = async (p, operation) =>
      decisions.control(ws.id, ws.userId, chat, p.id, { digest: p.digest, commandId: randomUUID(), operation });
    await control(cancel, 'cancel');
    assert.equal(await advance(ws.id, cancel.id), 'blocked');
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::int n FROM ${s}.tf_table_executions WHERE table_id=$1 AND phase IN ('publishing','copying','reconciling')`,
          [tickets.id],
        )
      ).rows[0].n,
      0,
    );
    await control(cancel, 'resume');
    assert.equal(await finish(cancel), 'completed');
    const expired = await schema(renameField(tickets, 'Expired tickets'));
    await publish(ws.id, expired.id);
    await advance(ws.id, expired.id);
    await db.platform.query(
      `UPDATE ${s}.tf_table_proposals SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [expired.id],
    );
    assert.equal(await advance(ws.id, expired.id), 'blocked');
    assert.equal(
      (await db.platform.query(`SELECT error_code FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [expired.id]))
        .rows[0].error_code,
      'proposal-expired',
    );
    const importPlan = async names => {
      const resultId = randomUUID(),
        digest = 'c'.repeat(64),
        importTurn = randomUUID(),
        importMessage = randomUUID();
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,$3,'human',$4)`,
        [importMessage, chat, snapshots.size + 2, ws.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,$4)`,
        [importTurn, chat, importMessage, snapshots.size + 2],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_tool_calls(id,conversation_id,turn_id,tool,status,sequence) VALUES($1,$2,$3,'github.issue.read','completed',1)`,
        [resultId, chat, importTurn],
      );
      snapshots.set(resultId, {
        contentDigest: digest,
        sources: [{ kind: 'private-conversation', conversationId: chat }],
        rows: names.map((name, i) => ({
          id: { kind: 'text', value: name },
          title: { kind: 'text', value: `Imported ${i}` },
        })),
      });
      return {
        kind: 'import',
        tableId: tickets.id,
        dependsOn: [],
        expectedRevision: await revision(tickets.id),
        reference: { kind: 'integration', resultId, contentDigest: digest },
        matchFieldIds: [key.id],
        mappings: [
          { sourceColumn: 'id', fieldId: key.id },
          { sourceColumn: 'title', fieldId: title.id },
        ],
      };
    };
    const status = p => proposals.status(ws.id, ws.userId, chat, p.id);
    const progress = async p => (await status(p)).plans[0].importProgress;
    const recommendationRows = async () =>
      (
        await db.platform.query(
          `SELECT count(*)::int AS count FROM ${s}.tf_recommendation_events WHERE kind='rows' AND source_id=$1`,
          [tickets.id],
        )
      ).rows[0].count;
    const eventsBeforeImport = await recommendationRows();
    const imported = await approve(await importPlan(['I1', 'I2', 'I3']));
    assert.deepEqual(await progress(imported), { applied: 0, remaining: 3 });
    assert.equal(await advance(ws.id, imported.id), 'more');
    assert.equal((await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_import_receipts`)).rows[0].n, 1);
    assert.deepEqual(await progress(imported), { applied: 1, remaining: 2 });
    sourceAllowed = false;
    assert.equal(await advance(ws.id, imported.id), 'blocked');
    sourceAllowed = true;
    const lost = await status(imported);
    assert.deepEqual(
      [lost.status, lost.plans[0].receipt.code, lost.plans[0].importProgress],
      ['failed', 'access-denied', { applied: 1, remaining: 2 }],
    );
    await control(imported, 'resume');
    assert.deepEqual(await progress(imported), { applied: 1, remaining: 2 }, 'Resume keeps the committed batch');
    assert.equal(await advance(ws.id, imported.id), 'more');
    assert.equal(await advance(ws.id, imported.id), 'more');
    assert.deepEqual(
      await progress(imported),
      { applied: 2, remaining: 1 },
      'Resume continues after the committed batch',
    );
    assert.equal(
      await recommendationRows(),
      eventsBeforeImport,
      'partial import batches and blocked/resumed execution do not enqueue recommendations',
    );
    assert.equal(await finish(imported), 'completed');
    assert.equal(await advance(ws.id, imported.id), 'completed');
    assert.equal(
      await recommendationRows(),
      eventsBeforeImport + 1,
      'completion emits once and a replay is not another import',
    );
    assert.equal((await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_import_receipts`)).rows[0].n, 3);
    assert.deepEqual(await progress(imported), { applied: 3, remaining: 0 });
    const rows = await service.list(ws.id, ws.userId, { tableId: tickets.id, revision: await revision(tickets.id) });
    assert.equal(rows.filter(row => row.values[key.id]?.value.startsWith('I')).length, 3);
    for (let index = 0; index < 3; index++) {
      const hash = tableProposalDigest([imported.id, tickets.id, index]);
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      assert.equal(rows.find(row => row.id === id).values[key.id].value, `I${index + 1}`);
    }
    const stopped = await approve(await importPlan(['S1', 'S2']));
    assert.equal(await advance(ws.id, stopped.id), 'more');
    await control(stopped, 'cancel');
    assert.equal(await advance(ws.id, stopped.id), 'blocked');
    const cancelled = await status(stopped);
    assert.deepEqual(
      [cancelled.status, cancelled.plans[0].receipt.code, cancelled.plans[0].importProgress],
      ['cancelled', 'proposal-cancelled', { applied: 1, remaining: 1 }],
    );
    const duplicate = await importPlan(['D1', 'D1']);
    await assert.rejects(approve(duplicate), /invalid-import/);
    const insertedAfterReview = await approve(await importPlan(['new-match']));
    const newMatch = await service.mutate(ws.id, ws.userId, {
      kind: 'create',
      tableId: tickets.id,
      revision: await revision(tickets.id),
      recordId: randomUUID(),
      values: { [key.id]: { kind: 'text', value: 'new-match' } },
    });
    assert.equal(await finish(insertedAfterReview), 'blocked');
    assert.equal(
      (await proposals.status(ws.id, ws.userId, chat, insertedAfterReview.id)).plans[0].receipt.code,
      'proposal-stale',
    );
    await service.mutate(ws.id, ws.userId, {
      kind: 'delete',
      tableId: tickets.id,
      revision: await revision(tickets.id),
      recordId: newMatch.id,
      expectedToken: newMatch.token,
    });
    const staleImport = await approve(await importPlan(['T1']));
    const current = await service.read(ws.id, ws.userId, {
      tableId: tickets.id,
      revision: await revision(tickets.id),
      recordId: record,
    });
    await service.mutate(ws.id, ws.userId, {
      kind: 'update',
      tableId: tickets.id,
      revision: await revision(tickets.id),
      recordId: record,
      expectedToken: current.token,
      values: { [key.id]: current.values[key.id] },
    });
    assert.equal(await finish(staleImport), 'blocked');
    const updateImport = await approve(await importPlan(['T1']));
    assert.equal(await finish(updateImport), 'completed');
    const updated = await service.read(ws.id, ws.userId, {
      tableId: tickets.id,
      revision: await revision(tickets.id),
      recordId: record,
    });
    assert.equal(updated.values[title.id].value, 'Imported 0');
    assert.deepEqual(updated.values[relationship.id], values[relationship.id]);
    assert.deepEqual(updated.values[attachment.id], values[attachment.id]);
    await t.test('unchanged import matches are checked before every batch including zero effects', async () => {
      const unchanged = await approve(await importPlan(['T1']));
      assert.equal((await proposals.read(ws.id, ws.userId, chat, unchanged.id)).manifest.plans[0].effectCount, 0);
      assert.equal(await finish(unchanged), 'completed');
      const staleNoop = await approve(await importPlan(['T1']));
      const before = await service.read(ws.id, ws.userId, {
        tableId: tickets.id,
        revision: await revision(tickets.id),
        recordId: record,
      });
      await service.mutate(ws.id, ws.userId, {
        kind: 'update',
        tableId: tickets.id,
        revision: await revision(tickets.id),
        recordId: record,
        expectedToken: before.token,
        values: { [title.id]: before.values[title.id] },
      });
      assert.equal(await advance(ws.id, staleNoop.id), 'blocked');
      assert.equal(
        (await proposals.status(ws.id, ws.userId, chat, staleNoop.id)).plans[0].receipt.code,
        'proposal-stale',
      );
      const mixed = await approve(await importPlan(['T1', 'batch-first', 'batch-second']));
      assert.equal((await proposals.read(ws.id, ws.userId, chat, mixed.id)).manifest.plans[0].effectCount, 2);
      assert.equal(await advance(ws.id, mixed.id), 'more');
      const receipts = async () =>
        (
          await db.platform.query(
            `SELECT ordinal FROM ${s}.tf_table_import_receipts r JOIN ${s}.tf_table_executions e ON e.id=r.execution_id WHERE e.proposal_id=$1 ORDER BY ordinal`,
            [mixed.id],
          )
        ).rows;
      assert.equal((await receipts()).length, 1);
      const current = await service.read(ws.id, ws.userId, {
        tableId: tickets.id,
        revision: await revision(tickets.id),
        recordId: record,
      });
      await service.mutate(ws.id, ws.userId, {
        kind: 'update',
        tableId: tickets.id,
        revision: await revision(tickets.id),
        recordId: record,
        expectedToken: current.token,
        values: { [title.id]: current.values[title.id] },
      });
      assert.equal(await advance(ws.id, mixed.id), 'blocked');
      assert.equal((await proposals.status(ws.id, ws.userId, chat, mixed.id)).plans[0].receipt.code, 'proposal-stale');
      assert.deepEqual((await proposals.status(ws.id, ws.userId, chat, mixed.id)).plans[0].importProgress, {
        applied: 1,
        remaining: 1,
      });
      assert.equal((await receipts()).length, 1);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=ANY($1::uuid[]) AND receipt->>'status'='completed'`,
            [[staleNoop.id, mixed.id]],
          )
        ).rows[0].n,
        0,
      );
      const triggerGuard = await approve(await importPlan(['T1']));
      await db.platform
        .query(`CREATE FUNCTION ${s}.test_completion_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
      IF NEW.receipt->>'status'='completed' THEN
        INSERT INTO ${s}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields)
          SELECT table_id,row_id,false,ARRAY(SELECT jsonb_object_keys(mapped)) FROM ${s}.tf_table_proposal_matches WHERE proposal_id=NEW.proposal_id;
      END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER aa_test_completion_change BEFORE INSERT ON ${s}.tf_table_proposal_receipts FOR EACH ROW EXECUTE FUNCTION ${s}.test_completion_change()`);
      try {
        assert.equal(await advance(ws.id, triggerGuard.id), 'blocked');
        assert.equal(
          (await proposals.status(ws.id, ws.userId, chat, triggerGuard.id)).plans[0].receipt.code,
          'proposal-stale',
        );
      } finally {
        await db.platform.query(
          `DROP TRIGGER aa_test_completion_change ON ${s}.tf_table_proposal_receipts; DROP FUNCTION ${s}.test_completion_change()`,
        );
      }
    });
    const referenceRevoked = await approve(await importPlan(['R1', 'R2']));
    await advance(ws.id, referenceRevoked.id);
    referenceAllowed = false;
    assert.equal(await advance(ws.id, referenceRevoked.id), 'blocked');
    referenceAllowed = true;
    const audience = await approve(await importPlan(['A1']));
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'admin')`, [
      randomUUID(),
      randomUUID(),
    ]);
    assert.equal(await advance(ws.id, audience.id), 'blocked');
    const doomed = await service.mutate(ws.id, ws.userId, {
      kind: 'create',
      tableId: customers.id,
      revision: await revision(customers.id),
      recordId: randomUUID(),
      values: { [customerName.id]: { kind: 'text', value: 'Temporary' } },
    });
    const link = await approve({
      kind: 'records',
      tableId: tickets.id,
      dependsOn: [],
      expectedRevision: await revision(tickets.id),
      changes: [
        {
          kind: 'create',
          recordId: randomUUID(),
          values: { [relationship.id]: { kind: 'relationship', tableId: customers.id, recordIds: [doomed.id] } },
        },
      ],
    });
    await service.mutate(ws.id, ws.userId, {
      kind: 'delete',
      tableId: customers.id,
      revision: await revision(customers.id),
      recordId: doomed.id,
      expectedToken: doomed.token,
    });
    assert.equal(await finish(link), 'blocked');
    await t.test('staged links prevent target deletion and failed deletion preserves active links', async () => {
      const target = await service.mutate(ws.id, ws.userId, {
        kind: 'create',
        tableId: customers.id,
        revision: await revision(customers.id),
        recordId: randomUUID(),
        values: { [customerName.id]: { kind: 'text', value: 'Next customer' } },
      });
      const linked = await schema(tickets, {
        outputs: [
          {
            fieldId: relationship.id,
            expression: {
              op: 'literal',
              value: { kind: 'relationship', tableId: customers.id, recordIds: [target.id] },
            },
          },
        ],
      });
      await publish(ws.id, linked.id);
      await advance(ws.id, linked.id);
      await advance(ws.id, linked.id);
      await assert.rejects(
        service.mutate(ws.id, ws.userId, {
          kind: 'delete',
          tableId: customers.id,
          revision: await revision(customers.id),
          recordId: target.id,
          expectedToken: target.token,
        }),
        /linked-record/,
      );
      assert.deepEqual(
        (await service.reverse(ws.id, ws.userId, { tableId: customers.id, recordId: customer.id, fieldId: reverse }))
          .recordIds,
        [record],
      );
      assert.equal(await finish(linked), 'completed');
      assert.ok(
        (
          await service.reverse(ws.id, ws.userId, { tableId: customers.id, recordId: target.id, fieldId: reverse })
        ).recordIds.includes(record),
      );
      assert.deepEqual(
        (await service.reverse(ws.id, ws.userId, { tableId: customers.id, recordId: customer.id, fieldId: reverse }))
          .recordIds,
        [],
      );
    });
    await t.test('unique key swaps reconcile across one-row batches while active duplicates still fail', async () => {
      const code = text('Code'),
        definition = {
          formatVersion: 2,
          id: randomUUID(),
          owningTeamId: team,
          label: 'Swap keys',
          fields: [code],
          uniqueKeys: [{ id: randomUUID(), fieldIds: [code.id], nulls: 'distinct' }],
        };
      assert.equal(await finish(await schema(definition)), 'completed');
      const rev = await revision(definition.id),
        ids = [randomUUID(), randomUUID()].sort();
      const mutate = (id, value, token) =>
        service.mutate(ws.id, ws.userId, {
          kind: token ? 'update' : 'create',
          tableId: definition.id,
          revision: rev,
          recordId: id,
          ...(token ? { expectedToken: token } : {}),
          values: { [code.id]: { kind: 'text', value } },
        });
      let first = await mutate(ids[0], 'A'),
        second = await mutate(ids[1], 'B');
      const proposal = await schema(renameField(definition, 'Swapped'));
      await publish(ws.id, proposal.id);
      await advance(ws.id, proposal.id);
      await advance(ws.id, proposal.id);
      await advance(ws.id, proposal.id);
      await advance(ws.id, proposal.id);
      await assert.rejects(mutate(ids[0], 'B', first.token), /duplicate-key/);
      first = await mutate(ids[0], 'temporary', first.token);
      second = await mutate(ids[1], 'A', second.token);
      await mutate(ids[0], 'B', first.token);
      assert.equal(await advance(ws.id, proposal.id), 'more');
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${s}.tf_table_generation_conflicts c JOIN ${s}.tf_table_executions e ON e.target_generation=c.generation_id WHERE e.proposal_id=$1`,
            [proposal.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(await finish(proposal), 'completed');
      const result = await service.list(ws.id, ws.userId, {
        tableId: definition.id,
        revision: await revision(definition.id),
      });
      assert.deepEqual(
        result.map(row => row.values[code.id].value),
        ['B', 'A'],
      );
      const duplicate = await schema(definition, {
        outputs: [{ fieldId: code.id, expression: { op: 'literal', value: { kind: 'text', value: 'same' } } }],
      });
      assert.equal(await finish(duplicate), 'blocked');
      assert.deepEqual(
        (await service.list(ws.id, ws.userId, { tableId: definition.id, revision: await revision(definition.id) })).map(
          row => row.values[code.id].value,
        ),
        ['B', 'A'],
      );
    });
    await t.test('execution keeps unavailable file references and checks only added ones', async () => {
      const kept = randomUUID(),
        added = randomUUID();
      for (const id of [kept, added]) allowed.add(id);
      await db.platform.query(
        `INSERT INTO ${s}.tf_files(id,kind,name,creator_membership_id,ready,object_key,size,media_type,sha256) SELECT id,'file','Kept',$2,true,id,1,'text/plain',$3 FROM unnest($1::uuid[]) id`,
        [[kept, added], ws.membershipId, 'a'.repeat(64)],
      );
      const note = text('Note'),
        definition = {
          formatVersion: 2,
          id: randomUUID(),
          owningTeamId: team,
          label: 'Kept files',
          fields: [note, attachment],
          uniqueKeys: [],
        };
      assert.equal(await finish(await schema(definition)), 'completed');
      const row = randomUUID(),
        records = async changes =>
          approve({
            kind: 'records',
            tableId: definition.id,
            dependsOn: [],
            expectedRevision: await revision(definition.id),
            changes,
          });
      await service.mutate(ws.id, ws.userId, {
        kind: 'create',
        tableId: definition.id,
        revision: await revision(definition.id),
        recordId: row,
        values: { [note.id]: { kind: 'text', value: 'old' }, [attachment.id]: { kind: 'file', fileIds: [kept] } },
      });
      allowed.delete(kept);
      assert.equal(
        await finish(
          await records([{ kind: 'update', recordId: row, values: { [note.id]: { kind: 'text', value: 'new' } } }]),
        ),
        'completed',
      );
      assert.equal(await finish(await schema(renameField(definition, 'Kept files renamed'))), 'completed');
      const extended = await records([
        { kind: 'update', recordId: row, values: { [attachment.id]: { kind: 'file', fileIds: [kept, added] } } },
      ]);
      allowed.delete(added);
      assert.equal(await finish(extended), 'blocked');
      const [stored] = await service.list(ws.id, ws.userId, {
        tableId: definition.id,
        revision: await revision(definition.id),
      });
      assert.deepEqual(
        [stored.values[note.id], stored.values[attachment.id], stored.unavailableFileIds],
        [{ kind: 'text', value: 'new' }, { kind: 'file', fileIds: [kept] }, [kept]],
      );
    });
    await t.test(
      'more than 256 added file references revalidate in bounded pages after authority changes',
      async () => {
        const files = Array.from({ length: 270 }, () => randomUUID());
        for (const id of files) allowed.add(id);
        await db.platform.query(
          `INSERT INTO ${s}.tf_files(id,kind,name,creator_membership_id,ready,object_key,size,media_type,sha256) SELECT id,'file','Attachment',$2,true,id,1,'text/plain',$3 FROM unnest($1::uuid[]) id`,
          [files, ws.membershipId, 'a'.repeat(64)],
        );
        const definition = {
          formatVersion: 2,
          id: randomUUID(),
          owningTeamId: team,
          label: 'Many files',
          fields: [attachment],
          uniqueKeys: [],
        };
        assert.equal(await finish(await schema(definition)), 'completed');
        for (let offset = 0; offset < files.length; offset += 90)
          await service.mutate(ws.id, ws.userId, {
            kind: 'create',
            tableId: definition.id,
            revision: await revision(definition.id),
            recordId: randomUUID(),
            values: { [attachment.id]: { kind: 'file', fileIds: files.slice(offset, offset + 90) } },
          });
        const copied = { ...attachment, id: randomUUID(), label: 'Copied files' },
          recopied = { ...attachment, id: randomUUID(), label: 'Recopied files' };
        const copyInto = field => ({
          outputs: [{ fieldId: field.id, expression: { op: 'field', fieldId: attachment.id } }],
        });
        const copy = await schema({ ...definition, fields: [attachment, copied] }, copyInto(copied));
        await publish(ws.id, copy.id);
        await advance(ws.id, copy.id);
        for (let i = 0; i < 4; i++) assert.equal(await advance(ws.id, copy.id), 'more');
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::int n FROM ${s}.tf_table_execution_files f JOIN ${s}.tf_table_executions e ON e.id=f.execution_id WHERE e.proposal_id=$1`,
              [copy.id],
            )
          ).rows[0].n,
          270,
        );
        await db.platform.query(`UPDATE ${s}.tf_files SET name='Renamed' WHERE id=$1`, [files[0]]);
        assert.equal(await finish(copy), 'completed');
        const denied = await schema({ ...definition, fields: [attachment, copied, recopied] }, copyInto(recopied));
        await publish(ws.id, denied.id);
        await advance(ws.id, denied.id);
        for (let i = 0; i < 4; i++) await advance(ws.id, denied.id);
        await db.platform.query(`UPDATE ${s}.tf_files SET name='Recheck' WHERE id=$1`, [files[0]]);
        assert.equal(await advance(ws.id, denied.id), 'more');
        const checked = (
          await db.platform.query(
            `SELECT f.file_id FROM ${s}.tf_table_execution_files f JOIN ${s}.tf_table_executions e ON e.id=f.execution_id WHERE e.proposal_id=$1 AND f.authority_epoch=(SELECT lock_version FROM ${s}.tf_authorization_lock WHERE id=1) LIMIT 1`,
            [denied.id],
          )
        ).rows[0].file_id;
        await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=clock_timestamp() WHERE id=$1`, [checked]);
        assert.equal(await finish(denied), 'blocked');
      },
    );
    await t.test('proposal admission checks every added aggregate file reference', async () => {
      const files = Array.from({ length: 516 }, () => randomUUID());
      for (const id of files) allowed.add(id);
      await db.platform.query(
        `INSERT INTO ${s}.tf_files(id,kind,name,creator_membership_id,ready,object_key,size,media_type,sha256) SELECT id,'file','Evidence',$2,true,id,1,'text/plain',$3 FROM unnest($1::uuid[]) id`,
        [files, ws.membershipId, 'a'.repeat(64)],
      );
      const evidence = { ...attachment, id: randomUUID(), label: 'Evidence' };
      const definition = {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: team,
        label: 'Aggregate files',
        fields: [attachment, evidence],
        uniqueKeys: [],
      };
      assert.equal(await finish(await schema(definition)), 'completed');
      const first = files.slice(0, 258),
        second = files.slice(258),
        records = [randomUUID(), randomUUID()];
      const plan = async (kind, ids) => ({
        kind: 'records',
        tableId: definition.id,
        dependsOn: [],
        expectedRevision: await revision(definition.id),
        changes: records.map((recordId, i) => {
          const own = ids.slice(i * 129, (i + 1) * 129);
          return {
            kind,
            recordId,
            values: {
              [attachment.id]: { kind: 'file', fileIds: own.slice(0, 65) },
              [evidence.id]: { kind: 'file', fileIds: own.slice(65) },
            },
          };
        }),
      });
      const propose = async (id, kind, ids) =>
        proposals.propose(
          ws.id,
          actor,
          id,
          { conversationId: chat, turnId: turn, sources: [{ kind: 'private-conversation', conversationId: chat }] },
          { plans: [await plan(kind, ids)] },
        );
      const trash = (id, trashed) =>
        db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=${trashed ? 'clock_timestamp()' : 'NULL'} WHERE id=$1`, [
          id,
        ]);
      const stored = async id =>
        (await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_proposals WHERE id=$1`, [id])).rows[0].n;
      const stopped = [...first].sort().at(-1),
        rejectedId = randomUUID();
      await trash(stopped, true);
      await assert.rejects(
        propose(rejectedId, 'create', first),
        AccessDenied,
        'The last sorted added reference is checked',
      );
      assert.equal(await stored(rejectedId), 0);
      await trash(stopped, false);
      const created = await propose(randomUUID(), 'create', first);
      assert.equal(created.status, 'pending');
      assert.equal((await proposals.effects(ws.id, ws.userId, chat, created.id, definition.id, {})).total, 2);
      await trash(stopped, true);
      assert.deepEqual((await proposals.read(ws.id, ws.userId, chat, created.id)).unavailableFileIds, [stopped]);
      await assert.rejects(
        decisions.decide(ws.id, ws.userId, chat, created.id, {
          digest: created.digest,
          commandId: randomUUID(),
          decision: 'approve',
        }),
        AccessDenied,
      );
      await trash(stopped, false);
      assert.equal(
        (
          await decisions.decide(ws.id, ws.userId, chat, created.id, {
            digest: created.digest,
            commandId: randomUUID(),
            decision: 'approve',
          })
        ).status,
        'approved',
      );
      assert.equal(await finish(created), 'completed');
      const referenced = async () =>
        (await service.list(ws.id, ws.userId, { tableId: definition.id, revision: await revision(definition.id) }))
          .flatMap(row => [...row.values[attachment.id].fileIds, ...row.values[evidence.id].fileIds])
          .sort();
      assert.deepEqual(await referenced(), [...first].sort());
      await trash(stopped, true);
      const replaced = await propose(randomUUID(), 'update', second);
      assert.equal(
        (
          await decisions.decide(ws.id, ws.userId, chat, replaced.id, {
            digest: replaced.digest,
            commandId: randomUUID(),
            decision: 'approve',
          })
        ).status,
        'approved',
        'Removing an unavailable reference needs no access to it',
      );
      assert.equal(await finish(replaced), 'completed');
      assert.deepEqual(await referenced(), [...second].sort());
      await trash(stopped, false);
    });
    await t.test('deadline checkpoints survive worker replacement and verified timeout rollback', async () => {
      const value = text('Value'),
        definition = {
          formatVersion: 2,
          id: randomUUID(),
          owningTeamId: team,
          label: 'Budget proof',
          fields: [value],
          uniqueKeys: [],
        };
      assert.equal(await finish(await schema(definition)), 'completed');
      for (let i = 0; i < 12; i++)
        await service.mutate(ws.id, ws.userId, {
          kind: 'create',
          tableId: definition.id,
          revision: await revision(definition.id),
          recordId: randomUUID(),
          values: { [value.id]: { kind: 'text', value: '  value  ' } },
        });
      const proposal = await schema(definition, {
        outputs: [{ fieldId: value.id, expression: { op: 'trim', input: { op: 'field', fieldId: value.id } } }],
      });
      await publish(ws.id, proposal.id);
      await advance(ws.id, proposal.id);
      const job = async () =>
        (await db.platform.query(`SELECT * FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [proposal.id])).rows[0];
      await db.platform.query(
        `CREATE FUNCTION ${s}.budget_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$; CREATE TRIGGER budget_delay BEFORE INSERT ON ${s}.tf_table_execution_checks FOR EACH ROW EXECUTE FUNCTION ${s}.budget_delay()`,
      );
      const worker = () =>
        createTableExecution({ ...access, resolveMigrationCredential: async () => db.login(ws, 'migration') });
      const start = performance.now();
      assert.equal(await worker()(ws.id, proposal.id), 'more');
      const checkpoint = await job();
      assert.ok(
        checkpoint.checked_effects > 0 && checkpoint.checked_effects < 12,
        JSON.stringify({
          phase: checkpoint.phase,
          checked: checkpoint.checked_effects,
          failures: checkpoint.timeout_failures,
          ms: performance.now() - start,
        }),
      );
      assert.equal(checkpoint.phase, 'copying');
      assert.ok(performance.now() - start < 2000);
      await db.platform.query(
        `DROP TRIGGER budget_delay ON ${s}.tf_table_execution_checks; DROP FUNCTION ${s}.budget_delay()`,
      );
      const retained = (
        await db.platform.query(
          `SELECT id,row_id,created_at FROM ${s}.tf_table_row_history_data WHERE generation_id=$1 ORDER BY row_id`,
          [checkpoint.target_generation],
        )
      ).rows;
      for (const code of ['57014', '25P03']) {
        await db.platform.query(
          `CREATE FUNCTION ${s}.budget_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected timeout' USING ERRCODE='${code}'; END $$; CREATE TRIGGER budget_failure BEFORE INSERT ON ${s}.tf_table_execution_checks FOR EACH ROW EXECUTE FUNCTION ${s}.budget_failure()`,
        );
        const before = await job();
        assert.equal(await worker()(ws.id, proposal.id), 'more');
        const after = await job();
        assert.equal(after.checkpoint, before.checkpoint);
        assert.equal(after.checked_effects, before.checked_effects);
        assert.equal(after.timeout_failures, before.timeout_failures + 1);
        assert.ok(after.batch_limit < before.batch_limit);
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::int n FROM ${s}.tf_table_row_history_data WHERE generation_id=$1`,
              [checkpoint.target_generation],
            )
          ).rows[0].n,
          retained.length,
        );
        await db.platform.query(
          `DROP TRIGGER budget_failure ON ${s}.tf_table_execution_checks; DROP FUNCTION ${s}.budget_failure()`,
        );
      }
      let kill = true;
      const killed = createTableExecution({
        ...access,
        requireSources: async (tx, ...args) => {
          await access.requireSources(tx, ...args);
          if (kill) {
            kill = false;
            await tx.client.query("SET LOCAL statement_timeout='0'");
            await tx.client.query('SELECT pg_sleep(2.1)');
          }
        },
        resolveMigrationCredential: async () => db.login(ws, 'migration'),
      });
      assert.equal(await killed(ws.id, proposal.id), 'more');
      assert.equal((await job()).checkpoint, checkpoint.checkpoint);
      assert.equal((await job()).timeout_failures, 3);
      for (let i = 0; i < 30; i++) {
        if ((await worker()(ws.id, proposal.id)) === 'completed') break;
      }
      assert.equal((await job()).phase, 'completed');
      const history = (
        await db.platform.query(
          `SELECT id,row_id,created_at FROM ${s}.tf_table_row_history_data WHERE generation_id=$1 ORDER BY row_id`,
          [checkpoint.target_generation],
        )
      ).rows;
      assert.equal(history.length, 12);
      assert.deepEqual(history.slice(0, retained.length), retained);
      assert.equal(
        (
          await service.list(ws.id, ws.userId, { tableId: definition.id, revision: await revision(definition.id) })
        ).filter(row => row.values[value.id].value === 'value').length,
        12,
      );
      const stuck = await schema(renameField(definition, 'Permanent timeout'));
      await publish(ws.id, stuck.id);
      await advance(ws.id, stuck.id);
      await db.platform.query(
        `CREATE FUNCTION ${s}.budget_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'persistent timeout' USING ERRCODE='57014'; END $$; CREATE TRIGGER budget_failure BEFORE INSERT ON ${s}.tf_table_execution_checks FOR EACH ROW EXECUTE FUNCTION ${s}.budget_failure()`,
      );
      for (let i = 0; i < 7; i++) assert.equal(await worker()(ws.id, stuck.id), 'more');
      assert.equal(await worker()(ws.id, stuck.id), 'blocked');
      assert.equal(await worker()(ws.id, stuck.id), 'blocked');
      assert.equal(
        (
          await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=$1`, [
            stuck.id,
          ])
        ).rows[0].n,
        1,
      );
      await db.platform.query(
        `DROP TRIGGER budget_failure ON ${s}.tf_table_execution_checks; DROP FUNCTION ${s}.budget_failure()`,
      );
      assert.equal(await finish(await schema(renameField(definition, 'Replacement after timeout'))), 'completed');
      t.diagnostic(
        `Bounded copy committed ${retained.length}/12 rows before deadline; SQLSTATE 57014, 25P03 and real transaction termination preserved checkpoint and history across replacement executors`,
      );
    });
    await t.test('actual private source revocation blocks execution and releases the live slot', async () => {
      const privateChat = randomUUID();
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
        [privateChat, ws.userId, ws.membershipId],
      );
      const plan = {
        kind: 'schema',
        tableId: tickets.id,
        dependsOn: [],
        expectedRevision: await revision(tickets.id),
        target: renameField(tickets, 'Private source'),
        transforms: { outputs: [] },
      };
      const proposal = await proposals.propose(
        ws.id,
        actor,
        randomUUID(),
        {
          conversationId: chat,
          turnId: turn,
          sources: [{ kind: 'private-conversation', conversationId: privateChat }],
        },
        { plans: [plan] },
      );
      await decisions.decide(ws.id, ws.userId, chat, proposal.id, {
        digest: proposal.digest,
        commandId: randomUUID(),
        decision: 'approve',
      });
      await publish(ws.id, proposal.id);
      await advance(ws.id, proposal.id);
      await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id=$2 WHERE id=$1`, [
        privateChat,
        randomUUID(),
      ]);
      assert.equal(await advance(ws.id, proposal.id), 'blocked');
      assert.equal(
        (await db.platform.query(`SELECT error_code FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [proposal.id]))
          .rows[0].error_code,
        'access-denied',
      );
      assert.equal(await finish(await schema(renameField(tickets, 'Replacement after revocation'))), 'completed');
    });
    await t.test(
      'cleanup retains active, resumable and held generations and removes expired physical artifacts',
      async () => {
        const cleanup = createTableCleanup({
          resolveMigrationCredential: async () => db.login(ws, 'migration'),
          batchRows: 10,
        });
        const retired = (
          await db.platform.query(
            `SELECT g.* FROM ${s}.tf_table_generations g WHERE g.state='retired' AND EXISTS(SELECT 1 FROM ${s}.tf_table_row_history_data h WHERE h.generation_id=g.id) ORDER BY g.created_at LIMIT 1`,
          )
        ).rows[0];
        const held = (
          await db.platform.query(`SELECT id FROM ${s}.tf_table_row_history_data WHERE generation_id=$1 LIMIT 1`, [
            retired.id,
          ])
        ).rows[0].id;
        await db.platform.query(
          `UPDATE ${s}.tf_table_generations SET retired_at=clock_timestamp()-interval '31 days' WHERE id=$1`,
          [retired.id],
        );
        await db.platform.query(`INSERT INTO ${s}.tf_table_history_holds(history_id,holder_id) VALUES($1,$2)`, [
          held,
          randomUUID(),
        ]);
        const exists = async generation =>
          (
            await db.platform.query('SELECT to_regclass($1) IS NOT NULL present', [
              `${s}."${generation.physical_table}"`,
            ])
          ).rows[0].present;
        for (let i = 0; i < 100; i++) {
          if ((await cleanup(ws.id)) === 'completed') break;
        }
        assert.equal(await exists(retired), true);
        await db.platform.query(`DELETE FROM ${s}.tf_table_history_holds WHERE history_id=$1`, [held]);
        await db.platform.query(
          `UPDATE ${s}.tf_table_proposals SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id IN (SELECT proposal_id FROM ${s}.tf_table_executions WHERE phase='blocked' AND source_generation=$1)`,
          [retired.id],
        );
        for (let i = 0; i < 100; i++) {
          if ((await cleanup(ws.id)) === 'completed') break;
        }
        assert.equal(await exists(retired), true, 'Unexpired record recovery still protects the retired generation');
        await db.platform.query(
          `UPDATE ${s}.tf_table_generations SET activated_at=clock_timestamp()-interval '31 days' WHERE id=$1`,
          [retired.id],
        );
        await db.platform.query(
          `UPDATE ${s}.tf_table_row_history_data SET recoverable_until=clock_timestamp()-interval '1 day' WHERE generation_id=$1`,
          [retired.id],
        );
        for (let i = 0; i < 100; i++) {
          if ((await cleanup(ws.id)) === 'completed') break;
        }
        assert.equal(await exists(retired), false);
        assert.equal(
          (await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_row_history_data WHERE id=$1`, [held]))
            .rows[0].n,
          1,
        );
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::int n FROM ${s}.tf_table_generations WHERE state='active' AND physical_removed_at IS NOT NULL`,
            )
          ).rows[0].n,
          0,
        );
        const pending = await schema(renameField(tickets, 'Retained staging'));
        await publish(ws.id, pending.id);
        await advance(ws.id, pending.id);
        const building = (
          await db.platform.query(
            `SELECT g.* FROM ${s}.tf_table_generations g JOIN ${s}.tf_table_executions e ON e.target_generation=g.id WHERE e.proposal_id=$1`,
            [pending.id],
          )
        ).rows[0];
        await db.platform.query(
          `UPDATE ${s}.tf_table_generations SET created_at=clock_timestamp()-interval '31 days' WHERE id=$1`,
          [building.id],
        );
        await cleanup(ws.id);
        assert.equal(await exists(building), true);
        await control(pending, 'cancel');
        assert.equal(await advance(ws.id, pending.id), 'blocked');
        await cleanup(ws.id);
        assert.equal(await exists(building), true);
        await db.platform.query(
          `UPDATE ${s}.tf_table_proposals SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
          [pending.id],
        );
        for (let i = 0; i < 100; i++) {
          if ((await cleanup(ws.id)) === 'completed') break;
        }
        assert.equal(await exists(building), false);
        assert.ok(
          (await service.list(ws.id, ws.userId, { tableId: tickets.id, revision: await revision(tickets.id) })).length >
            0,
        );
      },
    );
    assert.ok(fileChecks > 3);
    assert.ok(referenceChecks > 3);
    await db.platform.query(
      `UPDATE ${s}.tf_table_generations SET activated_at=clock_timestamp()-interval '31 days' WHERE id=(SELECT generation_id FROM ${s}.tf_table_row_history_data WHERE id=$1)`,
      [history.id],
    );
    assert.equal(
      (await service.history(ws.id, ws.userId, { tableId: tickets.id, recordId: record })).find(
        entry => entry.id === history.id,
      ).values,
      null,
    );
    await pruneHistoryValues({ client: db.platform, schema: ws.names.schema });
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT operation,values,before_values FROM ${s}.tf_table_row_history_data WHERE id=$1`,
          [history.id],
        )
      ).rows[0],
      { operation: 'transform', values: null, before_values: null },
    );
  },
);
