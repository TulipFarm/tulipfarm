import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { serializeAgentDocument } from '@tulipfarm/workspaces/agent-document';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { connect, denied, fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentAuthoring } from '../src/authoring.ts';
import { createSavedAgentService } from '../src/saved-service.ts';
import { createAgentStore } from '../src/store.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';

const sha1 = () => createHash('sha1').update(randomUUID()).digest('hex');

test(
  'workspace skills archive and restore, and delete only when no live agent work pins them',
  { timeout: 180000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    assert.deepEqual(migrations, db.baseline);
    const w = await db.create(migrations);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({
        workspaceId: id,
        generation: 1,
        connectionString: db.login(db.workspaces.find(workspace => workspace.id === id)),
      }),
    });
    const table = name => qualified(w.names.schema, name);
    const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const reader = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
      [member.membershipId, member.userId, reader.membershipId, reader.userId],
    );
    const skills = createWorkspaceSkills(runtime),
      store = createAgentStore(runtime);
    const procedure = {
      name: 'Qualify lead',
      description: 'Qualify an inbound lead before handoff.',
      instructions: 'Ask for company size, then budget.',
    };
    const setLifecycle = (who, id, expectedVersion, lifecycle, requestId = randomUUID()) =>
      skills.setLifecycle(w.id, who, id, { requestId, expectedVersion, lifecycle });
    const grantSkill = (id, actor, permissions) =>
      db.platform.query(
        `INSERT INTO ${table('tf_skill_person_grants')} (skill_id,membership_id,permission) SELECT $1,$2,unnest($3::text[])`,
        [id, actor.membershipId, permissions],
      );
    async function reviewedSkill(name) {
      const id = randomUUID();
      const saved = await skills.save(w.id, admin, id, {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: { ...procedure, name },
      });
      await skills.review(w.id, admin, id, {
        requestId: randomUUID(),
        expectedVersion: 1,
        revision: saved.savedRevision,
      });
      return { id, rev: saved.savedRevision };
    }
    async function saveDefinition(agentId, name, selected) {
      const definition = {
        name,
        instructions: 'Follow the selected procedure.',
        tools: ['rows.list'],
        skills: selected,
      };
      const revision = createHash('sha256').update(canonicalJson(definition)).digest('hex'),
        commandId = randomUUID(),
        soul = sha1();
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
        [agentId, revision, definition],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input,status) VALUES ($1,$2,$3,$4,$5,'{}','accepted')`,
        [commandId, agentId, admin.membershipId, admin.userId, randomUUID()],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_soul_revisions')} (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'fixture','fixture')`,
        [soul, commandId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
        [agentId, soul, revision],
      );
      await db.platform.query(`UPDATE ${table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [agentId, soul]);
      return revision;
    }
    async function savedAgent(name, selected) {
      const agentId = randomUUID(),
        teamId = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,$2)`, [teamId, name]);
      await db.platform.query(`INSERT INTO ${table('tf_agents')} (id,owning_team_id,display_name) VALUES ($1,$2,$3)`, [
        agentId,
        teamId,
        name,
      ]);
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage'),($1,$2,'delete')`,
        [agentId, admin.membershipId],
      );
      return { agentId, revision: await saveDefinition(agentId, name, selected) };
    }

    await t.test(
      'archive hides a skill from catalog lists, keeps pinned resolution and revocation, and restore brings it back',
      async () => {
        const { id, rev } = await reviewedSkill('Qualify lead');
        await grantSkill(id, reader, ['read', 'use']);
        const listed = {
            id,
            revision: rev,
            name: 'Qualify lead',
            description: procedure.description,
            source: 'Legacy skill',
            status: 'enabled',
          },
          search = { search: 'Qualify lead' };
        assert.deepEqual((await skills.list(w.id, admin, search)).workspace, [listed]);
        const archived = await setLifecycle(admin, id, 2, 'archived');
        assert.deepEqual(archived, {
          id,
          version: 3,
          savedRevision: rev,
          activeRevision: rev,
          enabled: true,
          lifecycle: 'archived',
        });
        for (const view of ['visible', 'reviewed'])
          assert.deepEqual((await skills.list(w.id, admin, { ...search, view })).workspace, []);
        assert.deepEqual(await skills.list(w.id, reader, { ...search, view: 'archived' }), {
          workspace: [{ ...listed, status: 'archived' }],
          nextCursor: null,
        });
        assert.deepEqual(await skills.resolve(w.id, reader, [{ id, revision: rev }]), [
          { id, revision: rev, ...procedure },
        ]);
        const detail = await skills.read(w.id, reader, id);
        assert.deepEqual([detail.lifecycle, detail.canManageLifecycle, detail.management], ['archived', false, null]);
        await assert.rejects(
          skills.save(w.id, admin, id, { requestId: randomUUID(), expectedVersion: 3, definition: procedure }),
          error => error.code === 'skill-archived',
        );
        await assert.rejects(
          skills.review(w.id, admin, id, { requestId: randomUUID(), expectedVersion: 3, revision: rev }),
          error => error.code === 'skill-archived',
        );
        assert.deepEqual(
          await skills.setEnabled(w.id, admin, id, { requestId: randomUUID(), expectedVersion: 3, enabled: false }),
          { id, version: 4, savedRevision: rev, activeRevision: rev, enabled: false, lifecycle: 'archived' },
        );
        await assert.rejects(skills.resolve(w.id, reader, [{ id, revision: rev }]), AccessDenied);
        const restored = await setLifecycle(admin, id, 4, 'active');
        assert.deepEqual(restored, { id, version: 5, savedRevision: rev, activeRevision: rev, enabled: false });
        assert.equal('lifecycle' in restored, false);
        assert.deepEqual((await skills.list(w.id, admin, search)).workspace, [{ ...listed, status: 'disabled' }]);
        assert.deepEqual((await skills.list(w.id, admin, { ...search, view: 'archived' })).workspace, []);
      },
    );

    await t.test('a request for the current state keeps the version, and request ids replay or conflict', async () => {
      const { id, rev } = await reviewedSkill('Renew contract');
      const request = randomUUID();
      const archived = await setLifecycle(admin, id, 2, 'archived', request);
      assert.deepEqual(await setLifecycle(admin, id, 3, 'archived'), {
        id,
        version: 3,
        savedRevision: rev,
        activeRevision: rev,
        enabled: true,
        lifecycle: 'archived',
      });
      assert.deepEqual(await setLifecycle(admin, id, 2, 'archived', request), archived);
      await assert.rejects(
        setLifecycle(admin, id, 2, 'active', request),
        error => error.code === 'idempotency-conflict',
      );
      await assert.rejects(setLifecycle(admin, id, 2, 'active'), error => error.code === 'version-conflict');
    });

    await t.test(
      'an agent whose saved definition and activation pin a skill blocks deletion, and archive stays available',
      async () => {
        const { id, rev } = await reviewedSkill('Book a demo');
        const agent = await savedAgent('Sales assistant', [{ id, revision: rev }]);
        await store.activate(w.id, admin, { agentId: agent.agentId, revision: agent.revision, scope: [] });
        const blockers = [
          { agentId: agent.agentId, name: 'Sales assistant', uses: ['active-revision', 'saved-definition'] },
        ];
        assert.deepEqual(await skills.deletion(w.id, admin, id), {
          id,
          name: 'Book a demo',
          version: 2,
          lifecycle: 'active',
          blockers,
          hiddenAgents: 0,
          blockerCount: 1,
        });
        await assert.rejects(setLifecycle(admin, id, 2, 'deleted'), error => error.code === 'skill-in-use');
        assert.equal((await skills.read(w.id, admin, id)).management.version, 2);
        assert.equal((await setLifecycle(admin, id, 2, 'archived')).version, 3);
        assert.deepEqual(await skills.deletion(w.id, admin, id), {
          id,
          name: 'Book a demo',
          version: 3,
          lifecycle: 'archived',
          blockers,
          hiddenAgents: 0,
          blockerCount: 1,
        });
        await assert.rejects(skills.deletion(w.id, reader, id), AccessDenied);
      },
    );

    await t.test('open runs and open task snapshots block deletion until their agent is deleted', async () => {
      const { id, rev } = await reviewedSkill('Escalate ticket');
      const agent = await savedAgent('Support assistant', [{ id, revision: rev }]);
      const { activationId } = await store.activate(w.id, admin, {
        agentId: agent.agentId,
        revision: agent.revision,
        scope: [],
      });
      const runId = randomUUID(),
        taskId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,user_id,membership_id,scope,status) VALUES ($1,$2,$3,$4,'delegated',$5,$6,'[]','waiting')`,
        [runId, agent.agentId, activationId, agent.revision, admin.userId, admin.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_tasks')} (id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'[]','{}',$1,'waiting-approval')`,
        [
          taskId,
          admin.userId,
          admin.membershipId,
          agent.agentId,
          activationId,
          agent.revision,
          JSON.stringify([{ id, revision: rev }]),
        ],
      );
      await store.revokeActivation(w.id, admin, { agentId: agent.agentId, activationId });
      await saveDefinition(agent.agentId, 'Support assistant', []);
      assert.deepEqual((await skills.deletion(w.id, admin, id)).blockers, [
        { agentId: agent.agentId, name: 'Support assistant', uses: ['open-run', 'open-task'] },
      ]);
      await db.platform.query(`UPDATE ${table('tf_agent_runs')} SET status='completed' WHERE id=$1`, [runId]);
      assert.deepEqual((await skills.deletion(w.id, admin, id)).blockers, [
        { agentId: agent.agentId, name: 'Support assistant', uses: ['open-task'] },
      ]);
      await createSavedAgentService(runtime).remove(w.id, admin.userId, agent.agentId);
      assert.deepEqual(await skills.deletion(w.id, admin, id), {
        id,
        name: 'Escalate ticket',
        version: 2,
        lifecycle: 'active',
        blockers: [],
        hiddenAgents: 0,
        blockerCount: 0,
      });
      assert.equal((await setLifecycle(admin, id, 2, 'deleted')).lifecycle, 'deleted');
    });

    await t.test('a draft creator sees how many unreadable agents pin their draft without their names', async () => {
      const id = randomUUID();
      const draft = await skills.save(w.id, member, id, {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: {
          name: 'Plan payroll',
          description: 'Confirm timesheets before payroll.',
          instructions: 'Confirm hours first.',
        },
      });
      const agent = await savedAgent('Finance assistant', [{ id, revision: draft.savedRevision }]);
      assert.deepEqual(await skills.deletion(w.id, member, id), {
        id,
        name: 'Plan payroll',
        version: 1,
        lifecycle: 'active',
        blockers: [],
        hiddenAgents: 1,
        blockerCount: 1,
      });
      await assert.rejects(skills.deletion(w.id, admin, id), AccessDenied);
      await grantSkill(id, admin, ['manage']);
      assert.deepEqual(await skills.deletion(w.id, admin, id), {
        id,
        name: 'Plan payroll',
        version: 1,
        lifecycle: 'active',
        blockers: [{ agentId: agent.agentId, name: 'Finance assistant', uses: ['saved-definition'] }],
        hiddenAgents: 0,
        blockerCount: 1,
      });
      await assert.rejects(setLifecycle(member, id, 1, 'deleted'), error => error.code === 'skill-in-use');
    });

    await t.test(
      'a member keeps lifecycle authority after review until explicitly transferring management',
      async () => {
        const id = randomUUID();
        const draft = await skills.save(w.id, member, id, {
          requestId: randomUUID(),
          expectedVersion: 0,
          definition: {
            name: 'Draft follow-up',
            description: 'Follow up after a lead has had time to respond.',
            instructions: 'Wait two days, then call.',
          },
        });
        const receipt = { id, savedRevision: draft.savedRevision, activeRevision: null, enabled: false };
        assert.equal((await skills.read(w.id, member, id)).canManageLifecycle, true);
        await assert.rejects(setLifecycle(reader, id, 1, 'archived'), AccessDenied);
        assert.deepEqual(await setLifecycle(member, id, 1, 'archived'), {
          ...receipt,
          version: 2,
          lifecycle: 'archived',
        });
        assert.deepEqual((await skills.list(w.id, member, { view: 'archived', search: 'Draft follow-up' })).workspace, [
          {
            id,
            revision: draft.savedRevision,
            name: 'Draft follow-up',
            description: 'Follow up after a lead has had time to respond.',
            source: 'Legacy skill',
            status: 'archived',
          },
        ]);
        assert.deepEqual(await setLifecycle(member, id, 2, 'active'), { ...receipt, version: 3 });
        await assert.rejects(
          skills.review(w.id, admin, id, {
            requestId: randomUUID(),
            expectedVersion: 3,
            revision: draft.savedRevision,
          }),
          AccessDenied,
        );
        await skills.share(w.id, member.userId, id, {
          version: 3,
          grants: [],
          personGrants: [
            { membershipId: member.membershipId, permissions: ['manage', 'read', 'use'] },
            { membershipId: admin.membershipId, permissions: ['manage', 'read', 'use'] },
          ],
        });
        await skills.review(w.id, admin, id, {
          requestId: randomUUID(),
          expectedVersion: 4,
          revision: draft.savedRevision,
        });
        assert.equal((await skills.read(w.id, member, id)).canManageLifecycle, true);
        await skills.share(w.id, member.userId, id, {
          version: 5,
          grants: [],
          personGrants: [
            { membershipId: member.membershipId, permissions: ['read', 'use'] },
            { membershipId: admin.membershipId, permissions: ['manage', 'read', 'use'] },
          ],
        });
        await assert.rejects(setLifecycle(member, id, 6, 'archived'), AccessDenied);
        await assert.rejects(skills.deletion(w.id, member, id), AccessDenied);
        assert.deepEqual(
          [
            (await skills.read(w.id, member, id)).canManageLifecycle,
            (await skills.read(w.id, admin, id)).canManageLifecycle,
          ],
          [false, true],
        );
      },
    );

    await t.test('deleting an unpinned skill leaves a final tombstone that answers only its own replay', async () => {
      const { id, rev } = await reviewedSkill('Close the books');
      const search = { search: 'Close the books' };
      assert.deepEqual((await skills.list(w.id, admin, search)).workspace, [
        {
          id,
          revision: rev,
          name: 'Close the books',
          description: procedure.description,
          source: 'Legacy skill',
          status: 'enabled',
        },
      ]);
      assert.deepEqual(await skills.deletion(w.id, admin, id), {
        id,
        name: 'Close the books',
        version: 2,
        lifecycle: 'active',
        blockers: [],
        hiddenAgents: 0,
        blockerCount: 0,
      });
      const request = randomUUID();
      const deleted = await setLifecycle(admin, id, 2, 'deleted', request);
      assert.deepEqual(deleted, {
        id,
        version: 3,
        savedRevision: rev,
        activeRevision: rev,
        enabled: false,
        lifecycle: 'deleted',
      });
      await assert.rejects(skills.read(w.id, admin, id), AccessDenied);
      await assert.rejects(skills.resolve(w.id, admin, [{ id, revision: rev }]), AccessDenied);
      await assert.rejects(
        skills.save(w.id, admin, id, { requestId: randomUUID(), expectedVersion: 3, definition: procedure }),
        AccessDenied,
      );
      await assert.rejects(
        skills.setEnabled(w.id, admin, id, { requestId: randomUUID(), expectedVersion: 3, enabled: true }),
        AccessDenied,
      );
      await assert.rejects(setLifecycle(admin, id, 3, 'active'), AccessDenied);
      await assert.rejects(skills.deletion(w.id, admin, id), AccessDenied);
      for (const view of ['visible', 'reviewed', 'archived'])
        assert.deepEqual((await skills.list(w.id, admin, { ...search, view })).workspace, []);
      assert.deepEqual(await setLifecycle(admin, id, 2, 'deleted', request), deleted);
      await assert.rejects(setLifecycle(admin, id, 2, 'deleted'), AccessDenied);
      const client = await connect(db.login(w));
      try {
        for (const change of ['deleted_at=NULL', 'enabled=true'])
          await assert.rejects(
            client.query(`UPDATE ${table('tf_workspace_skills')} SET ${change} WHERE id=$1`, [id]),
            /Deleted workspace skills are final/,
          );
        await denied(client, `DELETE FROM ${table('tf_workspace_skills')} WHERE id=$1`, [id]);
      } finally {
        await client.end();
      }
      const live = await reviewedSkill('Enabled tombstone guard');
      await assert.rejects(
        db.platform.query(`UPDATE ${table('tf_workspace_skills')} SET deleted_at=now() WHERE id=$1`, [live.id]),
        error => error.code === '23514',
      );
    });

    await t.test('agent saves cannot pin a deleted skill, and saves queued before the delete fail', async () => {
      const team = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Agent authors')`, [team]);
      await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        admin.membershipId,
        team,
      ]);
      await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, [sha1()]);
      const authoring = createAgentAuthoring(runtime),
        prepared = [];
      async function write(input) {
        prepared.push(input.commandId);
        const commit = createHash('sha1').update(input.commandId).digest('hex');
        const sha256 = createHash('sha256').update(serializeAgentDocument(input.definition)).digest('hex');
        return {
          parentCommit: input.expectedParentCommit,
          commit,
          bundle: { key: `bundles/${commit}`, sha256: 'b'.repeat(64) },
          projection: {
            workspaceId: input.workspaceId,
            commit,
            kind: 'agent',
            id: input.definition.id,
            path: `agents/${input.definition.id}.json`,
            bucket: 'fixture',
            key: `agents/${commit}.json`,
            sha256,
          },
        };
      }
      async function queue(selection) {
        const head = (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0]
          .revision;
        return authoring.save(w.id, admin, randomUUID(), {
          requestId: randomUUID(),
          expectedSoulRevision: head,
          expectedSavedRevision: null,
          owningTeamId: team,
          definition: {
            name: 'Pinned agent',
            instructions: 'Use the selected procedure.',
            tools: ['rows.list'],
            skills: [selection],
          },
        });
      }
      const live = await reviewedSkill('Live pin');
      const accepted = await queue({ id: live.id, revision: live.rev });
      assert.equal((await authoring.withWriter(write).prepare(w.id, accepted.commandId)).status, 'accepted');
      assert.deepEqual((await skills.deletion(w.id, admin, live.id)).blockers, [
        { agentId: accepted.agentId, name: 'Pinned agent', uses: ['saved-definition'] },
      ]);

      const removed = await reviewedSkill('Queued pin');
      const early = await queue({ id: removed.id, revision: removed.rev });
      await setLifecycle(admin, removed.id, 2, 'deleted');
      await assert.rejects(queue({ id: removed.id, revision: removed.rev }), AccessDenied);
      assert.equal((await authoring.withWriter(write).prepare(w.id, early.commandId)).status, 'failed');
      await assert.rejects(authoring.commandStatus(w.id, admin, early.commandId), AccessDenied);
      assert.equal(
        (await db.platform.query(`SELECT status FROM ${table('tf_agent_commands')} WHERE id=$1`, [early.commandId]))
          .rows[0].status,
        'failed',
      );

      const racing = await reviewedSkill('Racing pin');
      const late = await queue({ id: racing.id, revision: racing.rev });
      const deleting = authoring.withWriter(async input => {
        await setLifecycle(admin, racing.id, 2, 'deleted');
        return write(input);
      });
      assert.equal((await deleting.prepare(w.id, late.commandId)).status, 'failed');
      assert.deepEqual(
        prepared,
        [accepted.commandId, late.commandId],
        'A command whose skill was already deleted never reaches the Soul writer',
      );
      assert.equal(
        (
          await db.platform.query(`SELECT 1 FROM ${table('tf_agents')} WHERE id=ANY($1::uuid[])`, [
            [early.agentId, late.agentId],
          ])
        ).rowCount,
        0,
      );
    });

    await t.test('the skill limit counts live skills, so deleting one frees a slot', async () => {
      const capped = await db.create(migrations);
      const cappedTable = name => qualified(capped.names.schema, name);
      const seeded = (
        await db.platform.query(
          `WITH seeded AS (INSERT INTO ${cappedTable('tf_workspace_skills')} (id,creator_id,saved_revision) SELECT gen_random_uuid(),$1,$2 FROM generate_series(1,1000) RETURNING id)
      INSERT INTO ${cappedTable('tf_workspace_skill_revisions')} (skill_id,revision,definition,author_id) SELECT id,$2,$3,$1 FROM seeded RETURNING skill_id`,
          [capped.membershipId, 'c'.repeat(64), { name: 'Seeded', instructions: 'Seeded procedure.' }],
        )
      ).rows;
      assert.equal(seeded.length, 1000);
      await db.platform.query(
        `INSERT INTO ${cappedTable('tf_skill_person_grants')} (skill_id,membership_id,permission)
      SELECT id,$1,unnest(ARRAY['manage','read','use']) FROM ${cappedTable('tf_workspace_skills')}`,
        [capped.membershipId],
      );
      const create = () =>
        skills.save(capped.id, capped.userId, randomUUID(), {
          requestId: randomUUID(),
          expectedVersion: 0,
          definition: procedure,
        });
      await assert.rejects(create(), error => error.code === 'limit-reached');
      await skills.setLifecycle(capped.id, capped.userId, seeded[0].skill_id, {
        requestId: randomUUID(),
        expectedVersion: 1,
        lifecycle: 'deleted',
      });
      assert.equal((await create()).version, 1);
      await assert.rejects(create(), error => error.code === 'limit-reached');
    });
  },
);

