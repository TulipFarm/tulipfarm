import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { registerAgents } from '../../api/src/agents.ts';
import { registerSkills } from '../../api/src/skills.ts';
import { createAgentAuthoring } from '@tulipfarm/agents/authoring';
import { createAuthoringDrafts } from '@tulipfarm/agents/drafts';
import { createWorkspaceSkills } from '@tulipfarm/agents/workspace-skills';
import { initializeSoul, soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision } from '@tulipfarm/workspaces/soul-revisions';
import { githubChatFixture } from './github-read-fixture.mjs';

const hasSoulCredentials = Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);

test(
  'HTTP agent search totals and cursors contain only source-authorized agents',
  { timeout: 30000, skip: !hasSoulCredentials },
  async t => {
    const f = await githubChatFixture();
    t.after(() => f.close());
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='admin' WHERE id=$1`, [
      f.member.membershipId,
    ]);
    const accountId = await f.connect(),
      chatId = await f.chat();
    await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
    f.setProvider(async () => Response.json({ name: 'Secret acquisition Helios' }));
    const soul = soulStorageConfig();
    t.after(() => soul.client.destroy());
    const seed = { workspaceId: f.one.id, createdBy: f.member.userId, createdAt: new Date().toISOString() };
    const initial = await initializeSoul(soul, seed);
    await f.db.platform.query(`UPDATE ${f.table('tf_soul_head')} SET revision=$1 WHERE id=1`, [initial.commit]);
    const teamId = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Authors')`, [teamId]);
    // Agent creation needs membership in the owning team; admin status no longer substitutes for it.
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (team_id,membership_id) VALUES ($1,$2),($1,$3)`,
      [teamId, f.member.membershipId, f.one.membershipId],
    );
    f.decide([
      {
        tool: 'github.personal.read',
        operation: { kind: 'repository.read', owner: 'private-org', repo: 'restricted' },
      },
      {
        tool: 'agents.draft',
        agent: 'new',
        input: {
          expectedSoulRevision: initial.commit,
          owningTeamId: teamId,
          definition: { name: 'Secret acquisition Helios', instructions: 'Use the private plan.', tools: [] },
        },
      },
    ]);
    assert.equal((await f.send(chatId)).status, 'completed');
    const drafts = createAuthoringDrafts(f.runtime);
    const draftId = (
      await f.db.platform.query(`SELECT id FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1`, [
        chatId,
      ])
    ).rows[0].id;
    const draft = await drafts.read(f.one.id, f.member.userId, chatId, draftId);
    const saved = await drafts.decide(f.one.id, f.member.userId, chatId, draftId, {
      commandId: randomUUID(),
      digest: draft.digest,
      decision: 'save',
    });
    assert.equal(saved.kind, 'agent');
    const secretId = saved.receipt.agentId;
    const authoring = createAgentAuthoring(f.runtime);
    const writer = authoring.withWriter(input =>
      prepareSoulRevision(
        soul,
        seed,
        input.parent ? { commit: input.expectedParentCommit, bucket: soul.bucket, ...input.parent } : initial,
        {
          kind: 'agent',
          commandId: input.commandId,
          expectedParentCommit: input.expectedParentCommit,
          createdAt: input.createdAt,
          definition: input.definition,
        },
      ),
    );
    assert.equal((await writer.prepare(f.one.id, saved.receipt.commandId)).status, 'accepted');
    const publicIds = ['00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-bfff-fffffffffffe'];
    for (const [index, id] of publicIds.entries()) {
      const revision = (await f.db.platform.query(`SELECT revision FROM ${f.table('tf_soul_head')} WHERE id=1`)).rows[0]
        .revision;
      const command = await authoring.save(f.one.id, f.one.userId, id, {
        requestId: randomUUID(),
        expectedSoulRevision: revision,
        expectedSavedRevision: null,
        owningTeamId: teamId,
        definition: { name: `Public guide ${index + 1}`, instructions: 'Use the public guide.', tools: [] },
      });
      assert.equal((await writer.prepare(f.one.id, command.commandId)).status, 'accepted');
    }
    let userId = f.member.userId;
    const app = Fastify();
    t.after(() => app.close());
    await app.register(
      async routes =>
        registerAgents(routes, {
          runtime: f.runtime,
          pool: f.db.platform,
          auth: { api: { getSession: async () => ({ user: { id: userId }, session: { id: 'listing' } }) } },
        }),
      { prefix: '/v1' },
    );
    const base = `/v1/workspaces/${f.one.id}/agents`;
    const list = async query => {
      const response = await app.inject({ url: `${base}?${new URLSearchParams(query)}` });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const owner = await list({ search: 'Helios' });
    assert.equal(owner.agents[0].name, 'Secret acquisition Helios');
    assert.equal(owner.count, 1);
    userId = f.one.userId;
    assert.equal((await app.inject({ url: `${base}/${secretId}` })).statusCode, 404);
    assert.deepEqual(await list({ search: 'Helios' }), { agents: [], count: 0, nextCursor: null });
    assert.deepEqual(await list({ search: 'Artemis' }), { agents: [], count: 0, nextCursor: null });
    const visible = await list({});
    assert.deepEqual(
      visible.agents.map(agent => agent.name),
      ['Public guide 1', 'Public guide 2'],
    );
    assert.equal(visible.count, 2);
    assert.equal(visible.nextCursor, null);
    const first = await list({ limit: '1' });
    assert.deepEqual(
      first.agents.map(agent => agent.id),
      [publicIds[0]],
    );
    assert.equal(first.nextCursor, publicIds[0]);
    assert.equal(Object.hasOwn(first, 'count'), false);
    const last = await list({ limit: '1', after: first.nextCursor });
    assert.deepEqual(
      last.agents.map(agent => agent.id),
      [publicIds[1]],
    );
    assert.equal(last.nextCursor, null);
    assert.equal(Object.hasOwn(last, 'count'), false);
    assert.deepEqual(
      (await list({ search: ' GUIDE 2 ' })).agents.map(agent => agent.name),
      ['Public guide 2'],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='member' WHERE id=$1`, [
      f.member.membershipId,
    ]);
    userId = f.member.userId;
    assert.deepEqual(await list({ search: 'Public' }), { agents: [], count: 0, nextCursor: null });
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [f.member.membershipId, teamId],
    );
    for (const id of publicIds)
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'read')`,
        [id, teamId],
      );
    assert.deepEqual(
      (await list({ search: 'Public' })).agents.map(agent => agent.name),
      ['Public guide 1', 'Public guide 2'],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='admin' WHERE id=$1`, [
      f.member.membershipId,
    ]);
    f.setProvider(async () => Response.json({ message: 'Denied' }, { status: 403 }));
    for (const reader of [f.one.userId, f.member.userId]) {
      userId = reader;
      assert.deepEqual(await list({ search: 'Helios' }), { agents: [], count: 0, nextCursor: null });
      assert.deepEqual(
        (await list({})).agents.map(agent => agent.name),
        ['Public guide 1', 'Public guide 2'],
      );
    }
    f.setProvider(async () => Response.json({ name: 'Secret acquisition Helios' }));
    assert.equal((await list({ search: 'Helios' })).agents[0].name, 'Secret acquisition Helios');
    const source = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_chat_authoring_drafts')} WHERE id=$1`, [draftId])
    ).rows[0].sources.find(source => source.kind === 'github-personal');
    const sources = Array.from({ length: 33 }, (_, index) => ({
      ...source,
      proof: { ...source.proof, operation: { ...source.proof.operation, repo: `restricted-${index}` } },
    }));
    await f.db.platform.query(`UPDATE ${f.table('tf_chat_authoring_drafts')} SET sources=$2 WHERE id=$1`, [
      draftId,
      JSON.stringify(sources),
    ]);
    const before = f.providerCalls.length;
    const unavailable = await app.inject({ url: `${base}?search=Helios` });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { error: 'agent-operation-unavailable' });
    assert.equal(f.providerCalls.length - before, 32);
    userId = f.one.userId;
    assert.deepEqual(await list({ search: 'Helios' }), { agents: [], count: 0, nextCursor: null });
  },
);

