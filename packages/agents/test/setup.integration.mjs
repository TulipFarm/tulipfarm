import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { serializeAgentDocument } from '@tulipfarm/workspaces/agent-document';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentSetup } from '../src/setup.ts';
import { createAgentAuthoring } from '../src/authoring.ts';
import { createSavedAgentService } from '../src/saved-service.ts';
import { AgentError } from '../src/saved-contracts.ts';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools } from '../src/tools.ts';

const limits = { toolCalls: 10, activeMilliseconds: 60000, credits: 10 };
async function environment(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const member = randomUUID(),
    user = randomUUID(),
    agentId = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
  const head = async () =>
    (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0].revision;
  let writes = 0;
  const worker = createAgentAuthoring(runtime).withWriter(async input => {
    writes++;
    const commit = createHash('sha1').update(input.commandId).digest('hex');
    return {
      parentCommit: input.expectedParentCommit,
      commit,
      bundle: { key: `bundle-${commit}`, sha256: 'b'.repeat(64) },
      projection: {
        workspaceId: w.id,
        commit,
        kind: 'agent',
        id: input.definition.id,
        path: `agents/${input.definition.id}.json`,
        bucket: 'synthetic',
        key: `projection-${commit}`,
        sha256: createHash('sha256').update(serializeAgentDocument(input.definition)).digest('hex'),
      },
    };
  });
  const setup = () => ({
    definition: { name: 'Setup helper', instructions: 'Follow reviewed tasks.', tools: [] },
    owningTeamId: null,
    policy: {
      grants: [],
      personGrants: [{ membershipId: member, permissions: ['read', 'edit', 'manage', 'invoke', 'delete'] }],
    },
    enrollment: [],
    scope: [],
    limits: [],
    taskLimits: limits,
    slackSender: 'user',
    slackChannels: [],
    schedules: [],
  });
  const input = async (overrides = {}) => ({
    requestId: randomUUID(),
    expectedVersion: 0,
    expectedSoulRevision: await head(),
    expectedSavedRevision: null,
    expectedPolicyVersion: 0,
    expectedActivationIds: [],
    setup: setup(),
    ...overrides,
  });
  const decision = (draft, choice = 'activate') => ({
    requestId: randomUUID(),
    version: draft.version,
    digest: draft.digest,
    decision: choice,
    consent: {
      sponsorScheduleIds: draft.setup.schedules.map(schedule => schedule.id),
      replaceChannels: draft.setup.slackChannels
        .filter(channel => channel.replaceAgentId)
        .map(channel => channel.channel),
    },
  });
  async function accept(service, command) {
    const definition = await service.definitionCommand(w.id, user, command.commandId);
    assert.equal((await worker.prepare(w.id, definition.commandId)).status, 'accepted');
  }
  const state = async () => ({
    agent: (
      await db.platform.query(`SELECT enabled,saved_revision,policy_version FROM ${table('tf_agents')} WHERE id=$1`, [
        agentId,
      ])
    ).rows[0],
    activations: (
      await db.platform.query(
        `SELECT id FROM ${table('tf_agent_activations')} WHERE agent_id=$1 AND revoked_at IS NULL ORDER BY id`,
        [agentId],
      )
    ).rows.map(row => row.id),
    schedules: (
      await db.platform.query(
        `SELECT s.id,s.call,s.activation_id FROM ${table('tf_agent_schedules')} s JOIN ${table('tf_agent_activations')} a ON a.id=s.activation_id WHERE a.agent_id=$1 AND a.revoked_at IS NULL AND s.revoked_at IS NULL ORDER BY s.id`,
        [agentId],
      )
    ).rows,
  });
  return {
    db,
    runtime,
    w,
    table,
    member,
    user,
    agentId,
    setup,
    input,
    decision,
    accept,
    state,
    head,
    worker,
    writes: () => writes,
  };
}

