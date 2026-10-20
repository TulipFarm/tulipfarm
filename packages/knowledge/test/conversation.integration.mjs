import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, connect, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { commonCompatibility, createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { AccessDenied, requireProtectedSource } from '@tulipfarm/access';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import {
  createConversationKnowledge,
  createKnowledge,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createKnowledgeAgentTools,
  withKnowledgeSourceAuthorization,
  KnowledgeError,
  knowledgeLimits,
} from '../dist/index.js';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

test('conversation Knowledge publishes saved recaps and dynamically retains the source audience', async t => {
  const db = await fixture();
  let runtime, search;
  try {
    await loadPlatformBaseline(db.platform);
    const ws = await db.create(await workspaceTableMigrations());
    const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 2,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
    });
    const owner = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const peer = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const admin = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
    for (const actor of [owner, peer])
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        actor.membershipId,
        actor.userId,
      ]);
    const service = createConversationKnowledge({ runtime });
    const core = createKnowledge({ runtime });
    const embeddings = createKnowledgeEmbeddings({ runtime, config: { kind: 'disabled' } });
    search = createKnowledgeSearch({ runtime, embeddings });
    const tools = createKnowledgeAgentTools({ runtime, search });
    const protectedRuntime = withKnowledgeSourceAuthorization(runtime);
    const find = (actor, query = 'orchid') =>
      search.search(ws.id, actor.userId, { kind: 'typing', query, filters: { kinds: ['conversation'] } });
    const reference = hit => {
      const { ordinal: _ordinal, ...source } = hit.citation;
      return source;
    };
    const read = (actor, hit) => tools.read(ws.id, actor, `${hit.citation.publicationId}:${hit.citation.ordinal}`);
    const projectId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_projects')} (id,name,creator_membership_id) VALUES ($1,'Knowledge team',$2)`,
      [projectId, owner.membershipId],
    );
    for (const actor of [owner, peer])
      await db.platform.query(
        `INSERT INTO ${table('tf_project_members')} (project_id,membership_id,role) VALUES ($1,$2,'member')`,
        [projectId, actor.membershipId],
      );
    async function recap({
      conversationId = randomUUID(),
      generation = 1,
      coveredThrough = 1,
      project = null,
      requester = owner,
      sources = [],
      title = 'Orchid agreement',
      text = 'Orchid delivery was agreed. Open work: send the invoice.',
    } = {}) {
      const coverageMessageId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id,project_id,is_closed,activity_generation,next_message_sequence)
        VALUES ($1,$2,$3,$4,true,$5,$6) ON CONFLICT (id) DO UPDATE SET is_closed=true,activity_generation=$5,next_message_sequence=$6`,
        [conversationId, requester.userId, requester.membershipId, project, generation, coveredThrough * 2 + 1],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id)
        VALUES ($1,$2,$3,'human',$4)`,
        [coverageMessageId, conversationId, coveredThrough * 2, requester.membershipId],
      );
      const input = {
        workspaceId: ws.id,
        conversationId,
        generation,
        coveredThrough,
        coverageMessageId,
        title,
        text,
        sources: [{ kind: 'private-conversation', conversationId }, ...sources],
        requester,
      };
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_maintenance')}
        (id,conversation_id,generation,state,requester_user_id,requester_membership_id,covered_through,coverage_message_id,sources,recap)
        VALUES ($1,$2,$3,'publishing',$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          conversationId,
          generation,
          requester.userId,
          requester.membershipId,
          coveredThrough,
          coverageMessageId,
          JSON.stringify(input.sources),
          text,
        ],
      );
      return input;
    }
    const privateInput = await recap();
    let first, firstHit;
    await t.test('creating the grouped source obeys the normal 100-source limit', async () => {
      const ids = [];
      for (let index = 0; index < knowledgeLimits.sources; index++) {
        ids.push(randomUUID());
        await db.platform.query(
          `INSERT INTO ${table('sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,'note',$2,$3,$4)`,
          [ids.at(-1), owner.membershipId, `initial-quota-${index}`, owner.membershipId],
        );
      }
      await assert.rejects(
        service.publish(privateInput),
        error => error instanceof KnowledgeError && error.code === 'quota',
      );
      assert.equal(
        (await db.platform.query(`SELECT 1 FROM ${table('sources')} WHERE provider='conversation'`)).rowCount,
        0,
      );
      await db.platform.query(`DELETE FROM ${table('sources')} WHERE id=ANY($1::uuid[])`, [ids]);
    });
    await t.test(
      'one stable document, immutable original, lexical ready before embeddings and retry after lost acknowledgement',
      async () => {
        first = await service.publish(privateInput);
        assert.deepEqual(await service.publish(privateInput), first);
        firstHit = (await find(owner)).hits[0];
        assert.ok(firstHit);
        assert.equal(firstHit.citation.documentId, first.documentId);
        assert.equal(
          (await service.original(ws.id, owner.userId, first.documentId, first.revisionId)).bytes.toString(),
          privateInput.text,
        );
        assert.equal((await service.evidence(ws.id, owner.userId, firstHit.citation)).original.kind, 'conversation');
        assert.equal(
          (
            await db.platform.query(`SELECT count(*)::int AS n FROM ${table('revisions')} WHERE document_id=$1`, [
              first.documentId,
            ])
          ).rows[0].n,
          1,
        );
        assert.deepEqual(await embeddings.due(ws.id), []);
        assert.equal((await find(owner)).hits.length, 1);
        const login = await connect(db.login(ws));
        try {
          await assert.rejects(
            login.query(`UPDATE ${table('conversation_revisions')} SET original_text='changed' WHERE revision_id=$1`, [
              first.revisionId,
            ]),
            /permission denied/,
          );
          await assert.rejects(
            login.query(`DELETE FROM ${table('conversation_revisions')} WHERE revision_id=$1`, [first.revisionId]),
            /permission denied/,
          );
        } finally {
          await login.end();
        }
      },
    );
    await t.test('group discovery never grants another private chat or global source management', async () => {
      for (const actor of [peer, admin]) {
        const input = await recap({
          requester: actor,
          title: 'Dahlia private',
          text: `Dahlia private evidence for ${actor.membershipId}.`,
        });
        const published = await service.publish(input);
        const hit = (await find(actor, 'dahlia')).hits[0];
        assert.ok(hit);
        assert.equal(hit.citation.sourceId, firstHit.citation.sourceId);
        assert.equal((await read(owner, hit)).result.error, 'knowledge-unavailable');
        await assert.rejects(service.original(ws.id, owner.userId, published.documentId), AccessDenied);
        await assert.rejects(core.readEvidence(ws.id, owner, hit.citation), AccessDenied);
        await assert.rejects(core.validateDependencies(ws.id, owner, [hit.citation]), AccessDenied);
        await assert.rejects(
          protectedRuntime.transaction(ws.id, { minimum: 1, maximum: commonCompatibility.maximum }, tx =>
            requireProtectedSource(tx, owner, reference(hit)),
          ),
          AccessDenied,
        );
      }
      await core.validateDependencies(ws.id, owner, [firstHit.citation]);
      for (const actor of [owner, peer, admin])
        await assert.rejects(core.manageSource(ws.id, actor, firstHit.citation.sourceId, 'remove'), AccessDenied);
      assert.equal((await find(owner, 'dahlia')).hits.length, 0);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS count FROM ${table('sources')} WHERE provider='conversation'`,
          )
        ).rows[0].count,
        1,
      );
    });
    await t.test('private sources remain private even for workspace admins', async () => {
      for (const actor of [peer, admin]) {
        assert.equal((await find(actor)).hits.length, 0);
        assert.equal((await read(actor, firstHit)).result.error, 'knowledge-unavailable');
        await assert.rejects(service.evidence(ws.id, actor.userId, firstHit.citation), AccessDenied);
        await assert.rejects(service.original(ws.id, actor.userId, first.documentId), AccessDenied);
      }
    });
    await t.test('a queued retry invalidates evidence even if no message or closure flag changed', async () => {
      const turnId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_turns')} (id,conversation_id,source_message_id,accepted_sequence,status)
        VALUES ($1,$2,$3,2,'queued')`,
        [turnId, privateInput.conversationId, privateInput.coverageMessageId],
      );
      for (const status of ['queued', 'waiting', 'reconciling']) {
        await db.platform.query(`UPDATE ${table('tf_conversation_turns')} SET status=$2 WHERE id=$1`, [turnId, status]);
        assert.equal((await find(owner)).hits.length, 0);
        assert.equal((await read(owner, firstHit)).result.error, 'knowledge-unavailable');
        await assert.rejects(service.publish(privateInput), AccessDenied);
      }
      await db.platform.query(`UPDATE ${table('tf_conversation_turns')} SET status='cancelled' WHERE id=$1`, [turnId]);
      assert.equal((await find(owner)).hits.length, 1);
    });
    await t.test(
      'reopening and generation mismatch immediately invalidate retained citations, reads and search',
      async () => {
        await db.platform.query(`UPDATE ${table('tf_conversations')} SET is_closed=false WHERE id=$1`, [
          privateInput.conversationId,
        ]);
        assert.equal((await find(owner)).hits.length, 0);
        assert.equal((await read(owner, firstHit)).result.error, 'knowledge-unavailable');
        await assert.rejects(
          protectedRuntime.transaction(ws.id, { minimum: 1, maximum: commonCompatibility.maximum }, tx =>
            requireProtectedSource(tx, owner, reference(firstHit)),
          ),
          AccessDenied,
        );
        await assert.rejects(service.publish(privateInput), AccessDenied);
        await db.platform.query(
          `UPDATE ${table('tf_conversations')} SET is_closed=true,activity_generation=2 WHERE id=$1`,
          [privateInput.conversationId],
        );
        assert.equal((await find(owner)).hits.length, 0);
        const refreshed = await recap({
          conversationId: privateInput.conversationId,
          generation: 2,
          coveredThrough: 2,
          text: 'Orchid invoice was sent. Open work: confirm delivery.',
        });
        const next = await service.publish(refreshed);
        assert.equal(next.documentId, first.documentId);
        assert.notEqual(next.revisionId, first.revisionId);
        assert.deepEqual(await service.publish(refreshed), next);
        assert.equal((await read(owner, firstHit)).result.error, 'knowledge-unavailable');
        firstHit = (await find(owner)).hits[0];
        assert.equal(firstHit.citation.revisionId, next.revisionId);
      },
    );
    let shared, sharedHit;
    await t.test(
      'shared project readers, archived chat inclusion, archived project exclusion and member removal',
      async () => {
        shared = await recap({ project: projectId, text: 'Orchid shared shipping plan and open work.' });
        await db.platform.query(`UPDATE ${table('tf_conversations')} SET archived_at=clock_timestamp() WHERE id=$1`, [
          shared.conversationId,
        ]);
        await service.publish(shared);
        sharedHit = (await find(peer)).hits[0];
        assert.ok(sharedHit);
        assert.equal(sharedHit.citation.sourceId, firstHit.citation.sourceId);
        assert.equal((await read(peer, sharedHit)).result.source, 'conversation');
        assert.equal((await find(admin)).hits.length, 0);
        await db.platform.query(
          `UPDATE ${table('tf_project_members')} SET removed_at=clock_timestamp() WHERE project_id=$1 AND membership_id=$2`,
          [projectId, peer.membershipId],
        );
        assert.equal((await find(peer)).hits.length, 0);
        assert.equal((await read(peer, sharedHit)).result.error, 'knowledge-unavailable');
        await db.platform.query(`UPDATE ${table('tf_project_members')} SET removed_at=NULL WHERE project_id=$1`, [
          projectId,
        ]);
        await db.platform.query(`UPDATE ${table('tf_projects')} SET archived_at=clock_timestamp() WHERE id=$1`, [
          projectId,
        ]);
        assert.equal((await find(peer)).hits.length, 0);
        await assert.rejects(service.publish(shared), AccessDenied);
        await db.platform.query(`UPDATE ${table('tf_projects')} SET archived_at=NULL WHERE id=$1`, [projectId]);
        assert.equal((await find(peer)).hits.length, 1);
      },
    );
    await t.test(
      'transitive private dependencies narrow project audience and source deletion invalidates every evidence path',
      async () => {
        const derived = await recap({
          project: projectId,
          text: 'Orchid transitive private findings.',
          sources: [reference(firstHit)],
        });
        const result = await service.publish(derived);
        const hit = (await find(owner)).hits.find(item => item.citation.documentId === result.documentId);
        assert.ok(hit);
        assert.ok(!(await find(peer)).hits.some(item => item.citation.documentId === result.documentId));
        assert.equal((await read(peer, hit)).result.error, 'knowledge-unavailable');
        await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at=clock_timestamp() WHERE id=$1`, [
          privateInput.conversationId,
        ]);
        assert.ok(!(await find(owner)).hits.some(item => item.citation.documentId === result.documentId));
        assert.equal((await read(owner, hit)).result.error, 'knowledge-unavailable');
        await assert.rejects(service.evidence(ws.id, owner.userId, hit.citation), AccessDenied);
        await assert.rejects(
          protectedRuntime.transaction(ws.id, { minimum: 1, maximum: commonCompatibility.maximum }, tx =>
            requireProtectedSource(tx, owner, reference(hit)),
          ),
          AccessDenied,
        );
        assert.equal((await read(peer, sharedHit)).result.source, 'conversation');
        assert.equal(
          (
            await db.platform.query(`SELECT state,access_epoch FROM ${table('sources')} WHERE id=$1`, [
              firstHit.citation.sourceId,
            ])
          ).rows[0].state,
          'active',
        );
        assert.equal(
          (
            await db.platform.query(`SELECT access_epoch FROM ${table('sources')} WHERE id=$1`, [
              firstHit.citation.sourceId,
            ])
          ).rows[0].access_epoch,
          firstHit.citation.accessEpoch,
        );
        assert.equal(
          (
            await db.platform.query(
              `SELECT tombstoned_at IS NOT NULL AND retain_until>=tombstoned_at+interval '30 days' AS retained
        FROM ${table('documents')} WHERE id=$1`,
              [first.documentId],
            )
          ).rows[0].retained,
          true,
        );
        // Reset the fixture only; deleting a chat is not a supported restore action.
        await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at=NULL WHERE id=$1`, [
          privateInput.conversationId,
        ]);
        await db.platform.query(
          `UPDATE ${table('documents')} SET tombstoned_at=NULL,retain_until=NULL,lexical_publication_id=$2 WHERE id=$1`,
          [first.documentId, firstHit.citation.publicationId],
        );
      },
    );
    await t.test(
      'group readers cannot write another chat and publication requires latest human or a resume receipt',
      async () => {
        await assert.rejects(
          core.recordFailure(ws.id, peer, {
            documentId: sharedHit.citation.documentId,
            revisionId: sharedHit.citation.revisionId,
            axis: 'embedding',
            failure: 'provider',
          }),
          AccessDenied,
        );
        const commandId = randomUUID();
        await db.platform.query(
          `UPDATE ${table('tf_conversation_maintenance')} SET requester_membership_id=$2,requester_user_id=$3
        WHERE conversation_id=$1`,
          [shared.conversationId, peer.membershipId, peer.userId],
        );
        await assert.rejects(service.publish({ ...shared, requester: peer }), AccessDenied);
        await db.platform.query(
          `UPDATE ${table('tf_conversation_maintenance')} SET resume_command_id=$2 WHERE conversation_id=$1`,
          [shared.conversationId, commandId],
        );
        await assert.rejects(service.publish({ ...shared, requester: peer, resumeCommandId: commandId }), AccessDenied);
        await db.platform.query(
          `UPDATE ${table('tf_conversation_maintenance')} SET requester_membership_id=$2,requester_user_id=$3,resume_command_id=NULL
        WHERE conversation_id=$1`,
          [shared.conversationId, owner.membershipId, owner.userId],
        );
        await service.publish(shared);
      },
    );
    await t.test('self summaries and corrupt transitive dependency cycles fail closed without recursion', async () => {
      const forged = { ...shared, sources: [...shared.sources, reference(sharedHit)] };
      await db.platform.query(
        `UPDATE ${table('tf_conversation_maintenance')} SET sources=$2 WHERE conversation_id=$1`,
        [shared.conversationId, JSON.stringify(forged.sources)],
      );
      await assert.rejects(service.publish(forged), AccessDenied);
      await db.platform.query(
        `UPDATE ${table('tf_conversation_maintenance')} SET sources=$2 WHERE conversation_id=$1`,
        [shared.conversationId, JSON.stringify(shared.sources)],
      );
      const current = firstHit.citation.revisionId;
      await db.platform.query(`UPDATE ${table('revisions')} SET sources=$2 WHERE id=$1`, [
        current,
        JSON.stringify([reference(sharedHit)]),
      ]);
      await db.platform.query(`UPDATE ${table('revisions')} SET sources=$2 WHERE id=$1`, [
        sharedHit.citation.revisionId,
        JSON.stringify([reference(firstHit)]),
      ]);
      assert.equal((await read(owner, firstHit)).result.error, 'knowledge-unavailable');
      await assert.rejects(service.evidence(ws.id, owner.userId, sharedHit.citation), AccessDenied);
      await db.platform.query(`UPDATE ${table('revisions')} SET sources='[]' WHERE id=ANY($1::uuid[])`, [
        [current, sharedHit.citation.revisionId],
      ]);
    });
    await t.test('new activity between preflight and publication leaves no stale revision or publication', async () => {
      const racing = await recap();
      let calls = 0;
      const fenced = createConversationKnowledge({
        runtime: {
          ...runtime,
          transaction: async (...args) => {
            const result = await runtime.transaction(...args);
            if (++calls === 1)
              await db.platform.query(
                `UPDATE ${table('tf_conversations')} SET is_closed=false,activity_generation=activity_generation+1 WHERE id=$1`,
                [racing.conversationId],
              );
            return result;
          },
        },
      });
      await assert.rejects(fenced.publish(racing), AccessDenied);
      assert.equal(
        (
          await db.platform.query(`SELECT 1 FROM ${table('conversation_revisions')} WHERE conversation_id=$1`, [
            racing.conversationId,
          ])
        ).rowCount,
        0,
      );
    });
    await t.test('removed authority cannot publish or retry through an admin identity', async () => {
      const blocked = await recap();
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        owner.membershipId,
      ]);
      await assert.rejects(service.publish(blocked), AccessDenied);
      await assert.rejects(service.publish({ ...blocked, requester: admin }), AccessDenied);
      assert.equal((await read(owner, sharedHit)).result.error, 'knowledge-unavailable');
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
        owner.membershipId,
      ]);
      await service.publish(blocked);
    });
    await t.test(
      'embedding failure preserves keyword publication and standard paid jobs can finish independently',
      async () => {
        await db.platform.query(
          `UPDATE ${table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
        );
        const fresh = await recap({ text: 'Orchid embedding-only fixture.' });
        const document = await service.publish(fresh);
        let fail = true,
          calls = 0;
        const enabled = createKnowledgeEmbeddings({
          runtime,
          config: {
            kind: 'enabled',
            endpoint: 'https://example.services.ai.azure.com/',
            apiKey: 'fixture',
            profile: knowledgeEmbeddingProfile,
          },
          capacity: async () => true,
          provider: async input => {
            calls++;
            if (fail) throw new Error('fixture provider failure');
            return {
              dispatch: 'dispatched',
              inputTokensUpperBound: 100,
              requestId: 'conversation-fixture',
              usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
              result: {
                kind: 'success',
                model: knowledgeEmbeddingProfile.model,
                vectors: input.inputs.map(() => Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))),
              },
            };
          },
        });
        for (let i = 0; i < 10; i++) {
          for (const work of await enabled.due(ws.id)) await enabled.process(work);
          if (
            (
              await db.platform.query(`SELECT 1 FROM ${table('embedding_jobs')} WHERE document_id=$1`, [
                document.documentId,
              ])
            ).rowCount
          )
            break;
        }
        assert.ok(calls > 0);
        assert.ok((await find(owner)).hits.some(item => item.citation.documentId === document.documentId));
        const status = await enabled.documentStatus(ws.id, owner.userId, document.documentId);
        assert.notEqual(status.state, 'ready');
        fail = false;
        if (status.canRetry) {
          const commandId = randomUUID();
          const retried = await enabled.resumeDocument(ws.id, owner.userId, document.documentId, commandId);
          assert.equal(
            (await enabled.resumeDocument(ws.id, owner.userId, document.documentId, commandId)).generation,
            retried.generation,
          );
          for (const work of await enabled.due(ws.id)) await enabled.process(work);
        }
        assert.equal((await enabled.documentStatus(ws.id, owner.userId, document.documentId)).state, 'ready');
        const retained = await db.platform.query(
          `SELECT lexical_publication_id FROM ${table('documents')} WHERE id=$1`,
          [document.documentId],
        );
        assert.ok(retained.rows[0].lexical_publication_id);
        const blocked = await recap({
          project: projectId,
          text: 'Orchid authorize a new project member for embeddings.',
        });
        const blockedDocument = await service.publish(blocked);
        await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=0`);
        await db.platform.query(`UPDATE ${table('credit_group')} SET unfunded=1`);
        const before = calls;
        for (const work of await enabled.due(ws.id)) await enabled.process(work);
        assert.equal(
          (await enabled.documentStatus(ws.id, owner.userId, blockedDocument.documentId)).state,
          'credits-blocked',
        );
        assert.equal(calls, before);
        const commandId = randomUUID();
        await db.platform.query(
          `UPDATE ${table('tf_conversation_maintenance')} SET requester_membership_id=$2,requester_user_id=$3,resume_command_id=$4 WHERE conversation_id=$1`,
          [blocked.conversationId, peer.membershipId, peer.userId, commandId],
        );
        await db.platform.query(
          `INSERT INTO ${table('tf_conversation_maintenance_commands')} (membership_id,command_id,conversation_id) VALUES ($1,$2,$3)`,
          [peer.membershipId, commandId, blocked.conversationId],
        );
        await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=10000000000000`);
        await db.platform.query(`UPDATE ${table('credit_group')} SET unfunded=0`);
        const resumeInput = { ...blocked, requester: peer, resumeCommandId: commandId };
        const resumed = createConversationKnowledge({ runtime, embeddings: enabled });
        await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          owner.membershipId,
        ]);
        await resumed.publish(resumeInput);
        for (const work of await enabled.due(ws.id)) await enabled.process(work);
        assert.equal((await enabled.documentStatus(ws.id, peer.userId, blockedDocument.documentId)).state, 'ready');
        assert.equal(
          (await service.original(ws.id, peer.userId, blockedDocument.documentId)).bytes.toString(),
          blocked.text,
        );
        await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
          owner.membershipId,
        ]);
        const billedCalls = calls;
        await resumed.publish(resumeInput);
        assert.equal(calls, billedCalls);
        assert.equal(
          (
            await db.platform.query(
              `SELECT requester_membership_id FROM ${table('conversation_revisions')} WHERE revision_id=$1`,
              [blockedDocument.revisionId],
            )
          ).rows[0].requester_membership_id,
          owner.membershipId,
        );
      },
    );
    await t.test('changed payload cannot rewrite an immutable generation receipt', async () => {
      await assert.rejects(service.publish({ ...shared, text: 'forged content' }), AccessDenied);
      await service.publish({ ...shared, title: 'Changed title' });
      assert.equal((await service.evidence(ws.id, owner.userId, sharedHit.citation)).title, shared.title);
    });
    const grouped = [];
    for (let batch = 0; batch < 6; batch++)
      await t.test(`grouped source publishes distinct private chat documents, batch ${batch + 1}`, async () => {
        for (let index = 0; index < (batch === 5 ? 1 : 20); index++) {
          const input = await recap({
            requester: peer,
            title: 'Needle private ranking',
            text: `${'Needle '.repeat(60)}private ranking fixture ${grouped.length}.`,
          });
          grouped.push({ input, result: await service.publish(input) });
        }
      });
    await t.test(
      '101 private documents cannot crowd out another group reader or leak titles and citations',
      async () => {
        assert.equal(grouped.length, 101);
        const input = await recap({ title: 'Authorized delivery', text: 'Needle authorized delivery.' });
        const published = await service.publish(input);
        const own = await find(owner, 'needle');
        assert.equal(own.hits.length, 1);
        assert.equal(own.hits[0].citation.documentId, published.documentId);
        assert.equal(own.continuation, null);
        const foreign = (await find(peer, 'needle')).hits[0];
        assert.ok(foreign);
        assert.equal((await read(owner, foreign)).result.error, 'knowledge-unavailable');
        assert.equal((await read(peer, own.hits[0])).result.error, 'knowledge-unavailable');
        assert.equal((await find(admin, 'needle')).hits.length, 0);
        await assert.rejects(service.original(ws.id, owner.userId, foreign.citation.documentId), AccessDenied);
        await assert.rejects(service.evidence(ws.id, owner.userId, foreign.citation), AccessDenied);
        await assert.rejects(
          protectedRuntime.transaction(ws.id, { minimum: 1, maximum: commonCompatibility.maximum }, tx =>
            requireProtectedSource(tx, owner, reference(foreign)),
          ),
          AccessDenied,
        );
        await db.platform.query(`UPDATE ${table('tf_conversations')} SET is_closed=false WHERE id=$1`, [
          input.conversationId,
        ]);
        assert.equal((await find(owner, 'needle')).hits.length, 0);
        assert.equal((await read(peer, foreign)).result.source, 'conversation');
        assert.equal(
          (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('sources')}`)).rows[0].count,
          1,
        );
        assert.ok(
          (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('documents')}`)).rows[0].count > 101,
        );
      },
    );
    await t.test('an existing group accepts new chat documents at the shared source quota', async () => {
      const remaining =
        knowledgeLimits.sources -
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('sources')}`)).rows[0].count;
      for (let index = 0; index < remaining; index++)
        await db.platform.query(
          `INSERT INTO ${table('sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,'note',$2,$3,$4)`,
          [randomUUID(), owner.membershipId, `quota-${index}`, owner.membershipId],
        );
      const input = await recap();
      await service.publish(input);
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('sources')}`)).rows[0].count,
        knowledgeLimits.sources,
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT recap FROM ${table('tf_conversation_maintenance')} WHERE conversation_id=$1`,
            [input.conversationId],
          )
        ).rows[0].recap,
        input.text,
      );
      await service.publish(shared);
    });
    await t.test('grouping preserves the document quota and permits idempotent publication at capacity', async () => {
      const count = (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('documents')}`)).rows[0].count;
      await db.platform.query(
        `INSERT INTO ${table('documents')} (id,source_id,native_id)
        SELECT gen_random_uuid(),$1,'document-quota-'||n FROM generate_series(1,$2::int) n`,
        [sharedHit.citation.sourceId, knowledgeLimits.documents - count],
      );
      await assert.rejects(
        service.publish(await recap()),
        error => error instanceof KnowledgeError && error.code === 'quota',
      );
      await service.publish(shared);
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('documents')}`)).rows[0].count,
        knowledgeLimits.documents,
      );
    });
  } finally {
    await search?.close();
    await runtime?.close();
    await db.close();
  }
});
