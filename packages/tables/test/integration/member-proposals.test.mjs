import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture, loadPlatformBaseline } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createTableProposals, createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';
import { createTableService } from '@tulipfarm/tables/service';
import {
  activeGeneration,
  generationProposalData,
  projectWorkspaceMemberProfile,
  workspaceMembersTable,
} from '@tulipfarm/tables/store';
import {
  manualWorkspaceMemberValues,
  workspaceMemberAccess,
  workspaceMemberFields as fields,
} from '@tulipfarm/tables/workspace-members';
import { requireTableImportReference, requireTableSources } from '../../../agents/src/table-sources.ts';
import { createTableWithRows, text, textField } from '../fixture.mjs';

async function setup(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const workspace = await db.create(),
    s = `"${workspace.names.schema}"`;
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({
      workspaceId: workspace.id,
      generation: 1,
      connectionString: db.login(workspace),
    }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const actor = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
  const chat = randomUUID(),
    turn = randomUUID(),
    message = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`, [
    chat,
    actor.userId,
    actor.membershipId,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
    [message, chat, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turn, chat, message],
  );
  await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, ['a'.repeat(40)]);
  const snapshots = new Map();
  const access = { requireSources: requireTableSources, requireImportReference: requireTableImportReference };
  const options = {
    runtime,
    ...access,
    data: generationProposalData,
    imports: { readSnapshot: async (_tx, _actor, _origin, reference) => snapshots.get(reference.resultId) },
  };
  const proposals = createTableProposals(options);
  const decisions = createTableProposalDecisions({
    ...options,
    resolveConfirmationCredential: async () => db.login(workspace, 'confirmation'),
  });
  const advance = createTableExecution({
    ...access,
    resolveMigrationCredential: async () => db.login(workspace, 'migration'),
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
  const service = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  const directory = await runtime.transaction(workspace.id, commonCompatibility, async tx =>
    activeGeneration(tx, (await workspaceMembersTable(tx)).coreDefinition.id),
  );
  const origin = {
    conversationId: chat,
    turnId: turn,
    sources: [{ kind: 'private-conversation', conversationId: chat }],
  };
  const propose = plan => proposals.propose(workspace.id, actor, randomUUID(), origin, { plans: [plan] });
  const approve = proposal =>
    decisions.decide(workspace.id, actor.userId, chat, proposal.id, {
      commandId: randomUUID(),
      decision: 'approve',
      digest: proposal.digest,
    });
  const control = (proposal, operation) =>
    decisions.control(workspace.id, actor.userId, chat, proposal.id, {
      commandId: randomUUID(),
      operation,
      digest: proposal.digest,
    });
  const status = proposal => proposals.status(workspace.id, actor.userId, chat, proposal.id);
  const view = proposal => proposals.read(workspace.id, actor.userId, chat, proposal.id);
  const finish = async proposal => {
    for (let step = 0; step < 50; step++) {
      const result = await advance(workspace.id, proposal.id);
      if (result === 'completed' || result === 'blocked') return result;
      if (result === 'publish') await publish(workspace.id, proposal.id);
    }
    assert.fail('Member proposal execution did not converge');
  };
  const createPerson = name =>
    service.mutate(workspace.id, actor.userId, {
      kind: 'create',
      tableId: directory.table_id,
      revision: directory.revision,
      recordId: randomUUID(),
      values: manualWorkspaceMemberValues({ name }),
    });
  const setActive = async (memberId, active) => {
    const row = await service.read(workspace.id, actor.userId, {
      tableId: directory.table_id,
      revision: directory.revision,
      recordId: memberId,
    });
    return service.mutate(workspace.id, actor.userId, {
      kind: 'update',
      tableId: directory.table_id,
      revision: directory.revision,
      recordId: memberId,
      expectedToken: row.token,
      values: { [fields.active]: { kind: 'boolean', value: active } },
    });
  };
  const importPlan = async (definition, revision, mappings, rows) => {
    const resultId = randomUUID(),
      contentDigest = 'c'.repeat(64);
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_tool_calls(id,conversation_id,turn_id,tool,status,sequence)
      VALUES($1,$2,$3,'github.issue.read','completed',$4)`,
      [resultId, chat, turn, snapshots.size + 1],
    );
    snapshots.set(resultId, { contentDigest, sources: origin.sources, rows });
    return {
      kind: 'import',
      tableId: definition.id,
      expectedRevision: revision,
      dependsOn: [],
      reference: { kind: 'integration', resultId, contentDigest },
      matchFieldIds: definition.uniqueKeys[0].fieldIds,
      mappings,
    };
  };
  return {
    db,
    workspace,
    runtime,
    s,
    actor,
    directory,
    service,
    propose,
    approve,
    control,
    status,
    view,
    finish,
    createPerson,
    setActive,
    importPlan,
    advance,
  };
}