test('draft choices persist inactive; publication has one Soul write and one activation across retries', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const schedule = text => ({
    id: randomUUID(),
    action: { kind: 'task', text, limits },
    trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Kolkata' },
    sponsorMembershipId: f.member,
  });
  const value = await f.input({
    setup: {
      ...f.setup(),
      policy: { grants: [], personGrants: [] },
      schedules: [schedule('Check urgent tasks.'), schedule('Prepare daily summary.')],
    },
  });
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, value);
  assert.deepEqual(await service.saveDraft(f.w.id, f.user, f.agentId, value), draft);
  assert.deepEqual((await service.readDraft(f.w.id, f.user, f.agentId)).setup, draft.setup);
  assert.equal((await f.state()).agent, undefined);
  const save = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft, 'save'));
  assert.deepEqual(await service.pending(f.w.id), [{ id: save.commandId, user_id: f.user }]);
  await f.accept(service, save);
  assert.equal((await service.advance(f.w.id, f.user, save.commandId)).status, 'saved');
  assert.equal((await f.state()).agent.enabled, false);
  assert.deepEqual((await f.state()).schedules, []);
  const activationInput = f.decision(draft);
  const command = await service.publish(f.w.id, f.user, f.agentId, activationInput);
  assert.equal(
    (await createAgentSetup(f.runtime).readDraft(f.w.id, f.user, f.agentId)).commandId,
    command.commandId,
    'reload discovers the durable command without browser state',
  );
  assert.equal(f.writes(), 1);
  assert.equal(
    (await service.readCommand(f.w.id, f.user, command.commandId)).status,
    'preparing',
    'GET status cannot activate',
  );
  assert.deepEqual((await f.state()).activations, []);
  const done = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(done.status, 'active');
  assert.deepEqual(await service.advance(f.w.id, f.user, command.commandId), done);
  assert.equal((await service.publish(f.w.id, f.user, f.agentId, activationInput)).commandId, command.commandId);
  const active = await f.state();
  assert.equal(active.agent.enabled, true);
  assert.deepEqual(active.activations, [done.activationId]);
  assert.equal(active.schedules.length, 2);
  assert.equal(f.writes(), 1);
  assert.equal(
    (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_agent_commands')}`)).rows[0].n,
    1,
  );
  assert.equal(
    (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_agent_tasks')}`)).rows[0].n,
    0,
  );
});