test('a current-baseline workspace keeps unreviewed skills and supports their lifecycle', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const workspace = await db.create(db.baseline);
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
  });
  const skills = createWorkspaceSkills(runtime);
  const procedure = {
    name: 'Qualify lead',
    description: 'Qualify an inbound lead before handoff.',
    instructions: 'Ask for company size, then budget.',
  };
  const id = randomUUID(),
    revision = createHash('sha256').update(canonicalJson(procedure)).digest('hex');
  assert.deepEqual(
    await skills.save(workspace.id, workspace.userId, id, {
      requestId: randomUUID(),
      expectedVersion: 0,
      definition: procedure,
    }),
    { id, version: 1, savedRevision: revision, activeRevision: null, enabled: false },
  );
  const listed = {
    id,
    revision,
    name: 'Qualify lead',
    description: procedure.description,
    source: 'Legacy skill',
    status: 'needs-review',
  };
  assert.deepEqual((await skills.list(workspace.id, workspace.userId)).workspace, [listed]);
  assert.deepEqual(await skills.list(workspace.id, workspace.userId, { view: 'archived' }), {
    workspace: [],
    nextCursor: null,
  });
  const detail = await skills.read(workspace.id, workspace.userId, id);
  assert.deepEqual([detail.lifecycle, detail.canManageLifecycle], ['active', true]);
  assert.deepEqual(
    await skills.setLifecycle(workspace.id, workspace.userId, id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      lifecycle: 'archived',
    }),
    { id, version: 2, savedRevision: revision, activeRevision: null, enabled: false, lifecycle: 'archived' },
  );
  assert.deepEqual((await skills.list(workspace.id, workspace.userId)).workspace, []);
  assert.deepEqual(await skills.list(workspace.id, workspace.userId, { view: 'archived' }), {
    workspace: [{ ...listed, status: 'archived' }],
    nextCursor: null,
  });
  assert.deepEqual(await skills.deletion(workspace.id, workspace.userId, id), {
    id,
    name: procedure.name,
    version: 2,
    lifecycle: 'archived',
    blockers: [],
    hiddenAgents: 0,
    blockerCount: 0,
  });
});
