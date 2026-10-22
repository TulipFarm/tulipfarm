import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { registerSkills } from '../../api/src/skills.ts';
import { createAuthoringDrafts } from '@tulipfarm/agents/drafts';
import { createWorkspaceSkills, resolveProcedures } from '../../../packages/agents/src/workspace-skills.ts';
import { requireDraftSources } from '../../../packages/agents/src/draft-sources.ts';
import { createChatTools } from '@tulipfarm/agents/tools';
import { createSavedAgentService } from '../../../packages/agents/src/saved-service.ts';
import { createAgentStore } from '../../../packages/agents/src/store.ts';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { authConfig } from '../../api/src/auth.ts';
import { githubChatFixture } from './github-read-fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const privateText = 'Confidential repository plan 262';
const operation = { kind: 'repository.read', owner: 'private-org', repo: 'restricted' };
async function derived(f, read = operation) {
  const accountId = await f.connect(),
    chatId = await f.chat(),
    skillId = randomUUID();
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
  f.setProvider(async () => Response.json({ name: privateText }));
  f.decide(
    [
      { tool: 'github.personal.read', operation: read },
      {
        tool: 'skills.draft',
        skillId,
        input: {
          expectedVersion: 0,
          definition: {
            name: 'Repository plan',
            description: 'Use the repository content to plan the next steps.',
            instructions: privateText,
          },
        },
      },
    ],
    privateText,
  );
  assert.equal((await f.send(chatId)).status, 'completed');
  const draftId = (
    await f.db.platform.query(`SELECT id FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1`, [
      chatId,
    ])
  ).rows[0].id;
  const drafts = createAuthoringDrafts(f.runtime);
  const draft = await drafts.read(f.one.id, f.member.userId, chatId, draftId);
  assert.equal(draft.proposal.input.definition.instructions, privateText);
  return { accountId, chatId, skillId, draftId, drafts, draft };
}

for (const status of [401, 403, 404, 503, 'network', 'changed-search'])
  test(
    `retained GitHub ${status} fails closed before inference, history, draft read and save`,
    { timeout: 30000 },
    async t => {
      const f = await githubChatFixture();
      t.after(() => f.close());
      const d = await derived(
        f,
        status === 'changed-search'
          ? { kind: 'repository.search', query: 'org:private-org', page: 1, perPage: 10 }
          : operation,
      );
      f.decide([], privateText);
      assert.equal((await f.send(d.chatId, 'Summarize the retained plan.')).status, 'completed');
      assert.equal(
        JSON.stringify(await f.store.history(f.one.id, f.member.userId, d.chatId)).includes(privateText),
        true,
      );
      const before = f.modelRequests.length,
        calls = f.providerCalls.length;
      f.setProvider(async () => {
        if (status === 'network') throw new Error('offline');
        return status === 'changed-search'
          ? Response.json({ items: [] })
          : Response.json({ message: 'Access revoked' }, { status });
      });
      f.decide([], 'Must not reach the model');
      const denied = await f.send(d.chatId, 'Summarize without rereading.');
      assert.equal(denied.status, 'idle');
      assert.equal(
        (
          await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
            denied.turnId,
          ])
        ).rows[0].status,
        'blocked',
      );
      assert.equal(f.modelRequests.length, before);
      assert.ok(f.providerCalls.length > calls);
      assert.equal(
        JSON.stringify(await f.store.history(f.one.id, f.member.userId, d.chatId)).includes(privateText),
        false,
      );
      await assert.rejects(d.drafts.read(f.one.id, f.member.userId, d.chatId, d.draftId));
      await assert.rejects(
        d.drafts.decide(f.one.id, f.member.userId, d.chatId, d.draftId, {
          commandId: randomUUID(),
          digest: d.draft.digest,
          decision: 'save',
        }),
      );
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_workspace_skills')}`)).rows[0].n,
        0,
      );
    },
  );