for (const resume of ['new-stage', 'fresh-page'])
  test(`empty-sharing creation retains its manager after Save draft and ${resume} activation`, async t => {
    const f = await environment(t),
      service = createAgentSetup(f.runtime);
    const localSetup = {
      ...f.setup(),
      policy: { grants: [], personGrants: [] },
      schedules: [
        {
          id: randomUUID(),
          action: { kind: 'task', text: 'Check the daily queue.', limits },
          trigger: { kind: 'interval', minutes: 60 },
          sponsorMembershipId: f.member,
        },
      ],
    };
    const original = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input({ setup: localSetup }));
    const saved = await service.publish(f.w.id, f.user, f.agentId, f.decision(original, 'save'));
    await f.accept(service, saved);
    const accepted = await service.advance(f.w.id, f.user, saved.commandId);
    assert.equal(accepted.status, 'saved');
    assert.equal((await f.state()).agent.enabled, false);
    assert.deepEqual((await f.state()).activations, []);
    assert.deepEqual((await f.state()).schedules, []);

    const resumed = createAgentSetup(f.runtime);
    const restored = await resumed.readDraft(f.w.id, f.user, f.agentId);
    assert.equal(restored.commandId, saved.commandId);
    assert.equal(restored.digest, original.digest);
    assert.deepEqual(restored.setup, localSetup);
    assert.equal((await resumed.readCommand(f.w.id, f.user, restored.commandId)).savedRevision, accepted.savedRevision);
    const current = await f.state();
    const policy = await createSavedAgentService(f.runtime).policy(f.w.id, f.user, f.agentId);
    const reviewed =
      resume === 'fresh-page'
        ? restored
        : await resumed.saveDraft(
            f.w.id,
            f.user,
            f.agentId,
            await f.input({
              expectedVersion: restored.version,
              expectedSavedRevision: accepted.savedRevision,
              expectedPolicyVersion: policy.version,
              expectedActivationIds: current.activations,
              setup: localSetup,
            }),
          );
    assert.deepEqual(
      reviewed.setup.policy,
      { grants: [], personGrants: [] },
      'persisted intent is not rewritten to invent a sharing choice',
    );
    if (resume === 'new-stage') {
      assert.equal(reviewed.expectedSavedRevision, accepted.savedRevision);
      assert.notEqual(reviewed.digest, original.digest);
    }
    const decision = f.decision(reviewed);
    await assert.rejects(
      resumed.publish(f.w.id, f.user, f.agentId, { ...decision, digest: '0'.repeat(64) }),
      /setup-digest-conflict/,
    );
    await assert.rejects(
      resumed.publish(f.w.id, f.user, f.agentId, {
        ...decision,
        consent: { sponsorScheduleIds: [], replaceChannels: [] },
      }),
      /schedule-sponsor-consent-required/,
    );
    const command = await resumed.publish(f.w.id, f.user, f.agentId, decision);
    if (resume === 'new-stage') await f.accept(resumed, command);
    assert.equal((await f.state()).agent.enabled, false, 'accepting a definition alone never starts the schedule');
    const activated = await resumed.advance(f.w.id, f.user, command.commandId);
    assert.equal(activated.status, 'active', activated.error);
    const activePolicy = await createSavedAgentService(f.runtime).policy(f.w.id, f.user, f.agentId);
    assert.deepEqual(activePolicy.grants, []);
    assert.deepEqual(activePolicy.personGrants, [
      { membershipId: f.member, permissions: ['delete', 'edit', 'invoke', 'manage', 'read'] },
    ]);
    assert.deepEqual((await f.state()).activations, [activated.activationId]);
    assert.equal((await f.state()).schedules.length, 1);
    assert.equal(f.writes(), resume === 'new-stage' ? 2 : 1);
    assert.deepEqual(await resumed.advance(f.w.id, f.user, command.commandId), activated);
    assert.equal((await resumed.publish(f.w.id, f.user, f.agentId, decision)).commandId, command.commandId);
    assert.equal((await f.state()).schedules.length, 1);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_agents')}`)).rows[0].n,
      1,
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_agent_tasks')}`)).rows[0].n,
      0,
    );
  });

test('creation defaults do not override later reviewed creator permissions or allow a managerless edit', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const original = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({ setup: { ...f.setup(), policy: { grants: [], personGrants: [] } } }),
  );
  const first = await service.publish(f.w.id, f.user, f.agentId, f.decision(original));
  await f.accept(service, first);
  assert.equal((await service.advance(f.w.id, f.user, first.commandId)).status, 'active');
  const reducedPolicy = {
    grants: [],
    personGrants: [{ membershipId: f.member, permissions: ['read', 'edit', 'manage'] }],
  };
  for (const [index, selected] of [reducedPolicy, { grants: [], personGrants: [] }].entries()) {
    const current = await f.state();
    const draft = await service.saveDraft(
      f.w.id,
      f.user,
      f.agentId,
      await f.input({
        expectedVersion: index + 1,
        expectedSavedRevision: current.agent.saved_revision,
        expectedPolicyVersion: current.agent.policy_version,
        expectedActivationIds: current.activations,
        setup: { ...f.setup(), policy: selected },
      }),
    );
    const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
    await f.accept(service, command);
    const result = await service.advance(f.w.id, f.user, command.commandId);
    assert.equal(result.status, index === 0 ? 'active' : 'blocked');
    assert.equal(result.error, index === 0 ? null : 'manager-required');
    const policy = await createSavedAgentService(f.runtime).policy(f.w.id, f.user, f.agentId);
    assert.deepEqual(policy.personGrants, [{ membershipId: f.member, permissions: ['edit', 'manage', 'read'] }]);
    if (index === 1) {
      assert.equal((await f.state()).agent.enabled, true);
      assert.deepEqual((await f.state()).activations, current.activations);
      assert.equal(policy.version, current.agent.policy_version);
    }
  }
});

