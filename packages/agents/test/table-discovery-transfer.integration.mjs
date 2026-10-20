import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { AccessDenied } from '@tulipfarm/access';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createGovernanceService } from '../../workspaces/dist/governance.js';
import { initializeSoul } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision, readVerifiedProjection } from '@tulipfarm/workspaces/soul-revisions';
import { createConversations } from '@tulipfarm/conversations';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createTableProposals, createTableProposalDecisions, tableProposalDigest } from '@tulipfarm/tables/proposals';
import { createTablePublication, createTableExecution, executionCompatibility } from '@tulipfarm/tables/execution';
import { generationProposalData, activeGeneration } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { createChatTools } from '../src/tools.ts';
import { tableProposalOptions } from '../src/table-proposals.ts';
import { requireTableSources } from '../src/table-sources.ts';
import { requireDraftSources } from '../src/draft-sources.ts';
import { effectiveProposalSources } from '../../tables/dist/proposal-sources.js';

async function setup(t) {
  const db = await fixture();
  const cleanup = [() => db.close()];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const migrations = await workspaceTableMigrations();
  const ws = await db.create(migrations),
    s = `"${ws.names.schema}"`;
  const runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  cleanup.push(() => runtime.close());
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const key = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'PUT') {
      if (objects.has(key)) {
        response.writeHead(412).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, {
        body: Buffer.concat(chunks),
        sha: request.headers['x-amz-meta-sha256'],
        command: request.headers['x-amz-meta-command-sha256'],
      });
      response.writeHead(200).end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'content-length': object.body.length,
        'x-amz-meta-sha256': object.sha,
        ...(object.command ? { 'x-amz-meta-command-sha256': object.command } : {}),
      })
      .end(object.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => server.close(resolve)));
  const soul = {
    bucket: 'regression',
    client: new S3Client({
      region: 'auto',
      endpoint: `http://127.0.0.1:${server.address().port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }),
  };
  cleanup.push(async () => soul.client.destroy());
  const seed = { workspaceId: ws.id, createdBy: ws.userId, createdAt: new Date().toISOString() };
  const initial = await initializeSoul(soul, seed);
  await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, [initial.commit]);
  const team = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Original owner')`, [team]);
  const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const conversations = createConversations(runtime);
  const options = tableProposalOptions(runtime);
  const proposals = createTableProposals(options);
  const decisions = createTableProposalDecisions({
    ...options,
    resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
  });
  const access = { requireSources: requireTableSources };
  const publish = createTablePublication({
    runtime,
    ...access,
    prepareRevision: input =>
      prepareSoulRevision(
        soul,
        seed,
        input.parent ? { ...input.parent, commit: input.expectedParentCommit, bucket: soul.bucket } : initial,
        {
          kind: 'table',
          commandId: input.commandId,
          expectedParentCommit: input.expectedParentCommit,
          createdAt: input.createdAt,
          definition: input.definition,
        },
      ),
  });
  const advance = createTableExecution({
    ...access,
    resolveMigrationCredential: async () => db.login(ws, 'migration'),
    batchRows: 2,
  });
  const tableService = createTableService(
    runtime,
    { readableFiles: async () => assert.fail('No files') },
    executionCompatibility,
  );
  const governance = createGovernanceService({ runtime, identity: db.platform, compatibility: executionCompatibility });
  const transaction = operation => runtime.transaction(ws.id, executionCompatibility, operation);
  const chatProposal = async (makePlan, requester = actor, discover = true) => {
    const discovery = discover === true ? { tool: 'tables.definitions', limit: 100 } : discover || null;
    const chat = randomUUID();
    await conversations.create(ws.id, requester.userId, { chatId: chat, commandId: randomUUID() });
    const sent = await conversations.send(ws.id, requester.userId, chat, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Review the requested table change' }],
    });
    let proposal,
      discovered,
      sources = [];
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      const invoke = async call => {
        const output = await executeTool(
          call.tool,
          false,
          context =>
            createChatTools(context.runtime).invokeWithSources(
              { ...context, origin: { ...context.origin, sources: [...context.origin.sources, ...sources] } },
              call,
            ),
          sources,
        );
        sources.push(...output.sources);
        return output.result;
      };
      if (discovery) discovered = await invoke(discovery);
      const plan = makePlan(discovered);
      proposal = await invoke({
        tool: 'tables.propose',
        input: JSON.stringify({ plans: Array.isArray(plan) ? plan : [plan] }),
      });
      return { text: 'Review this proposal.', sources };
    });
    assert.equal(
      await executor.process({ workspaceId: ws.id, conversationId: chat, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    assert.ok(proposal?.id, JSON.stringify(proposal));
    const manifest = (
      await db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [proposal.id])
    ).rows[0].manifest;
    assert.ok(
      manifest.sources.some(source => source.kind === 'private-conversation' && source.conversationId === chat),
    );
    if (discovery) assert.ok(manifest.sources.some(source => source.tableId === manifest.plans[0].input.tableId));
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT tool,status FROM ${s}.tf_conversation_tool_calls WHERE turn_id=$1 ORDER BY sequence`,
          [sent.turnId],
        )
      ).rows,
      [...(discovery ? [discovery.tool] : []), 'tables.propose'].map(tool => ({ tool, status: 'completed' })),
    );
    return { ...proposal, chat, requester, sources, manifest, discovered };
  };
  const approve = p =>
    decisions.decide(ws.id, p.requester.userId, p.chat, p.id, {
      commandId: randomUUID(),
      decision: 'approve',
      digest: p.digest,
    });
  const finish = async p => {
    for (let i = 0; i < 30; i++) {
      const status = await advance(ws.id, p.id);
      if (status === 'completed' || status === 'blocked') return status;
      if (status === 'publish') await publish(ws.id, p.id);
    }
    assert.fail('Execution did not converge');
  };
  const schema = (item, label) => ({
    kind: 'schema',
    tableId: item.id,
    expectedRevision: item.revision,
    dependsOn: [],
    target: { ...item.definition, label },
    transforms: { outputs: [] },
  });
  const create = async () => {
    const definition = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Tickets',
      fields: [{ id: randomUUID(), label: 'Title', kind: 'text', required: false, maxLength: 1000 }],
      uniqueKeys: [],
    };
    const p = await chatProposal(
      () => ({ ...schema({ id: definition.id, revision: null, definition }, definition.label) }),
      actor,
      false,
    );
    await approve(p);
    assert.equal(await finish(p), 'completed');
    return (await tableService.definitions(ws.id, actor)).tables.find(item => item.id === definition.id);
  };
  return {
    db,
    ws,
    s,
    team,
    actor,
    runtime,
    transaction,
    governance,
    tableService,
    create,
    schema,
    chatProposal,
    approve,
    finish,
    publish,
    advance,
    soul,
    proposals,
    decisions,
  };
}

for (const scenario of ['resume', 'external-change', 'revoked-read'])
  test(`two discovery-sourced schema groups preserve exact proposal provenance: ${scenario}`, async t => {
    const f = await setup(t);
    const a = await f.create(),
      b = await f.create();
    await f.db.platform.query(`UPDATE ${f.s}.tf_memberships SET role='member' WHERE id=$1`, [f.actor.membershipId]);
    for (const id of [a.id, b.id])
      for (const permission of ['table.schema.manage', 'table.row.read']) {
        await f.db.platform.query(
          `INSERT INTO ${f.s}.tf_table_person_grants(membership_id,asset_id,permission) VALUES($1,$2,$3)`,
          [f.actor.membershipId, id, permission],
        );
      }
    const p = await f.chatProposal(list => [
      f.schema(
        list.tables.find(row => row.id === a.id),
        'Completed A',
      ),
      {
        ...f.schema(
          list.tables.find(row => row.id === b.id),
          'Dependent B',
        ),
        dependsOn: [a.id],
      },
    ]);
    assert.ok(
      p.manifest.sources.some(
        source => source.kind === 'table-rows' && source.tableId === a.id && source.revision === a.revision,
      ),
    );
    assert.ok(
      p.manifest.sources.some(
        source => source.kind === 'table-rows' && source.tableId === b.id && source.revision === b.revision,
      ),
    );
    await f.approve(p);
    for (let step = 0; step < 30; step++) {
      const status = await f.advance(f.ws.id, p.id);
      assert.notEqual(status, 'blocked');
      if (status === 'publish') await f.publish(f.ws.id, p.id);
      if ((await f.proposals.status(f.ws.id, f.actor.userId, p.chat, p.id)).plans[0].receipt?.status === 'completed')
        break;
    }
    const partial = await f.proposals.status(f.ws.id, f.actor.userId, p.chat, p.id);
    assert.equal(partial.plans[0].receipt.status, 'completed');
    assert.equal(partial.plans[1].receipt, null);
    const review = () => f.proposals.read(f.ws.id, f.actor.userId, p.chat, p.id);
    const effects = () => f.proposals.effects(f.ws.id, f.actor.userId, p.chat, p.id, b.id, {});
    const control = operation =>
      f.decisions.control(f.ws.id, f.actor.userId, p.chat, p.id, {
        commandId: randomUUID(),
        digest: p.digest,
        operation,
      });
    assert.equal((await review()).freshness, 'current');
    assert.equal((await effects()).total, 0);
    await assert.rejects(
      f.transaction(tx => requireDraftSources(tx, f.actor, p.manifest.sources)),
      AccessDenied,
    );
    await f.transaction(async tx => {
      const check = async manifest =>
        requireTableSources(tx, f.actor, await effectiveProposalSources(tx, manifest, p.manifest.sources));
      await assert.rejects(
        check({ ...p.manifest, id: randomUUID() }),
        AccessDenied,
        'Another proposal cannot claim this completion',
      );
      await assert.rejects(
        check({
          ...p.manifest,
          plans: p.manifest.plans.map(plan =>
            plan.input.tableId === a.id ? { ...plan, input: { ...plan.input, expectedRevision: b.revision } } : plan,
          ),
        }),
        AccessDenied,
        'The original source must match the reviewed old revision',
      );
      await assert.rejects(
        check({
          ...p.manifest,
          plans: p.manifest.plans.map(plan =>
            plan.input.tableId === a.id
              ? {
                  ...plan,
                  input: {
                    kind: 'import',
                    tableId: a.id,
                    expectedRevision: a.revision,
                    dependsOn: [],
                    reference: { kind: 'integration', resultId: randomUUID(), contentDigest: 'a'.repeat(64) },
                    matchFieldIds: [a.definition.fields[0].id],
                    mappings: [{ sourceColumn: 'Title', fieldId: a.definition.fields[0].id }],
                  },
                }
              : plan,
          ),
        }),
        AccessDenied,
        'An imported copy cannot stand in for a schema transition',
      );
      const external = { kind: 'private-conversation', conversationId: randomUUID() };
      const sources = [...p.manifest.sources, external];
      const effective = await effectiveProposalSources(tx, p.manifest, sources);
      assert.deepEqual(effective.at(-1), external, 'Nonresource dependencies retain their exact identity');
      await assert.rejects(
        requireTableSources(tx, f.actor, effective),
        AccessDenied,
        'Completion never grants external source access',
      );
    });
    await control('cancel');
    if (scenario === 'external-change') {
      const external = await f.chatProposal(list =>
        f.schema(
          list.tables.find(row => row.id === a.id),
          'External A',
        ),
      );
      await f.approve(external);
      assert.equal(await f.finish(external), 'completed');
    } else if (scenario === 'revoked-read') {
      await f.db.platform.query(
        `DELETE FROM ${f.s}.tf_table_person_grants WHERE membership_id=$1 AND asset_id=$2 AND permission='table.row.read'`,
        [f.actor.membershipId, a.id],
      );
    }
    if (scenario === 'resume') {
      assert.equal((await review()).freshness, 'current');
      await control('resume');
      assert.equal(await f.finish(p), 'completed');
      const completed = await review();
      assert.equal(completed.status, 'completed');
      assert.equal(completed.freshness, 'current');
      assert.equal((await effects()).total, 0);
      const current = await f.tableService.definitions(f.ws.id, f.actor);
      assert.equal(current.tables.find(row => row.id === a.id).definition.label, 'Completed A');
      assert.equal(current.tables.find(row => row.id === b.id).definition.label, 'Dependent B');
    } else {
      await assert.rejects(review(), AccessDenied);
      await assert.rejects(effects(), AccessDenied);
      await assert.rejects(control('resume'), AccessDenied);
      // Remove only the pause to exercise executor admission independently of resume.
      await f.db.platform.query(`DELETE FROM ${f.s}.tf_table_proposal_controls WHERE proposal_id=$1`, [p.id]);
      await assert.rejects(f.publish(f.ws.id, p.id), AccessDenied);
      assert.equal(await f.advance(f.ws.id, p.id), 'blocked');
      assert.equal(
        (await f.db.platform.query(`SELECT applied_revision FROM ${f.s}.tf_table_catalog WHERE id=$1`, [b.id])).rows[0]
          .applied_revision,
        b.revision,
      );
    }
    const stored = (
      await f.db.platform.query(`SELECT manifest,digest FROM ${f.s}.tf_table_proposals WHERE id=$1`, [p.id])
    ).rows[0];
    assert.deepEqual(stored.manifest, p.manifest);
    assert.equal(stored.digest, p.digest);
    assert.equal(tableProposalDigest(stored.manifest), p.digest);
  });

test('chat discovery provenance survives its own label/schema publication and rejects external active/saved changes', async t => {
  const f = await setup(t);
  const item = await f.create();
  const record = await f.tableService.mutate(f.ws.id, f.actor, {
    kind: 'create',
    tableId: item.id,
    revision: item.revision,
    recordId: randomUUID(),
    values: { [item.definition.fields[0].id]: { kind: 'text', value: 'Preserved' } },
  });
  for (const change of ['label', 'schema']) {
    const p = await f.chatProposal(list => {
      const plan = f.schema(
        list.tables.find(row => row.id === item.id),
        `Updated ${change}`,
      );
      if (change === 'schema')
        plan.target.fields.push({ id: randomUUID(), label: 'Notes', kind: 'text', required: false, maxLength: 1000 });
      return plan;
    });
    const before = p.manifest.plans[0].input.expectedRevision;
    await f.approve(p);
    assert.equal(await f.advance(f.ws.id, p.id), 'publish');
    await f.publish(f.ws.id, p.id);
    const catalog = (
      await f.db.platform.query(`SELECT target_revision,applied_revision FROM ${f.s}.tf_table_catalog WHERE id=$1`, [
        item.id,
      ])
    ).rows[0];
    assert.equal(catalog.applied_revision, before);
    assert.notEqual(catalog.target_revision, before);
    await f.transaction(tx => requireDraftSources(tx, f.actor, p.sources));
    assert.equal(await f.finish(p), 'completed');
    const current = (await f.tableService.definitions(f.ws.id, f.actor)).tables.find(row => row.id === item.id);
    assert.equal(current.definition.label, `Updated ${change}`);
    assert.equal(
      (
        await f.tableService.read(f.ws.id, f.actor, {
          tableId: item.id,
          revision: current.revision,
          recordId: record.id,
        })
      ).values[item.definition.fields[0].id].value,
      'Preserved',
    );
    await assert.rejects(
      f.transaction(tx => requireDraftSources(tx, f.actor, p.sources)),
      AccessDenied,
    );
    const projection = (
      await f.db.platform.query(`SELECT projection FROM ${f.s}.tf_table_executions WHERE proposal_id=$1`, [p.id])
    ).rows[0].projection;
    assert.deepEqual(await readVerifiedProjection(f.soul, f.ws.id, projection), current.definition);
  }
  const stale = await f.chatProposal(list =>
    f.schema(
      list.tables.find(row => row.id === item.id),
      'Must remain stale',
    ),
  );
  await f.approve(stale);
  const external = await f.chatProposal(list =>
    f.schema(
      list.tables.find(row => row.id === item.id),
      'External change',
    ),
  );
  await f.approve(external);
  assert.equal(await f.finish(external), 'completed');
  await assert.rejects(f.publish(f.ws.id, stale.id), AccessDenied);
  const saved = (
    await f.db.platform.query(`SELECT target_revision FROM ${f.s}.tf_table_catalog WHERE id=$1`, [item.id])
  ).rows[0].target_revision;
  const savedSources = [{ kind: 'table-schema', tableId: item.id, revision: saved }];
  await f.transaction(tx => requireDraftSources(tx, f.actor, savedSources));
  const next = await f.chatProposal(list =>
    f.schema(
      list.tables.find(row => row.id === item.id),
      'Pending saved change',
    ),
  );
  await f.approve(next);
  await f.publish(f.ws.id, next.id);
  await assert.rejects(
    f.transaction(tx => requireDraftSources(tx, f.actor, savedSources)),
    AccessDenied,
  );
});

test('schema.context provenance completes its own publication and rejects other publications and revoked authority', async t => {
  const f = await setup(t);
  const item = await f.create(),
    field = item.definition.fields[0].id;
  const record = await f.tableService.mutate(f.ws.id, f.actor, {
    kind: 'create',
    tableId: item.id,
    revision: item.revision,
    recordId: randomUUID(),
    values: { [field]: { kind: 'text', value: 'Preserved' } },
  });
  const latest = async () =>
    (await f.tableService.definitions(f.ws.id, f.actor)).tables.find(row => row.id === item.id);
  const viaContext = async label => {
    const current = await latest();
    return f.chatProposal(() => f.schema(current, label), f.actor, { tool: 'schema.context', tableId: item.id });
  };
  const review = p => f.proposals.read(f.ws.id, f.actor.userId, p.chat, p.id);
  const control = (p, operation) =>
    f.decisions.control(f.ws.id, f.actor.userId, p.chat, p.id, {
      commandId: randomUUID(),
      digest: p.digest,
      operation,
    });
  const publishOwn = async p => {
    await f.approve(p);
    assert.equal(await f.advance(f.ws.id, p.id), 'publish');
    await f.publish(f.ws.id, p.id);
  };
  const catalog = async () =>
    (
      await f.db.platform.query(`SELECT target_revision,applied_revision FROM ${f.s}.tf_table_catalog WHERE id=$1`, [
        item.id,
      ])
    ).rows[0];

  const own = await viaContext('Context rename');
  assert.ok(
    own.manifest.sources.some(
      source => source.kind === 'table-schema' && source.tableId === item.id && source.revision === item.revision,
    ),
  );
  await publishOwn(own);
  const published = await catalog();
  assert.equal(published.applied_revision, item.revision);
  assert.notEqual(published.target_revision, item.revision);
  assert.equal(await f.advance(f.ws.id, own.id), 'more', 'Execution continues after its own publication');
  assert.equal((await review(own)).freshness, 'current', 'The proposal remains readable after its own publication');
  assert.equal(await f.finish(own), 'completed');
  const completed = await review(own);
  assert.deepEqual([completed.status, completed.freshness], ['completed', 'current']);
  const renamed = await latest();
  assert.equal(renamed.definition.label, 'Context rename');
  assert.equal(renamed.revision, published.target_revision);
  assert.equal(
    (await f.tableService.read(f.ws.id, f.actor, { tableId: item.id, revision: renamed.revision, recordId: record.id }))
      .values[field].value,
    'Preserved',
  );
  const stored = (
    await f.db.platform.query(`SELECT manifest,digest FROM ${f.s}.tf_table_proposals WHERE id=$1`, [own.id])
  ).rows[0];
  assert.deepEqual(stored.manifest, own.manifest);
  assert.equal(stored.digest, own.digest);
  assert.equal(tableProposalDigest(stored.manifest), own.digest);

  const paused = await viaContext('Paused rename');
  await publishOwn(paused);
  await control(paused, 'cancel');
  assert.equal(await f.advance(f.ws.id, paused.id), 'blocked');
  assert.equal(
    (await review(paused)).freshness,
    'current',
    'A cancelled proposal still owns its published saved revision',
  );
  const other = await f.chatProposal(list =>
    f.schema(
      list.tables.find(row => row.id === item.id),
      'Other rename',
    ),
  );
  await publishOwn(other);
  await assert.rejects(
    review(paused),
    AccessDenied,
    "Another proposal's saved revision does not satisfy schema provenance",
  );
  assert.equal(await f.finish(other), 'completed');
  await assert.rejects(
    review(paused),
    AccessDenied,
    "Another proposal's applied revision does not satisfy schema provenance",
  );
  await assert.rejects(control(paused, 'resume'), AccessDenied);
  // Remove only the pause to exercise executor admission independently of resume.
  await f.db.platform.query(`DELETE FROM ${f.s}.tf_table_proposal_controls WHERE proposal_id=$1`, [paused.id]);
  assert.equal(await f.advance(f.ws.id, paused.id), 'blocked');
  assert.equal((await latest()).definition.label, 'Other rename');

  const revoked = await viaContext('Revoked rename');
  await publishOwn(revoked);
  await f.db.platform.query(`UPDATE ${f.s}.tf_memberships SET role='member' WHERE id=$1`, [f.actor.membershipId]);
  assert.equal(await f.advance(f.ws.id, revoked.id), 'blocked');
  assert.equal(
    (await f.db.platform.query(`SELECT error_code FROM ${f.s}.tf_table_executions WHERE proposal_id=$1`, [revoked.id]))
      .rows[0].error_code,
    'access-denied',
  );
  assert.equal(
    (
      await f.db.platform.query(
        `SELECT definition->>'label' AS label FROM ${f.s}.tf_table_generations WHERE table_id=$1 AND state='active'`,
        [item.id],
      )
    ).rows[0].label,
    'Other rename',
  );
});

test('transfer then chat discovery/proposal/apply uses current owner and preserves historical definitions', async t => {
  const f = await setup(t);
  const item = await f.create();
  const historical = (
    await f.db.platform.query(`SELECT id,definition FROM ${f.s}.tf_table_generations WHERE table_id=$1`, [item.id])
  ).rows[0];
  const oldAdmin = await f.chatProposal(list =>
    f.schema(
      list.tables.find(row => row.id === item.id),
      'Approved before transfer',
    ),
  );
  await f.approve(oldAdmin);
  const oldActor = { kind: 'human', membershipId: randomUUID(), userId: randomUUID() },
    newActor = { kind: 'human', membershipId: randomUUID(), userId: randomUUID() };
  for (const actor of [oldActor, newActor])
    await f.db.platform.query(`INSERT INTO ${f.s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      actor.membershipId,
      actor.userId,
    ]);
  // Team enrollment belongs to the team's manager, not to workspace admin status.
  await f.db.platform.query(`INSERT INTO ${f.s}.tf_member_teams(team_id,membership_id,role) VALUES($1,$2,'manager')`, [
    f.team,
    f.actor.membershipId,
  ]);
  await f.governance.setEnrollment(f.ws.id, f.actor.userId, f.team, oldActor.membershipId, { enrolled: true });
  for (const permission of ['table.row.read', 'table.schema.manage'])
    await f.governance.setGrant(f.ws.id, f.actor.userId, {
      teamId: f.team,
      target: { kind: 'table', id: item.id, permission },
      granted: true,
    });
  const old = await f.chatProposal(
    list =>
      f.schema(
        list.tables.find(row => row.id === item.id),
        'Old authority',
      ),
    oldActor,
  );
  await f.approve(old);
  const destination = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.s}.tf_teams(id,name) VALUES($1,'New owner')`, [destination]);
  await f.governance.transferTable(f.ws.id, f.actor.userId, item.id, destination);
  await assert.rejects(f.publish(f.ws.id, oldAdmin.id), error => error.code === 'proposal-stale');
  for (const permission of ['table.row.read', 'table.schema.manage']) {
    await f.governance.setGrant(f.ws.id, f.actor.userId, {
      teamId: f.team,
      target: { kind: 'table', id: item.id, permission },
      granted: false,
    });
    await f.governance.setPersonGrant(f.ws.id, f.actor.userId, {
      membershipId: newActor.membershipId,
      target: { kind: 'table', id: item.id, permission },
      granted: true,
    });
  }
  assert.equal(
    (await f.tableService.definitions(f.ws.id, oldActor)).tables.some(row => row.id === item.id),
    false,
  );
  await assert.rejects(f.publish(f.ws.id, old.id), AccessDenied);
  assert.equal(
    (await f.transaction(tx => generationProposalData.definition(tx, item.id))).definition.owningTeamId,
    destination,
  );
  assert.equal((await f.transaction(tx => activeGeneration(tx, item.id))).definition.owningTeamId, destination);
  const p = await f.chatProposal(list => {
    const discovered = list.tables.find(row => row.id === item.id);
    assert.equal(discovered.definition.owningTeamId, destination);
    return f.schema(discovered, 'Transferred and updated');
  }, newActor);
  await f.approve(p);
  assert.equal(await f.finish(p), 'completed');
  const projection = (
    await f.db.platform.query(`SELECT projection FROM ${f.s}.tf_table_executions WHERE proposal_id=$1`, [p.id])
  ).rows[0].projection;
  assert.equal((await readVerifiedProjection(f.soul, f.ws.id, projection)).owningTeamId, destination);
  assert.deepEqual(
    (await f.db.platform.query(`SELECT definition FROM ${f.s}.tf_table_generations WHERE id=$1`, [historical.id]))
      .rows[0].definition,
    historical.definition,
  );
  assert.equal(historical.definition.owningTeamId, f.team);
  assert.equal(
    (await f.tableService.definitions(f.ws.id, newActor)).tables.find(row => row.id === item.id).definition
      .owningTeamId,
    destination,
  );
  const revoked = await f.chatProposal(
    list =>
      f.schema(
        list.tables.find(row => row.id === item.id),
        'Revoked direct grant',
      ),
    newActor,
  );
  await f.approve(revoked);
  await f.governance.setPersonGrant(f.ws.id, f.actor.userId, {
    membershipId: newActor.membershipId,
    target: { kind: 'table', id: item.id, permission: 'table.schema.manage' },
    granted: false,
  });
  await assert.rejects(f.publish(f.ws.id, revoked.id), AccessDenied);
  assert.equal(
    (await f.tableService.definitions(f.ws.id, newActor)).tables.find(row => row.id === item.id).definition.label,
    'Transferred and updated',
  );
});