test(
  'retained search with pinned targets survives provider metadata changes but not lost target access',
  { timeout: 30000 },
  async t => {
    const f = await githubChatFixture();
    t.after(() => f.close());
    const accountId = await f.connect(),
      chatId = await f.chat();
    await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
    let pushedAt = '2026-10-11T12:27:44Z',
      targetStatus = 200;
    f.setProvider(async url => {
      if (new URL(url).pathname === '/search/repositories')
        return Response.json({
          total_count: 1,
          incomplete_results: false,
          items: [
            { name: 'restricted', url: 'https://api.github.com/repos/private-org/restricted', pushed_at: pushedAt },
          ],
        });
      return targetStatus === 200
        ? Response.json({ name: 'restricted', pushed_at: pushedAt })
        : Response.json({ message: 'Not Found' }, { status: targetStatus });
    });
    f.decide(
      [
        {
          tool: 'github.personal.read',
          operation: { kind: 'repository.search', query: 'org:private-org', page: 1, perPage: 10 },
        },
      ],
      privateText,
    );
    assert.equal((await f.send(chatId)).status, 'completed');
    pushedAt = '2026-10-11T12:32:29Z';
    f.decide([], 'Follow-up answer');
    assert.equal((await f.send(chatId, 'Summarize the repositories again.')).status, 'completed');
    assert.equal(JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(privateText), true);
    targetStatus = 404;
    f.decide([], 'Must not reach the model');
    const denied = await f.send(chatId, 'Summarize after access loss.');
    assert.equal(
      (await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [denied.turnId]))
        .rows[0].status,
      'blocked',
    );
    assert.equal(JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(privateText), false);
  },
);

for (const [operation, change] of [
  [{ kind: 'repository.read', owner: 'private-org', repo: 'restricted' }, 'pushed_at'],
  [{ kind: 'issue.read', owner: 'private-org', repo: 'restricted', number: 7 }, 'comments'],
  [{ kind: 'pull.read', owner: 'private-org', repo: 'restricted', number: 7 }, 'head'],
]) {
  test(
    `retained ${operation.kind} survives a busy repository changing ${change} but not lost repository access`,
    { timeout: 30000 },
    async t => {
      const f = await githubChatFixture();
      t.after(() => f.close());
      const accountId = await f.connect(),
        chatId = await f.chat();
      await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
      let revision = 1,
        status = 200;
      f.setProvider(async () =>
        status === 200
          ? Response.json({
              id: 42,
              number: 7,
              name: 'restricted',
              title: 'Private roadmap',
              [change]: `revision-${revision}`,
              updated_at: `2026-10-11T12:0${revision}:00Z`,
            })
          : Response.json({ message: 'Not Found' }, { status }),
      );
      f.decide([{ tool: 'github.personal.read', operation }], privateText);
      assert.equal((await f.send(chatId)).status, 'completed');
      revision = 2;
      f.decide([], 'Follow-up answer');
      assert.equal((await f.send(chatId, 'Summarize it again.')).status, 'completed');
      assert.equal(
        JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(privateText),
        true,
      );
      status = 404;
      f.decide([], 'Must not reach the model');
      const denied = await f.send(chatId, 'Summarize after access loss.');
      assert.equal(
        (
          await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
            denied.turnId,
          ])
        ).rows[0].status,
        'blocked',
      );
      assert.equal(
        JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)).includes(privateText),
        false,
      );
    },
  );
}