test('an inactive creation with explicitly changed policy does not restore creator defaults', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime),
    agents = createSavedAgentService(f.runtime);
  const original = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({ setup: { ...f.setup(), policy: { grants: [], personGrants: [] } } }),
  );
  const saved = await service.publish(f.w.id, f.user, f.agentId, f.decision(original, 'save'));
  await f.accept(service, saved);
  const accepted = await service.advance(f.w.id, f.user, saved.commandId);
  await agents.updatePolicy(f.w.id, f.user, f.agentId, {
    version: 0,
    owningTeamId: null,
    grants: [],
    personGrants: [{ membershipId: f.member, permissions: ['read', 'edit', 'manage'] }],
  });
  const policy = await agents.policy(f.w.id, f.user, f.agentId);
  const draft = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({
      expectedVersion: original.version,
      expectedSavedRevision: accepted.savedRevision,
      expectedPolicyVersion: policy.version,
      expectedActivationIds: [],
      setup: original.setup,
    }),
  );
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  const blocked = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error, 'manager-required');
  assert.deepEqual((await agents.policy(f.w.id, f.user, f.agentId)).personGrants, policy.personGrants);
  assert.equal((await f.state()).agent.policy_version, policy.version);
  assert.equal((await f.state()).agent.enabled, false);
  assert.deepEqual((await f.state()).activations, []);
});

test('post-Soul setup failures roll back every DB effect and resume with stable IDs', async t => {
  const f = await environment(t);
  let blocked = true;
  const service = createAgentSetup(f.runtime, undefined, {
    attachSlack: async (tx, _workspace, _user, intent) => {
      await tx.client.query(
        `INSERT INTO ${f.table('tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'test.setup.slack',$3)`,
        [randomUUID(), f.member, f.agentId],
      );
      if (blocked) throw new AgentError('slack-membership-required');
      assert.equal(intent.channel, 'C123');
      return { version: 1, channelResponses: true };
    },
  });
  const draft = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({
      setup: {
        ...f.setup(),
        slackChannels: [{ channel: 'C123', expectedVersion: 0, replaceAgentId: null }],
        schedules: [
          {
            id: randomUUID(),
            action: { kind: 'task', text: 'Check once per hour.', limits },
            trigger: { kind: 'interval', minutes: 60 },
            sponsorMembershipId: f.member,
          },
        ],
      },
    }),
  );
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  const result = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'slack-membership-required');
  assert.ok(result.savedRevision);
  const inactive = await f.state();
  assert.equal(inactive.agent.enabled, false);
  assert.equal(inactive.agent.policy_version, 0);
  assert.deepEqual(inactive.activations, []);
  assert.deepEqual(inactive.schedules, []);
  assert.equal(
    (
      await f.db.platform.query(
        `SELECT count(*)::integer AS n FROM ${f.table('tf_audit_events')} WHERE operation='test.setup.slack'`,
      )
    ).rows[0].n,
    0,
  );
  blocked = false;
  const active = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(active.status, 'active');
  assert.equal(active.activationId, command.activationId);
  assert.equal((await f.state()).schedules.length, 1);
  assert.deepEqual(await service.advance(f.w.id, f.user, command.commandId), active);
  assert.equal(
    (
      await f.db.platform.query(
        `SELECT count(*)::integer AS n FROM ${f.table('tf_audit_events')} WHERE operation='test.setup.slack'`,
      )
    ).rows[0].n,
    1,
  );
});

