import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  recordRecommendationChange,
  recommendationCompatibility,
  scheduleRecommendationExpiry,
} from '@tulipfarm/workspace-storage/recommendations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createRecommendationWork } from '../src/work.ts';
import { createPersonalMemoryService } from '../../conversations/src/personal-memory.ts';

test(
  'durable member claims fence late output, retain pending events and stop terminal retries',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      const w = await db.create();
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        connectionsPerPool: 3,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const work = createRecommendationWork(runtime);
      const table = name => qualified(w.names.schema, name);
      const tx = operation => runtime.transaction(w.id, recommendationCompatibility, operation);
      const event = () =>
        tx(transaction =>
          recordRecommendationChange(transaction, {
            id: randomUUID(),
            kind: 'memory',
            sourceId: w.membershipId,
            membershipIds: [w.membershipId],
            invalidate: true,
          }),
        );
      const due = () =>
        db.platform.query(
          `UPDATE ${table('tf_recommendation_refresh')} SET due_at=clock_timestamp()-interval '1 second'`,
        );
      const snapshot = {
        fingerprint: 'a'.repeat(64),
        onboarding: false,
        sources: [],
        items: Array.from({ length: 5 }, (_, i) => ({
          id: `prompt-${i}`,
          kind: 'prompt',
          label: 'Fixture',
          brands: [],
          action: { kind: 'prompt', prompt: `Fixture ${i}` },
        })),
      };
      await event();
      assert.deepEqual(await work.pending(w.id), []);
      assert.equal(await work.claim(w.id, w.membershipId), null);
      await due();
      const claims = await Promise.all(Array.from({ length: 6 }, () => work.claim(w.id, w.membershipId)));
      assert.equal(new Set(claims.map(claim => claim.attemptId)).size, 1);
      const claim = claims[0];
      assert.equal(claim.generation, 1);
      await event();
      assert.equal(await work.publish(w.id, claim, snapshot), 'superseded');
      assert.equal((await db.platform.query(`SELECT * FROM ${table('tf_recommendation_snapshots')}`)).rowCount, 0);
      assert.equal(await work.claim(w.id, w.membershipId), null, 'next event retains its own window');
      await due();
      const next = await work.claim(w.id, w.membershipId);
      assert.equal(next.generation, 2);
      assert.notEqual(next.attemptId, claim.attemptId);
      assert.equal(await work.publish(w.id, next, snapshot), 'published');
      assert.equal(await work.publish(w.id, claim, snapshot), 'superseded');
      assert.equal(
        (await db.platform.query(`SELECT generation FROM ${table('tf_recommendation_snapshots')}`)).rows[0].generation,
        '2',
      );
      await event();
      await due();
      const failure = await work.claim(w.id, w.membershipId);
      await work.fail(w.id, failure, 'budget-paused', 'workspace-cap');
      assert.deepEqual(await work.pending(w.id), []);
      assert.equal(await work.claim(w.id, w.membershipId), null);
      assert.equal(
        (await db.platform.query(`SELECT status FROM ${table('tf_recommendation_refresh')}`)).rows[0].status,
        'budget-paused',
      );

      const memory = createPersonalMemoryService(runtime);
      await memory.save(w.id, w.userId, { content: 'Private fixture', expectedRevision: 0 });
      const count = async () =>
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_recommendation_events')}`)).rows[0]
          .count;
      const before = await count();
      await memory.read(w.id, w.userId);
      await memory.save(w.id, w.userId, { content: 'Private fixture', expectedRevision: 1 });
      assert.equal(await count(), before, 'reads and identical saved memory do not enqueue');
      await due();
      const privateClaim = await work.claim(w.id, w.membershipId);
      assert.equal(await work.saveOutput(w.id, privateClaim, snapshot), true);
      assert.deepEqual(await work.output(w.id, privateClaim), snapshot);
      await memory.delete(w.id, w.userId, { expectedRevision: 2 });
      assert.equal(await count(), before + 1);
      assert.equal(
        (await db.platform.query(`SELECT * FROM ${table('tf_recommendation_snapshots')}`)).rowCount,
        0,
        'deleting private input removes output in the same transaction',
      );
      assert.equal(
        await work.output(w.id, privateClaim),
        undefined,
        'deleted memory cannot recover an old private output receipt',
      );
      assert.equal((await db.platform.query(`SELECT * FROM ${table('tf_recommendation_results')}`)).rowCount, 0);
      assert.equal(await work.publish(w.id, privateClaim, snapshot), 'superseded');

      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (const [index, id] of ids.entries()) {
        const expiry = new Date(Date.now() - 1000);
        await db.platform.query(
          `INSERT INTO ${table('tf_invitations')}(id,issuer_membership_id,kind,email,token_hash,expires_at,revoked_at,consumed_membership_id)
        VALUES($1,$2::uuid,'email',$3,$4,$5,CASE WHEN $6::int=1 THEN clock_timestamp() ELSE NULL END,CASE WHEN $6::int=2 THEN $2::uuid ELSE NULL END)`,
          [
            id,
            w.membershipId,
            `fixture-${index}@example.test`,
            createHash('sha256').update(id).digest('hex'),
            expiry,
            index,
          ],
        );
        await tx(transaction => scheduleRecommendationExpiry(transaction, id, expiry));
      }
      const previous = await count();
      assert.equal(await work.expireInvitations(w.id), 3);
      assert.equal(await count(), previous + 1, 'only a still-pending invitation emits expiry');
      assert.equal(await work.expireInvitations(w.id), 0);
      assert.equal(await count(), previous + 1, 'expiry is delivered only once');

      const retained = { id: randomUUID(), kind: 'repair', sourceId: w.membershipId, membershipIds: [w.membershipId] };
      await tx(transaction => recordRecommendationChange(transaction, retained));
      await db.platform.query(
        `UPDATE ${table('tf_recommendation_events')} SET created_at=clock_timestamp()-interval '8 days' WHERE id=$1`,
        [retained.id],
      );
      assert.equal(await work.compactEvents(w.id), 1);
      assert.deepEqual(
        (
          await db.platform.query(`SELECT membership_ids FROM ${table('tf_recommendation_events')} WHERE id=$1`, [
            retained.id,
          ])
        ).rows[0].membership_ids,
        [],
      );
      assert.equal(
        (await tx(transaction => recordRecommendationChange(transaction, retained))).recorded,
        false,
        'compacted receipts still reject duplicate work',
      );
      await assert.rejects(
        tx(transaction => recordRecommendationChange(transaction, { ...retained, membershipIds: [] })),
        /conflict/,
      );
      assert.equal(await work.compactEvents(w.id), 0);
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