test(
  'saved private skills retain owner/source closure through HTTP, review, activation, edits and derived reuse',
  { timeout: 30000 },
  async t => {
    const f = await githubChatFixture();
    t.after(() => f.close());
    const d = await derived(f),
      skills = createWorkspaceSkills(f.runtime);
    const saved = await d.drafts.decide(f.one.id, f.member.userId, d.chatId, d.draftId, {
      commandId: randomUUID(),
      digest: d.draft.digest,
      decision: 'save',
    });
    assert.equal(saved.kind, 'skill');
    assert.equal((await skills.read(f.one.id, f.member.userId, d.skillId)).definition.instructions, privateText);
    const app = Fastify();
    t.after(() => app.close());
    let reader = f.one.userId;
    const auth = { api: { getSession: async () => ({ user: { id: reader }, session: { id: 'test' } }) } };
    await app.register(async routes => registerSkills(routes, { runtime: f.runtime, auth }), { prefix: '/v1' });
    const httpRead = () => app.inject({ url: `/v1/workspaces/${f.one.id}/skills/${d.skillId}` });
    assert.equal((await httpRead()).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/workspaces/${f.one.id}/skills/${d.skillId}/review`,
          headers: { origin: authConfig().webOrigin },
          payload: { requestId: randomUUID(), expectedVersion: 1, revision: saved.receipt.savedRevision },
        })
      ).statusCode,
      404,
    );
    assert.deepEqual((await skills.list(f.one.id, f.one.userId)).workspace, []);
    await assert.rejects(
      skills.review(f.one.id, f.one.userId, d.skillId, {
        requestId: randomUUID(),
        expectedVersion: 1,
        revision: saved.receipt.savedRevision,
      }),
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='admin' WHERE id=$1`, [
      f.member.membershipId,
    ]);
    const reviewed = await skills.review(f.one.id, f.member.userId, d.skillId, {
      requestId: randomUUID(),
      expectedVersion: 1,
      revision: saved.receipt.savedRevision,
    });
    assert.equal(reviewed.enabled, true);
    const selection = [{ id: d.skillId, revision: saved.receipt.savedRevision }];
    assert.equal((await skills.resolve(f.one.id, f.member.userId, selection))[0].instructions, privateText);
    const listing = await createChatTools(f.runtime).invokeWithSources(
      { workspaceId: f.one.id, actor: { kind: 'human', ...f.member }, callId: randomUUID() },
      { tool: 'skills.workspace' },
    );
    assert.equal(
      listing.sources.some(source => source.kind === 'github-personal' && source.proof.operation.repo === 'restricted'),
      true,
    );
    await assert.rejects(skills.resolve(f.one.id, f.one.userId, selection));
    await assert.rejects(f.runtime.transaction(f.one.id, commonCompatibility, tx => resolveProcedures(tx, selection)));
    const source = { kind: 'workspace-skill', skillId: d.skillId, revision: saved.receipt.savedRevision };
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx =>
        requireDraftSources(tx, { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId }, [source]),
      ),
    );
    const edited = await skills.save(f.one.id, f.member.userId, d.skillId, {
      requestId: randomUUID(),
      expectedVersion: reviewed.version,
      definition: {
        name: 'Edited private plan',
        description: 'A private revision of the plan.',
        instructions: privateText,
      },
    });
    const persisted = (
      await f.db.platform.query(
        `SELECT definition FROM ${f.table('tf_workspace_skill_revisions')} WHERE skill_id=$1 AND revision=$2`,
        [d.skillId, edited.savedRevision],
      )
    ).rows[0].definition;
    assert.equal(
      persisted.sources.some(
        source => source.kind === 'github-personal' && source.proof.operation.repo === 'restricted',
      ),
      true,
    );
    const derivedId = randomUUID();
    const derivedSaved = await skills.save(
      f.one.id,
      f.member.userId,
      derivedId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: {
          name: 'Derived again',
          description: 'A procedure based on derived data.',
          instructions: privateText,
        },
      },
      [source],
    );
    await skills.review(f.one.id, f.member.userId, derivedId, {
      requestId: randomUUID(),
      expectedVersion: 1,
      revision: derivedSaved.savedRevision,
    });
    await assert.rejects(skills.read(f.one.id, f.one.userId, derivedId));
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx =>
        resolveProcedures(tx, [{ id: derivedId, revision: derivedSaved.savedRevision }]),
      ),
    );
    const agent = await savedTaskAgent(f.db, f.one, f.runtime, f.member.userId, f.member.membershipId, [], []);
    await assert.rejects(agent.activate(selection));
    const agents = createSavedAgentService(f.runtime);
    assert.equal(
      (await agents.list(f.one.id, f.one.userId)).agents.some(item => item.id === agent.agentId),
      false,
    );
    assert.equal(
      (await agents.list(f.one.id, f.member.userId)).agents.some(item => item.id === agent.agentId),
      true,
    );
    await assert.rejects(
      createAgentStore(f.runtime).startDelegated(
        f.one.id,
        { kind: 'human', ...f.member },
        { activationId: agent.activationId, scope: [] },
      ),
    );
    reader = f.member.userId;
    assert.equal((await httpRead()).json().definition.instructions, privateText);
    await f.service.disconnect(f.one.id, f.member.userId, d.accountId);
    assert.equal((await httpRead()).statusCode, 404);
    reader = f.one.userId;
    assert.equal((await httpRead()).statusCode, 404);
    await assert.rejects(
      skills.setEnabled(f.one.id, f.one.userId, d.skillId, {
        requestId: randomUUID(),
        expectedVersion: edited.version,
        enabled: true,
      }),
    );
    await assert.rejects(skills.resolve(f.one.id, f.member.userId, selection));
    await assert.rejects(skills.read(f.one.id, f.member.userId, derivedId));
    const stranger = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      randomUUID(),
      stranger,
    ]);
    await assert.rejects(skills.read(f.one.id, stranger, d.skillId));
    const publicId = randomUUID();
    const publicSaved = await skills.save(
      f.one.id,
      f.one.userId,
      publicId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: {
          name: 'Public procedure',
          description: 'Read and use the public guide.',
          instructions: 'Read the public guide.',
        },
      },
      [{ kind: 'public-web', url: 'https://example.com/guide' }],
    );
    await skills.review(f.one.id, f.one.userId, publicId, {
      requestId: randomUUID(),
      expectedVersion: 1,
      revision: publicSaved.savedRevision,
    });
    // Reviewed skills stay private to their creator until explicitly shared.
    await assert.rejects(skills.read(f.one.id, stranger, publicId));
    assert.equal(
      (await skills.read(f.one.id, f.one.userId, publicId)).definition.instructions,
      'Read the public guide.',
    );
    assert.equal(
      (
        await f.runtime.transaction(f.one.id, commonCompatibility, tx =>
          resolveProcedures(tx, [{ id: publicId, revision: publicSaved.savedRevision }]),
        )
      )[0].instructions,
      'Read the public guide.',
    );
  },
);