for (const creatorSelected of [false, true])
  test(`new setup preserves creator authority alongside team and person sharing (creator selected: ${creatorSelected})`, async t => {
    const f = await environment(t),
      service = createAgentSetup(f.runtime);
    const team = randomUUID(),
      colleague = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      colleague,
      randomUUID(),
    ]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Shared helpers')`, [team]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager')`,
      [f.member, team],
    );
    const selected = {
      grants: [{ teamId: team, permissions: ['read', 'invoke'] }],
      personGrants: [
        { membershipId: colleague, permissions: ['read', 'invoke'] },
        ...(creatorSelected ? [{ membershipId: f.member, permissions: ['read'] }] : []),
      ],
    };
    const draft = await service.saveDraft(
      f.w.id,
      f.user,
      f.agentId,
      await f.input({ setup: { ...f.setup(), policy: selected } }),
    );
    const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
    await f.accept(service, command);
    const published = await service.advance(f.w.id, f.user, command.commandId);
    assert.equal(published.status, 'active');
    const policy = await createSavedAgentService(f.runtime).policy(f.w.id, f.user, f.agentId);
    assert.deepEqual(policy.grants, [{ teamId: team, permissions: ['invoke', 'read'] }]);
    assert.deepEqual(policy.personGrants.find(grant => grant.membershipId === colleague)?.permissions, [
      'invoke',
      'read',
    ]);
    assert.deepEqual(policy.personGrants.find(grant => grant.membershipId === f.member)?.permissions, [
      'delete',
      'edit',
      'invoke',
      'manage',
      'read',
    ]);
    assert.equal(policy.personGrants.filter(grant => grant.membershipId === f.member).length, 1);
    assert.deepEqual(policy.enrollment, []);
    assert.deepEqual(await service.advance(f.w.id, f.user, command.commandId), published);
  });

test('editing saves a new revision but preserves the prior live setup until confirmed replacement succeeds', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const initial = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input());
  const first = await service.publish(f.w.id, f.user, f.agentId, f.decision(initial));
  await f.accept(service, first);
  const active = await service.advance(f.w.id, f.user, first.commandId);
  assert.equal(active.status, 'active');
  const before = await f.state();
  const edited = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({
      expectedVersion: 1,
      expectedSavedRevision: before.agent.saved_revision,
      expectedPolicyVersion: before.agent.policy_version,
      expectedActivationIds: before.activations,
      setup: {
        ...f.setup(),
        definition: { ...f.setup().definition, instructions: 'Changed reviewed instructions.' },
        slackChannels: [{ channel: 'C123', expectedVersion: 0, replaceAgentId: null }],
      },
    }),
  );
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(edited));
  await f.accept(service, command);
  assert.deepEqual((await f.state()).activations, before.activations);
  const blocked = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error, 'slack-channel-setup-unavailable');
  assert.equal((await f.state()).agent.enabled, true);
  assert.deepEqual((await f.state()).activations, before.activations);
  assert.equal((await f.state()).agent.policy_version, before.agent.policy_version);
  const allowed = createAgentSetup(f.runtime, undefined, {
    attachSlack: async () => ({ version: 1, channelResponses: true }),
  });
  assert.equal((await allowed.advance(f.w.id, f.user, command.commandId)).status, 'active');
  assert.deepEqual((await f.state()).activations, [command.activationId]);
});

test('review versions, sponsorship, replacement and current membership are enforced', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const value = await f.input({
    setup: {
      ...f.setup(),
      slackChannels: [{ channel: 'C123', expectedVersion: 2, replaceAgentId: randomUUID() }],
      schedules: [
        {
          id: randomUUID(),
          action: { kind: 'task', text: 'Check.', limits },
          trigger: { kind: 'interval', minutes: 60 },
          sponsorMembershipId: f.member,
        },
      ],
    },
  });
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, value);
  await assert.rejects(
    service.saveDraft(f.w.id, f.user, f.agentId, { ...value, setup: f.setup() }),
    /idempotency-conflict/,
  );
  await assert.rejects(
    service.saveDraft(f.w.id, f.user, f.agentId, { ...value, requestId: randomUUID() }),
    /setup-version-conflict/,
  );
  await assert.rejects(
    service.publish(f.w.id, f.user, f.agentId, { ...f.decision(draft), digest: '0'.repeat(64) }),
    /setup-digest-conflict/,
  );
  await assert.rejects(
    service.publish(f.w.id, f.user, f.agentId, {
      ...f.decision(draft),
      consent: { sponsorScheduleIds: [], replaceChannels: [] },
    }),
    /schedule-sponsor-consent-required/,
  );
  await assert.rejects(
    service.publish(f.w.id, f.user, f.agentId, {
      ...f.decision(draft),
      consent: { sponsorScheduleIds: draft.setup.schedules.map(s => s.id), replaceChannels: [] },
    }),
    /slack-replacement-consent-required/,
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [f.member]);
  await assert.rejects(service.publish(f.w.id, f.user, f.agentId, f.decision(draft)));
  assert.equal((await f.state()).agent, undefined);
});

test('changed policy after Soul acceptance blocks activation without overwriting the newer policy', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input());
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  await createSavedAgentService(f.runtime).updatePolicy(f.w.id, f.user, f.agentId, {
    ...f.setup().policy,
    owningTeamId: null,
    version: 0,
  });
  const result = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'policy-version-conflict');
  assert.equal((await f.state()).agent.policy_version, 1);
  assert.equal((await f.state()).agent.enabled, false);
  assert.deepEqual((await f.state()).activations, []);
});

test('publication resume rechecks removed membership after Soul accepted the definition', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input());
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [f.member]);
  await assert.rejects(service.advance(f.w.id, f.user, command.commandId));
  assert.equal((await f.state()).agent.enabled, false);
  assert.deepEqual((await f.state()).activations, []);
  assert.deepEqual((await f.state()).schedules, []);
});

test('chat full setup approves the same coordinator; historical drafts stay save-only', async t => {
  const f = await environment(t),
    chats = createConversations(f.runtime),
    drafts = createAuthoringDrafts(f.runtime);
  const context = await createSavedAgentService(f.runtime).context(f.w.id, f.user);
  assert.ok(context.builtinSkills.every(skill => skill.revision === 'latest'));
  const chatId = randomUUID();
  await chats.create(f.w.id, f.user, { chatId, commandId: randomUUID() });
  async function propose(full) {
    const sent = await chats.send(f.w.id, f.user, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Prepare an agent for review.' }],
    });
    let result;
    const { definition, owningTeamId, ...setup } = f.setup();
    const call = {
      tool: 'agents.draft',
      agent: 'new',
      input: {
        expectedSoulRevision: await f.head(),
        definition,
        owningTeamId,
        ...(full ? { setup, expectedPolicyVersion: 0, expectedActivationIds: [] } : {}),
      },
    };
    await createConversationExecutor(f.runtime, async ({ executeTool }) => {
      result = await executeTool('agents.draft', false, context =>
        createChatTools(context.runtime).invoke(context, call),
      );
      return { text: 'Review the exact setup.', sources: [] };
    }).process({ workspaceId: f.w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    return result;
  }
  const legacy = await propose(false);
  await assert.rejects(
    drafts.decide(f.w.id, f.user, chatId, legacy.draftId, {
      commandId: randomUUID(),
      digest: legacy.digest,
      decision: 'activate',
    }),
    /setup-review-required/,
  );
  const full = await propose(true);
  const decision = {
    commandId: randomUUID(),
    digest: full.digest,
    decision: 'activate',
    consent: { sponsorScheduleIds: [], replaceChannels: [] },
  };
  const outcome = await drafts.decide(f.w.id, f.user, chatId, full.draftId, decision);
  assert.equal(outcome.kind, 'agent');
  assert.equal(outcome.setupReceipt.status, 'preparing');
  assert.equal((await f.worker.prepare(f.w.id, outcome.receipt.commandId)).status, 'accepted');
  const setup = createAgentSetup(f.runtime);
  assert.equal((await setup.advance(f.w.id, f.user, outcome.setupReceipt.commandId)).status, 'active');
  const reread = await drafts.read(f.w.id, f.user, chatId, full.draftId);
  assert.equal(reread.status, 'saved');
  assert.equal(reread.outcome.setupReceipt.status, 'active');
  const replayed = await drafts.decide(f.w.id, f.user, chatId, full.draftId, decision);
  assert.equal(replayed.setupReceipt.commandId, outcome.setupReceipt.commandId);
  assert.equal(replayed.setupReceipt.status, 'active');
});