test('HTTP skill pagination never returns a hidden source-derived cursor', { timeout: 30000 }, async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const accountId = await f.connect(),
    chatId = await f.chat();
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
  f.setProvider(async () => Response.json({ name: 'Helios' }));
  const privateIds = ['10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001'];
  f.decide([
    { tool: 'github.personal.read', operation: { kind: 'repository.read', owner: 'private-org', repo: 'restricted' } },
    {
      tool: 'skills.draft',
      skillId: privateIds[0],
      input: {
        expectedVersion: 0,
        definition: {
          name: 'Secret Helios procedure',
          description: 'A private Helios procedure.',
          instructions: 'Private instructions.',
        },
      },
    },
  ]);
  assert.equal((await f.send(chatId)).status, 'completed');
  const drafts = createAuthoringDrafts(f.runtime);
  const draftId = (
    await f.db.platform.query(`SELECT id FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1`, [
      chatId,
    ])
  ).rows[0].id;
  const draft = await drafts.read(f.one.id, f.member.userId, chatId, draftId);
  const saved = await drafts.decide(f.one.id, f.member.userId, chatId, draftId, {
    commandId: randomUUID(),
    digest: draft.digest,
    decision: 'save',
  });
  assert.equal(saved.kind, 'skill');
  const skills = createWorkspaceSkills(f.runtime);
  await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='admin' WHERE id=$1`, [
    f.member.membershipId,
  ]);
  await skills.review(f.one.id, f.member.userId, privateIds[0], {
    requestId: randomUUID(),
    expectedVersion: 1,
    revision: saved.receipt.savedRevision,
  });
  await skills.save(
    f.one.id,
    f.member.userId,
    privateIds[1],
    {
      requestId: randomUUID(),
      expectedVersion: 0,
      definition: {
        name: 'Another Helios procedure',
        description: 'Use the private procedure.',
        instructions: 'Private instructions.',
      },
    },
    [{ kind: 'workspace-skill', skillId: privateIds[0], revision: saved.receipt.savedRevision }],
  );
  const publicIds = ['30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001'];
  for (const id of publicIds)
    await skills.save(f.one.id, f.one.userId, id, {
      requestId: randomUUID(),
      expectedVersion: 0,
      definition: {
        name: 'Public procedure',
        description: 'Use the public instructions.',
        instructions: 'Public instructions.',
      },
    });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(
    async routes =>
      registerSkills(routes, {
        runtime: f.runtime,
        auth: { api: { getSession: async () => ({ user: { id: f.one.userId }, session: { id: 'listing' } }) } },
      }),
    { prefix: '/v1' },
  );
  const list = async query => {
    const response = await app.inject({ url: `/v1/workspaces/${f.one.id}/skills?${new URLSearchParams(query)}` });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  assert.deepEqual(await list({ search: 'Helios', limit: '1' }), { workspace: [], nextCursor: null });
  const first = await list({ limit: '1' });
  assert.deepEqual(
    first.workspace.map(skill => skill.id),
    [publicIds[0]],
  );
  assert.equal(first.nextCursor, publicIds[0]);
  const last = await list({ limit: '1', after: first.nextCursor });
  assert.deepEqual(
    last.workspace.map(skill => skill.id),
    [publicIds[1]],
  );
  assert.equal(last.nextCursor, null);
});

test(
  'HTTP owner skill pages stop at visible lookahead and fail rather than truncate at the replay budget',
  { timeout: 30000 },
  async t => {
    const f = await githubChatFixture();
    t.after(() => f.close());
    const accountId = await f.connect(),
      chatId = await f.chat();
    await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
    f.setProvider(async () => Response.json({ name: 'Helios' }));
    f.decide([
      {
        tool: 'github.personal.read',
        operation: { kind: 'repository.read', owner: 'private-org', repo: 'restricted' },
      },
      {
        tool: 'skills.draft',
        skillId: randomUUID(),
        input: {
          expectedVersion: 0,
          definition: { name: 'Helios', description: 'A private procedure.', instructions: 'Private instructions.' },
        },
      },
    ]);
    assert.equal((await f.send(chatId)).status, 'completed');
    const source = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1`, [
        chatId,
      ])
    ).rows[0].sources.find(source => source.kind === 'github-personal');
    const skills = createWorkspaceSkills(f.runtime),
      ids = [];
    for (let index = 0; index < 34; index++) {
      const id = randomUUID();
      ids.push(id);
      await skills.save(
        f.one.id,
        f.member.userId,
        id,
        {
          requestId: randomUUID(),
          expectedVersion: 0,
          definition: {
            name: 'Helios procedure',
            description: 'A private Helios procedure.',
            instructions: 'Private instructions.',
          },
        },
        [
          {
            ...source,
            proof: { ...source.proof, operation: { ...source.proof.operation, repo: `restricted-${index}` } },
          },
        ],
      );
    }
    ids.sort();
    const app = Fastify();
    t.after(() => app.close());
    await app.register(
      async routes =>
        registerSkills(routes, {
          runtime: f.runtime,
          auth: { api: { getSession: async () => ({ user: { id: f.member.userId }, session: { id: 'listing' } }) } },
        }),
      { prefix: '/v1' },
    );
    const base = `/v1/workspaces/${f.one.id}/skills?search=Helios`;
    let before = f.providerCalls.length;
    const page = await app.inject({ url: `${base}&limit=1` });
    assert.equal(page.statusCode, 200);
    assert.deepEqual(
      page.json().workspace.map(skill => skill.id),
      [ids[0]],
    );
    assert.equal(page.json().nextCursor, ids[0]);
    assert.equal(f.providerCalls.length - before, 2);
    before = f.providerCalls.length;
    const unavailable = await app.inject({ url: `${base}&limit=100` });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { error: 'skill-operation-unavailable' });
    assert.equal(f.providerCalls.length - before, 32);
    const next = await app.inject({ url: `${base}&limit=1&after=${ids[0]}` });
    assert.equal(next.statusCode, 200);
    assert.deepEqual(
      next.json().workspace.map(skill => skill.id),
      [ids[1]],
    );
  },
);