const records = (tableId, revision, recordId, values) => ({
  kind: 'records',
  tableId,
  expectedRevision: revision,
  dependsOn: [],
  changes: [{ kind: 'update', recordId, values }],
});
const schema = (generation, target, outputs = []) => ({
  kind: 'schema',
  tableId: generation.table_id,
  expectedRevision: generation.revision,
  dependsOn: [],
  target,
  transforms: { outputs },
});
const rejected = code => error => error.code === code;

test(
  'member proposal reviews protect complete profiles across records, transforms, and imports',
  { timeout: 45000 },
  async t => {
    const f = await setup(t);
    const manual = await f.createPerson('Manual member');
    const memberId = (
      await f.db.platform.query(`SELECT member_id FROM ${f.s}.tf_workspace_member_accounts WHERE membership_id=$1`, [
        f.actor.membershipId,
      ])
    ).rows[0].member_id;
    await f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
      projectWorkspaceMemberProfile(tx, {
        memberId,
        membershipId: f.actor.membershipId,
        profile: {
          id: f.actor.userId,
          revision: '1',
          name: 'Linked account',
          email: 'linked@example.test',
          image: 'https://example.test/linked.png',
        },
      }),
    );
    const update = (id, values) => f.propose(records(f.directory.table_id, f.directory.revision, id, values));
    for (const [id, values] of [
      [manual.id, { [fields.accountEmail]: text('forged@example.test') }],
      [manual.id, { [fields.photo]: text('https://example.test/forged.png') }],
      [manual.id, { [fields.access]: { kind: 'single-select', optionId: workspaceMemberAccess.active } }],
      [memberId, { [fields.name]: text('Not the account name') }],
      [memberId, { [fields.photo]: null }],
    ])
      await assert.rejects(update(id, values), rejected('member-field-protected'));
    await assert.rejects(
      f.propose({
        kind: 'records',
        tableId: f.directory.table_id,
        expectedRevision: f.directory.revision,
        dependsOn: [],
        changes: [{ kind: 'delete', recordId: memberId }],
      }),
      rejected('member-field-protected'),
    );
    await assert.rejects(
      f.propose(
        schema(f.directory, f.directory.definition, [
          { fieldId: fields.accountEmail, expression: { op: 'literal', value: text('forged@example.test') } },
        ]),
      ),
      rejected('member-field-protected'),
    );
    await assert.rejects(
      f.propose(schema(f.directory, { ...f.directory.definition, fields: f.directory.definition.fields.slice(1) })),
      rejected('member-field-protected'),
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.s}.tf_table_proposals`)).rows[0].count,
      0,
    );
    const linkedBefore = await f.service.read(f.workspace.id, f.actor.userId, {
      tableId: f.directory.table_id,
      revision: f.directory.revision,
      recordId: memberId,
    });
    const contact = await update(memberId, { [fields.contactEmail]: text('business@example.test') });
    await f.approve(contact);
    assert.equal(await f.finish(contact), 'completed');
    const linkedAfter = await f.service.read(f.workspace.id, f.actor.userId, {
      tableId: f.directory.table_id,
      revision: f.directory.revision,
      recordId: memberId,
    });
    for (const field of [fields.name, fields.photo, fields.accountEmail, fields.access])
      assert.deepEqual(linkedAfter.values[field], linkedBefore.values[field]);
    const workday = textField('Workday ID');
    const customized = {
      ...f.directory.definition,
      fields: [...f.directory.definition.fields, workday],
      uniqueKeys: [{ id: randomUUID(), fieldIds: [workday.id], nulls: 'distinct' }],
    };
    const customization = await f.propose(schema(f.directory, customized));
    await f.approve(customization);
    assert.equal(await f.finish(customization), 'completed');
    const next = await f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
      activeGeneration(tx, f.directory.table_id),
    );
    assert.deepEqual(next.definition, customized);
    const customValue = await f.propose(
      records(next.table_id, next.revision, memberId, { [workday.id]: text('EMP-1') }),
    );
    await f.approve(customValue);
    assert.equal(await f.finish(customValue), 'completed');
    const importValue = await f.importPlan(
      customized,
      next.revision,
      [
        { sourceColumn: 'id', fieldId: workday.id },
        { sourceColumn: 'email', fieldId: fields.accountEmail },
      ],
      [{ id: text('EMP-1'), email: text('forged@example.test') }],
    );
    await assert.rejects(f.propose(importValue), rejected('member-field-protected'));
    const final = await f.service.read(f.workspace.id, f.actor.userId, {
      tableId: next.table_id,
      revision: next.revision,
      recordId: memberId,
    });
    assert.equal(final.values[workday.id].value, 'EMP-1');
    assert.deepEqual(final.values[fields.accountEmail], linkedBefore.values[fields.accountEmail]);
  },
);

test(
  'member changes after review block approval or save an exact failure without losing kept links',
  { timeout: 45000 },
  async t => {
    const f = await setup(t);
    const person = await f.createPerson('Assignee');
    const title = textField('Title'),
      assignee = randomUUID(),
      reviewer = randomUUID();
    const relationship = id => ({
      id,
      kind: 'relationship',
      label: id === assignee ? 'Assignee' : 'Reviewer',
      required: false,
      targetTableId: f.directory.table_id,
      cardinality: 'many',
      inverseCardinality: 'many',
      reverse: null,
      onDelete: 'restrict',
    });
    const link = { kind: 'relationship', tableId: f.directory.table_id, recordIds: [person.id] };
    const tickets = await createTableWithRows({
      db: f.db,
      workspace: f.workspace,
      runtime: f.runtime,
      definition: {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: f.directory.definition.owningTeamId,
        label: 'Tickets',
        fields: [title, relationship(assignee), relationship(reviewer)],
        uniqueKeys: [{ id: randomUUID(), fieldIds: [title.id], nulls: 'distinct' }],
      },
      records: [{ values: { [title.id]: text('Initial'), [assignee]: link } }],
    });
    const ticket = tickets.records[0];
    const plan = records(tickets.tableId, tickets.revision, ticket.id, { [reviewer]: link });
    const pending = await f.propose(plan);
    await f.setActive(person.id, false);
    await assert.rejects(f.propose(plan), rejected('member-inactive'));
    await assert.rejects(f.approve(pending), rejected('member-inactive'));
    assert.equal((await f.status(pending)).decision, null);
    assert.equal((await f.view(pending)).freshness, 'stale');
    await assert.rejects(
      f.propose(
        schema(tickets.generation, tickets.definition, [
          { fieldId: reviewer, expression: { op: 'literal', value: link } },
        ]),
      ),
      rejected('member-inactive'),
    );
    const invalidImport = await f.importPlan(
      tickets.definition,
      tickets.revision,
      [
        { sourceColumn: 'title', fieldId: title.id },
        { sourceColumn: 'reviewer', fieldId: reviewer },
      ],
      [{ title: text('Initial'), reviewer: link }],
    );
    await assert.rejects(f.propose(invalidImport), rejected('member-inactive'));
    const retained = await f.propose(
      records(tickets.tableId, tickets.revision, ticket.id, { [title.id]: text('Kept inactive assignee') }),
    );
    await f.approve(retained);
    assert.equal(await f.finish(retained), 'completed');
    const read = () =>
      f.service.read(f.workspace.id, f.actor.userId, {
        tableId: tickets.tableId,
        revision: tickets.revision,
        recordId: ticket.id,
      });
    assert.deepEqual((await read()).values[assignee], link);
    await f.setActive(person.id, true);
    const approved = await f.propose(plan);
    await f.approve(approved);
    const before = await read();
    await f.setActive(person.id, false);
    assert.equal(await f.finish(approved), 'blocked');
    const failed = await f.status(approved);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.plans[0].receipt.status, 'failed');
    assert.equal(failed.plans[0].receipt.code, 'member-inactive');
    assert.deepEqual(await read(), before);
    assert.equal(await f.finish(approved), 'blocked');
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT count(*)::int AS count FROM ${f.s}.tf_table_proposal_receipts WHERE proposal_id=$1`,
          [approved.id],
        )
      ).rows[0].count,
      1,
    );
    await assert.rejects(f.control(approved, 'resume'), rejected('member-inactive'));
    await f.setActive(person.id, true);
    await f.control(approved, 'resume');
    assert.equal(await f.finish(approved), 'completed');
    assert.deepEqual((await read()).values[reviewer], link);
    assert.equal((await f.status(approved)).status, 'completed');
  },
);
