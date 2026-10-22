import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { verifyWorkspaceIsolation } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createKnowledge, KnowledgeError } from '../dist/index.js';
import { AccessDenied, SourceAuthorizationUnavailable, withMcpSourceContext } from '@tulipfarm/access';
import { createProjectMembership } from '../../conversations/dist/project-membership.js';
import { requireResultSources } from '../../conversations/dist/source-access.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const parserProfile = { id: 'text-v1', engine: 'text', version: '1', normalization: 'markdown-v1', ocr: 'disabled' };
const code = expected => error => error instanceof KnowledgeError && error.code === expected;

test('P0 direct-login isolation, immutable publication, eligibility and retention', async t => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    const one = await db.create(stream);
    const table = (name, workspace = one) =>
      qualified(workspace.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
    const two = await db.create(stream);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        const workspace = db.workspaces.find(item => item.id === id);
        assert.ok(workspace);
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
    });
    const owner = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const other = { kind: 'human', userId: one.userId, membershipId: one.membershipId };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      owner.membershipId,
      owner.userId,
    ]);
    const service = createKnowledge({ runtime });
    async function source(provider = 'note', api = service) {
      const id = randomUUID();
      await api.configureSource(one.id, owner, {
        id,
        provider,
        accountNamespace: provider === 'note' ? owner.membershipId : randomUUID(),
        selection: randomUUID(),
      });
      return id;
    }
    function revision(sourceId, overrides = {}) {
      return {
        id: randomUUID(),
        documentId: randomUUID(),
        sourceId,
        nativeId: randomUUID(),
        expectedRevisionId: null,
        sourceRevision: randomUUID(),
        title: 'Private handbook',
        canonicalUrl: null,
        original: { kind: 'object', key: randomUUID(), sha256: digest('original'), bytes: 8 },
        parserProfile,
        sources: [],
        ...overrides,
      };
    }
    function publication(input, overrides = {}) {
      return {
        id: randomUUID(),
        documentId: input.documentId,
        revisionId: input.id,
        markdown: '# Handbook\nReturn orders in 30 days.',
        pages: 1,
        tokens: 12,
        chunks: [
          { heading: 'Handbook', text: 'Return orders in 30 days.', tokens: 8, offset: { kind: 'page', page: 1 } },
        ],
        ...overrides,
      };
    }
    const sourceId = await source();
    const original = revision(sourceId);
    await service.observeRevision(one.id, owner, original);
    const build = publication(original);
    const citation = await service.publishLexical(one.id, owner, build);

    await t.test(
      'project authority does not grant personal knowledge access or admit uncomposed result sources',
      async () => {
        const projects = createProjectMembership(runtime);
        const projectId = randomUUID();
        await projects.create(one.id, owner.userId, { id: projectId, name: 'Knowledge integration' });
        // Admin status grants no project access; the owner appoints the admin as a manager explicitly.
        await assert.rejects(projects.read(one.id, other.userId, projectId), AccessDenied);
        await projects.member(one.id, owner.userId, projectId, {
          membershipId: other.membershipId,
          role: 'manager',
          removed: false,
        });
        assert.equal((await projects.read(one.id, other.userId, projectId)).project.manager, true);
        await assert.rejects(service.readEvidence(one.id, other, citation), AccessDenied);
        await assert.rejects(
          runtime.transaction(one.id, { minimum: 1, maximum: stream.length }, tx => {
            const { ordinal: _ordinal, ...dependency } = citation;
            return requireResultSources(tx, owner, randomUUID(), [dependency]);
          }),
          AccessDenied,
        );
        assert.equal((await service.readEvidence(one.id, owner, citation)).text, 'Return orders in 30 days.');
      },
    );

    await t.test(
      'runtime logins cannot cross workspaces, change immutable bytes or forge vector readiness',
      async () => {
        for (const workspace of [one, two]) await verifyWorkspaceIsolation(db.platform, workspace.id);
        const login = await connect(db.login(one));
        try {
          await denied(login, `SELECT * FROM ${table('revisions', two)}`);
          await denied(login, `UPDATE ${table('revisions')} SET title='forged' WHERE id=$1`, [original.id]);
          await denied(login, `DELETE FROM ${table('revisions')} WHERE id=$1`, [original.id]);
          await denied(login, `UPDATE ${table('publications')} SET markdown='forged' WHERE id=$1`, [build.id]);
          await assert.rejects(
            login.query(`UPDATE ${table('documents')} SET vector_publication_id=$1 WHERE id=$2`, [
              randomUUID(),
              original.documentId,
            ]),
            { code: '23503' },
          );
          await denied(login, `UPDATE ${table('vector_publications')} SET profile='{}'`);
        } finally {
          await login.end();
        }
        await assert.rejects(
          service.readEvidence(two.id, { kind: 'human', userId: two.userId, membershipId: two.membershipId }, citation),
          AccessDenied,
        );
        await assert.rejects(service.readEvidence(one.id, other, citation), AccessDenied);
        await assert.rejects(
          service.readEvidence(one.id, { kind: 'agent', runId: randomUUID() }, citation),
          AccessDenied,
        );
      },
    );

    await t.test(
      'duplicate delivery is idempotent and embedding failure preserves readable lexical evidence',
      async () => {
        await service.observeRevision(one.id, owner, original);
        assert.deepEqual(await service.publishLexical(one.id, owner, build), citation);
        await assert.rejects(
          service.observeRevision(one.id, owner, { ...original, title: 'Changed replay' }),
          code('conflict'),
        );
        await service.recordFailure(one.id, owner, {
          documentId: original.documentId,
          revisionId: original.id,
          axis: 'embedding',
          failure: 'provider',
        });
        assert.equal((await service.status(one.id, owner, original.documentId)).embedding, 'failed');
        assert.equal((await service.readEvidence(one.id, owner, citation)).text, 'Return orders in 30 days.');
        assert.equal(
          (
            await db.platform.query(`SELECT count(*)::int AS count FROM ${table('chunks')} WHERE publication_id=$1`, [
              build.id,
            ])
          ).rows[0].count,
          1,
        );
        await assert.rejects(
          withMcpSourceContext(
            { schema: one.names.schema, client: db.platform },
            [{ kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 }],
            () => service.publishLexical(one.id, owner, build),
          ),
          AccessDenied,
        );
      },
    );

    await t.test(
      'observed edits remove old eligibility and reject late publication and concurrent lost updates',
      async () => {
        const next = revision(sourceId, {
          documentId: original.documentId,
          nativeId: original.nativeId,
          expectedRevisionId: original.id,
        });
        const race = revision(sourceId, {
          documentId: original.documentId,
          nativeId: original.nativeId,
          expectedRevisionId: original.id,
        });
        const results = await Promise.allSettled([
          service.observeRevision(one.id, owner, next),
          service.observeRevision(one.id, owner, race),
        ]);
        assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
        await assert.rejects(service.readEvidence(one.id, owner, citation), code('superseded'));
        await assert.rejects(service.publishLexical(one.id, owner, build), code('superseded'));
        const current = (await service.status(one.id, owner, original.documentId)).revisionId === next.id ? next : race;
        const currentCitation = await service.publishLexical(one.id, owner, publication(current));
        const mismatch = revision(sourceId);
        await service.observeRevision(one.id, owner, mismatch);
        await assert.rejects(
          db.platform.query(`UPDATE ${table('documents')} SET lexical_publication_id=$1 WHERE id=$2`, [
            currentCitation.publicationId,
            mismatch.documentId,
          ]),
          error => error.code === '23503',
        );
      },
    );

    await t.test('local epoch invalidation, pause, removal and membership loss fail closed', async () => {
      const local = revision(await source());
      await service.observeRevision(one.id, owner, local);
      const ref = await service.publishLexical(one.id, owner, publication(local));
      await service.manageSource(one.id, owner, local.sourceId, 'pause');
      assert.equal((await service.readEvidence(one.id, owner, ref)).title, 'Private handbook');
      await assert.rejects(service.observeRevision(one.id, owner, revision(local.sourceId)), code('conflict'));
      await service.manageSource(one.id, owner, local.sourceId, 'resume');
      await service.manageSource(one.id, owner, local.sourceId, 'invalidate');
      await assert.rejects(service.readEvidence(one.id, owner, ref), AccessDenied);
      const fresh = { ...ref, accessEpoch: 2 };
      assert.equal((await service.readEvidence(one.id, owner, fresh)).text, 'Return orders in 30 days.');
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        owner.membershipId,
      ]);
      await assert.rejects(service.readEvidence(one.id, owner, fresh), AccessDenied);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
        owner.membershipId,
      ]);
      await service.manageSource(one.id, owner, local.sourceId, 'remove');
      await service.manageSource(one.id, owner, local.sourceId, 'remove');
      await assert.rejects(service.readEvidence(one.id, owner, fresh), AccessDenied);
      const retained = (
        await db.platform.query(
          `SELECT d.lexical_publication_id, d.retain_until>=d.tombstoned_at+interval '30 days' AS held, r.title FROM ${table('documents')} d JOIN ${table('revisions')} r ON r.document_id=d.id WHERE d.id=$1`,
          [local.documentId],
        )
      ).rows[0];
      assert.deepEqual(retained, { lexical_publication_id: null, held: true, title: 'Private handbook' });
    });

    await t.test(
      'external proofs use both authoritative clocks and cannot survive invalidation or disconnect',
      async () => {
        let connected = true;
        let observation;
        const external = createKnowledge({
          runtime,
          requireExternalSource: async () => {
            if (!connected) throw new AccessDenied();
          },
          refreshExternalProof: async context => {
            assert.equal(context.nativeId, item.nativeId);
            return observation;
          },
        });
        const item = revision(await source('github', external));
        const recommendationEvents = async () =>
          (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_recommendation_events')}`)).rows[0]
            .count;
        const initialEvents = await recommendationEvents();
        await assert.rejects(service.observeRevision(one.id, owner, item), code('adapter-required'));
        await external.observeRevision(one.id, owner, item);
        await assert.rejects(external.publishLexical(one.id, owner, publication(item)), code('permission-expired'));
        const now = Date.now() - 1000;
        const proof = {
          id: randomUUID(),
          documentId: item.documentId,
          accessEpoch: 1,
          principal: 'github:user:123',
          aclVersion: 'acl-1',
          membershipVersion: 'org-1',
          aclCheckedAt: new Date(now),
          membershipCheckedAt: new Date(now - 1000),
          expiresAt: new Date(now + 298000),
        };
        const request = { documentId: item.documentId, accessEpoch: 1 };
        observation = { ...proof, expiresAt: new Date(now + 300001) };
        await assert.rejects(external.recordAccessProof(one.id, owner, request));
        await assert.rejects(external.recordAccessProof(one.id, owner, proof));
        observation = proof;
        await external.recordAccessProof(one.id, owner, request);
        const ref = await external.publishLexical(one.id, owner, publication(item));
        assert.equal(
          await recommendationEvents(),
          initialEvents,
          'routine provider observation, proof refresh and publication do not enqueue recommendations',
        );
        assert.equal((await external.readEvidence(one.id, owner, ref)).text, 'Return orders in 30 days.');
        await db.platform.query(
          `UPDATE ${table('access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '2 minutes' WHERE document_id=$1`,
          [item.documentId],
        );
        await assert.rejects(external.readEvidence(one.id, owner, ref), code('permission-expired'));
        observation = { ...proof, id: randomUUID() };
        await external.recordAccessProof(one.id, owner, request);
        connected = false;
        await assert.rejects(external.readEvidence(one.id, owner, ref), AccessDenied);
        connected = true;
        await external.manageSource(one.id, owner, item.sourceId, 'invalidate');
        await assert.rejects(external.recordAccessProof(one.id, owner, request), AccessDenied);
        await assert.rejects(
          external.readEvidence(one.id, owner, { ...ref, accessEpoch: 2 }),
          code('permission-expired'),
        );
        await external.manageSource(one.id, owner, item.sourceId, 'disconnect');
        await assert.rejects(external.readEvidence(one.id, owner, ref), AccessDenied);
      },
    );

    await t.test('Files lineage grants remain authoritative without admin bypass', async () => {
      const folder = randomUUID(),
        fileId = randomUUID(),
        objectKey = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_files')} (id,kind,creator_membership_id,name,ready) VALUES ($1,'folder',$2,'Private',true)`,
        [folder, owner.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready,object_key,media_type,size,sha256) VALUES ($1,'file',$2,$3,'Handbook',true,$4,'text/plain',8,$5)`,
        [fileId, owner.membershipId, folder, objectKey, digest('original')],
      );
      const item = revision(await source('file'), {
        original: { kind: 'file', fileId, sha256: digest('original'), bytes: 8 },
      });
      await service.observeRevision(one.id, owner, item);
      const ref = await service.publishLexical(one.id, owner, publication(item));
      await assert.rejects(service.readEvidence(one.id, other, ref), AccessDenied);
      await db.platform.query(`UPDATE ${table('tf_files')} SET trashed_at=clock_timestamp() WHERE id=$1`, [folder]);
      await assert.rejects(service.readEvidence(one.id, owner, ref), AccessDenied);
    });

    await t.test('authoritative denial invalidates prior proofs while outages do not renew them', async () => {
      let result;
      const api = createKnowledge({
        runtime,
        requireExternalSource: async () => {},
        refreshExternalProof: async context => {
          if (result) throw result;
          const now = Date.now() - 1000;
          return {
            id: randomUUID(),
            documentId: context.documentId,
            accessEpoch: context.accessEpoch,
            principal: 'user:1',
            aclVersion: '1',
            membershipVersion: '1',
            aclCheckedAt: new Date(now),
            membershipCheckedAt: new Date(now),
            expiresAt: new Date(now + 300000),
          };
        },
      });
      const item = revision(await source('github', api));
      await api.observeRevision(one.id, owner, item);
      const request = { documentId: item.documentId, accessEpoch: 1 };
      await api.recordAccessProof(one.id, owner, request);
      const ref = await api.publishLexical(one.id, owner, publication(item));
      const before = (
        await db.platform.query(`SELECT expires_at FROM ${table('access_proofs')} WHERE document_id=$1`, [
          item.documentId,
        ])
      ).rows[0];
      result = new SourceAuthorizationUnavailable();
      await assert.rejects(api.recordAccessProof(one.id, owner, request), SourceAuthorizationUnavailable);
      assert.deepEqual(
        (
          await db.platform.query(`SELECT expires_at FROM ${table('access_proofs')} WHERE document_id=$1`, [
            item.documentId,
          ])
        ).rows[0],
        before,
      );
      assert.equal((await api.readEvidence(one.id, owner, ref)).text, 'Return orders in 30 days.');
      result = new AccessDenied();
      await assert.rejects(api.recordAccessProof(one.id, owner, request), AccessDenied);
      await assert.rejects(api.readEvidence(one.id, owner, ref), AccessDenied);
    });

    await t.test(
      'refresh in flight cannot resurrect invalidated access and releases the database transaction',
      async () => {
        let start, finish;
        const started = new Promise(resolve => {
          start = resolve;
        });
        const waiting = new Promise(resolve => {
          finish = resolve;
        });
        const api = createKnowledge({
          runtime,
          requireExternalSource: async () => {},
          refreshExternalProof: async context => {
            start();
            await waiting;
            const now = Date.now() - 1000;
            return {
              id: randomUUID(),
              documentId: context.documentId,
              accessEpoch: context.accessEpoch,
              principal: 'user:1',
              aclVersion: '1',
              membershipVersion: '1',
              aclCheckedAt: new Date(now),
              membershipCheckedAt: new Date(now),
              expiresAt: new Date(now + 300000),
            };
          },
        });
        const item = revision(await source('github', api));
        await api.observeRevision(one.id, owner, item);
        const refresh = api.recordAccessProof(one.id, owner, { documentId: item.documentId, accessEpoch: 1 });
        await started;
        assert.equal(runtime.stats().activeTransactions, 0);
        await api.manageSource(one.id, owner, item.sourceId, 'invalidate');
        finish();
        await assert.rejects(refresh, AccessDenied);
        assert.equal(
          (await db.platform.query(`SELECT * FROM ${table('access_proofs')} WHERE document_id=$1`, [item.documentId]))
            .rowCount,
          0,
        );
      },
    );

    await t.test('status and dependency batches reject proofs that expire during awaited reads', async t => {
      let queryHook;
      let delayed = false;
      const hooked = {
        transaction: (id, compatibility, operation) =>
          runtime.transaction(id, compatibility, tx =>
            operation({
              ...tx,
              client: {
                query: async (...args) => {
                  const result = await tx.client.query(...args);
                  if (queryHook) await queryHook(args[0], args[1], tx);
                  return result;
                },
              },
            }),
          ),
      };
      let observation;
      const api = createKnowledge({
        runtime: hooked,
        requireExternalSource: async () => {},
        refreshExternalProof: async () => observation,
      });
      async function published(lifetime) {
        const item = revision(await source('github', api));
        await api.observeRevision(one.id, owner, item);
        const now = (await db.platform.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
        observation = {
          id: randomUUID(),
          documentId: item.documentId,
          accessEpoch: 1,
          principal: 'provider:user',
          aclVersion: '1',
          membershipVersion: '1',
          aclCheckedAt: new Date(now + lifetime - 300000),
          membershipCheckedAt: new Date(now + lifetime - 300000),
          expiresAt: new Date(now + lifetime),
        };
        await api.recordAccessProof(one.id, owner, { documentId: item.documentId, accessEpoch: 1 });
        return { item, citation: await api.publishLexical(one.id, owner, publication(item)) };
      }
      async function waitForExpiry(tx, documentId) {
        delayed = true;
        await tx.client.query(
          `SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp()))+0.2) FROM ${table('access_proofs')} WHERE document_id=$1`,
          [documentId],
        );
      }
      await t.test('status checks expiry after its work read before returning metadata', async () => {
        const { item } = await published(5000);
        assert.equal((await api.status(one.id, owner, item.documentId)).parsing, 'ready');
        delayed = false;
        queryHook = async (sql, _args, tx) => {
          if (sql.startsWith(`SELECT * FROM ${table('work')}`)) await waitForExpiry(tx, item.documentId);
        };
        try {
          await assert.rejects(api.status(one.id, owner, item.documentId), code('permission-expired'));
        } finally {
          queryHook = null;
        }
        assert.equal(delayed, true);
      });
      await t.test('batch checks every proof at one final cutoff after later document reads', async () => {
        const first = await published(5000),
          second = await published(20000);
        await api.validateDependencies(one.id, owner, [first.citation, second.citation]);
        delayed = false;
        queryHook = async (sql, args, tx) => {
          if (sql.startsWith(`SELECT * FROM ${table('documents')}`) && args[0] === second.item.documentId)
            await waitForExpiry(tx, first.item.documentId);
        };
        try {
          await assert.rejects(
            api.validateDependencies(one.id, owner, [first.citation, second.citation]),
            code('permission-expired'),
          );
        } finally {
          queryHook = null;
        }
        assert.equal(delayed, true);
      });
    });

    await t.test(
      'oversized input, revision retention cap, OCR and retry limits reject without partial publication',
      async () => {
        const item = revision(await source());
        await assert.rejects(
          service.observeRevision(one.id, owner, { ...item, original: { ...item.original, bytes: 10485761 } }),
        );
        await service.observeRevision(one.id, owner, item);
        await assert.rejects(service.publishLexical(one.id, owner, publication(item, { pages: 501 })));
        await service.recordFailure(one.id, owner, {
          documentId: item.documentId,
          revisionId: item.id,
          axis: 'parsing',
          failure: 'ocr-required',
        });
        await service.recordFailure(one.id, owner, {
          documentId: item.documentId,
          revisionId: item.id,
          axis: 'parsing',
          failure: 'provider',
        });
        await assert.rejects(service.publishLexical(one.id, owner, publication(item)), code('incomplete'));
        assert.equal((await service.status(one.id, owner, item.documentId)).publicationId, null);
        for (let attempt = 2; attempt < 8; attempt++)
          await service.recordFailure(one.id, owner, {
            documentId: item.documentId,
            revisionId: item.id,
            axis: 'embedding',
            failure: 'provider',
          });
        await assert.rejects(
          service.recordFailure(one.id, owner, {
            documentId: item.documentId,
            revisionId: item.id,
            axis: 'embedding',
            failure: 'provider',
          }),
          code('quota'),
        );
        const base = revision(await source());
        await service.observeRevision(one.id, owner, base);
        let prior = base;
        for (let index = 1; index < 32; index++) {
          const next = revision(base.sourceId, {
            documentId: base.documentId,
            nativeId: base.nativeId,
            expectedRevisionId: prior.id,
          });
          await service.observeRevision(one.id, owner, next);
          prior = next;
        }
        await assert.rejects(
          service.observeRevision(
            one.id,
            owner,
            revision(base.sourceId, {
              documentId: base.documentId,
              nativeId: base.nativeId,
              expectedRevisionId: prior.id,
            }),
          ),
          code('quota'),
        );
        assert.equal((await service.status(one.id, owner, base.documentId)).revisionId, prior.id);
      },
    );
  } finally {
    await runtime?.close();
    await db.close();
  }
});