test(
  'explicit provider denial, missing legacy proof and concurrent readers cannot reuse retained content',
  { timeout: 30000 },
  async t => {
    const f = await githubChatFixture({ connectionsPerPool: 1 });
    t.after(() => f.close());
    const d = await derived(f);
    const parallel = await Promise.all([
      f.store.history(f.one.id, f.member.userId, d.chatId),
      d.drafts.read(f.one.id, f.member.userId, d.chatId, d.draftId),
    ]);
    assert.equal(JSON.stringify(parallel[0]).includes(privateText), true);
    assert.equal(parallel[1].proposal.input.definition.instructions, privateText);
    for (const status of [403, 404]) {
      const sent = await f.store.send(f.one.id, f.member.userId, d.chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Explicitly refresh.' }],
      });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1`,
        [sent.turnId],
      );
      f.setProvider(async () => Response.json({ message: 'Denied' }, { status }));
      await assert.rejects(
        f.reads.read(
          f.one.id,
          { kind: 'human', ...f.member },
          { conversationId: d.chatId, turnId: sent.turnId },
          operation,
        ),
        error => error.code === 'read-forbidden',
      );
      assert.equal((await f.service.status(f.one.id, f.member.userId, d.accountId)).state, 'active');
      assert.equal(
        JSON.stringify(await f.store.history(f.one.id, f.member.userId, d.chatId)).includes(privateText),
        false,
      );
      await assert.rejects(d.drafts.read(f.one.id, f.member.userId, d.chatId, d.draftId));
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET status='blocked',lease_until=NULL WHERE id=$1`,
        [sent.turnId],
      );
    }
    f.setProvider(async () => Response.json({ name: privateText }));
    const sources = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_chat_authoring_drafts')} WHERE id=$1`, [d.draftId])
    ).rows[0].sources;
    const source = sources.find(item => item.kind === 'github-personal');
    const { proof: _proof, ...legacy } = source;
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx =>
        requireDraftSources(tx, { kind: 'human', ...f.member }, [legacy]),
      ),
    );
    assert.equal(
      JSON.stringify(await f.store.history(f.one.id, f.member.userId, d.chatId)).includes(privateText),
      true,
    );
  },
);
