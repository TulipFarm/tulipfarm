import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolveHuman } from '@tulipfarm/access';
import { createFiles } from '@tulipfarm/files';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createLocalKnowledge } from '../../knowledge/dist/index.js';
import {
  collectRecommendationContext,
  combineRecommendations,
  fallbackRecommendations,
  readSavedRecommendations,
  validateGeneratedRecommendations,
} from '../dist/index.js';
import { createRecommendationWork } from '../src/work.ts';

for (const kind of ['note', 'file'])
  test(
    `${kind} title replacement clears private recommendations before parsing without generating work`,
    { timeout: 60000 },
    async () => {
      const f = await conversationFixture();
      try {
        const w = f.workspace;
        const unrelated = { membershipId: randomUUID(), userId: randomUUID() };
        await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
          unrelated.membershipId,
          unrelated.userId,
        ]);
        const objects = new Map();
        const files = createFiles(f.runtime, {
          putIfAbsent: async (key, bytes) => {
            objects.set(key, Buffer.from(bytes));
          },
          read: async key => Buffer.from(objects.get(key)),
          remove: async key => {
            objects.delete(key);
          },
        });
        const knowledge = createLocalKnowledge({ runtime: f.runtime, files });
        const work = createRecommendationWork(f.runtime);
        const collect = person =>
          f.runtime.transaction(w.id, commonCompatibility, async tx =>
            collectRecommendationContext(tx, await resolveHuman(tx, person.userId)),
          );
        const saved = person =>
          f.runtime.transaction(w.id, commonCompatibility, tx => readSavedRecommendations(tx, person.membershipId));
        const refresh = async person =>
          (
            await f.db.platform.query(`SELECT * FROM ${f.table('tf_recommendation_refresh')} WHERE membership_id=$1`, [
              person.membershipId,
            ])
          ).rows[0];
        const claim = async person => {
          await f.db.platform.query(
            `UPDATE ${f.table('tf_recommendation_refresh')} SET due_at=clock_timestamp()-interval '1 second' WHERE membership_id=$1`,
            [person.membershipId],
          );
          const result = await work.claim(w.id, person.membershipId);
          assert.ok(result);
          return result;
        };
        const publishKnowledge = async revisionId => {
          const item = (await knowledge.due(w.id)).find(row => row.revisionId === revisionId);
          assert.ok(item);
          await knowledge.acknowledge(item);
          assert.equal((await knowledge.process(item)).disposition, 'ready');
          return item;
        };
        const addNote = async (person, title) => {
          const input = {
            documentId: randomUUID(),
            commandId: randomUUID(),
            expectedRevisionId: null,
            title,
            input: { kind: 'note', text: 'Plan the week.' },
          };
          await knowledge.save(w.id, person.userId, input);
          await publishKnowledge(input.commandId);
          return input;
        };
        const output = async (person, documentId) => {
          const context = await collect(person);
          const entry = context.context.entries.find(row => row.id === documentId);
          assert.ok(entry);
          assert.ok(context.sources.some(source => source.kind === 'knowledge' && source.id === documentId));
          const generated = validateGeneratedRecommendations(
            JSON.stringify([
              {
                id: 'review-private-knowledge',
                kind: 'prompt',
                label: `Review ${entry.label}`,
                brands: [],
                action: { kind: 'prompt', prompt: `Review ${entry.label}` },
                sources: [entry.key],
              },
            ]),
            context.context,
          );
          return {
            ...combineRecommendations(context.signals, generated),
            fingerprint: context.fingerprint,
            sources: context.sources,
          };
        };
        const events = async () =>
          (
            await f.db.platform.query(
              `SELECT id,kind,source_id,membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} ORDER BY created_at,id`,
            )
          ).rows;
        const secret = 'CONFIDENTIAL-CUSTOMER-ORCHID-PRICE-975';
        const bodyOnly = 'BODY-ONLY-NOT-EXPOSED-241';
        const fileId = randomUUID();
        if (kind === 'file')
          await files.upload(
            w.id,
            w.userId,
            fileId,
            { name: 'Process.md', parentId: null, mediaType: 'text/markdown' },
            Buffer.from(bodyOnly),
          );
        const original = {
          documentId: randomUUID(),
          commandId: randomUUID(),
          expectedRevisionId: null,
          title: secret,
          input: kind === 'note' ? { kind, text: bodyOnly } : { kind, fileId },
        };
        await knowledge.save(w.id, w.userId, original);
        await publishKnowledge(original.commandId);
        const firstOutput = await output(w, original.documentId);
        assert.match(JSON.stringify(firstOutput.items), new RegExp(secret));
        assert.doesNotMatch(JSON.stringify((await collect(w)).context), new RegExp(bodyOnly));
        assert.equal(await work.publish(w.id, await claim(w), firstOutput), 'published');
        const savedOriginal = await saved(w);
        const refreshOriginal = await refresh(w);
        const originalEvents = await events();
        assert.equal((await knowledge.save(w.id, w.userId, original)).parsing, 'ready');
        assert.deepEqual(await saved(w), savedOriginal, 'an identical save receipt must preserve safe output');
        assert.deepEqual(await refresh(w), refreshOriginal);
        assert.deepEqual(await events(), originalEvents);

        const unrelatedNote = await addNote(unrelated, 'Unrelated private roadmap');
        const unrelatedOutput = await output(unrelated, unrelatedNote.documentId);
        assert.equal(await work.publish(w.id, await claim(unrelated), unrelatedOutput), 'published');
        await addNote(unrelated, 'Unrelated schedule');
        const unrelatedFlight = await claim(unrelated);
        const unrelatedTransient = await output(unrelated, unrelatedNote.documentId);
        assert.equal(await work.saveOutput(w.id, unrelatedFlight, unrelatedTransient), true);
        const unrelatedSaved = await saved(unrelated);
        const unrelatedRefresh = await refresh(unrelated);

        await addNote(w, 'General schedule');
        const inflight = await claim(w);
        const inflightOutput = await output(w, original.documentId);
        assert.equal(await work.trackSources(w.id, inflight, inflightOutput.sources), true);
        assert.equal(await work.saveOutput(w.id, inflight, inflightOutput), true);
        assert.match(JSON.stringify(await work.output(w.id, inflight)), new RegExp(secret));
        assert.match(JSON.stringify(await saved(w)), new RegExp(secret));
        assert.equal(
          (
            await f.db.platform.query(
              `SELECT 1 FROM ${f.table('tf_recommendation_dependencies')} WHERE membership_id=$1 AND source_id=$2`,
              [w.membershipId, original.documentId],
            )
          ).rowCount,
          1,
        );
        const beforeReplacement = await events();
        const replacement = {
          ...original,
          commandId: randomUUID(),
          expectedRevisionId: original.commandId,
          title: 'Public process',
          input: kind === 'note' ? { kind, text: 'No private customer details.' } : original.input,
        };
        const changed = await knowledge.save(w.id, w.userId, replacement);
        assert.equal(changed.parsing, 'queued');
        assert.equal(changed.publicationId, null);
        assert.deepEqual(await events(), beforeReplacement, 'replacement does not enqueue before usable publication');
        assert.equal(
          (await collect(w)).context.entries.some(row => row.id === original.documentId),
          false,
        );
        const afterRemoval = await saved(w);
        assert.equal(afterRemoval.status, 'unavailable');
        assert.deepEqual(afterRemoval.items, fallbackRecommendations);
        assert.equal(await work.output(w.id, inflight), undefined);
        for (const table of [
          'tf_recommendation_snapshots',
          'tf_recommendation_results',
          'tf_recommendation_dependencies',
        ]) {
          assert.equal(
            (await f.db.platform.query(`SELECT 1 FROM ${f.table(table)} WHERE membership_id=$1`, [w.membershipId]))
              .rowCount,
            0,
            `${table} must be cleared in the replacement transaction`,
          );
        }
        const invalidated = await refresh(w);
        assert.equal(Number(invalidated.generation), inflight.generation + 1);
        assert.equal(invalidated.due_at, null);
        assert.equal(invalidated.claimed_generation, null);
        assert.equal(invalidated.attempt_id, null);
        assert.equal(await work.claim(w.id, w.membershipId), null);
        assert.equal(
          (await work.pending(w.id)).some(row => row.membershipId === w.membershipId),
          false,
        );
        assert.equal(await work.saveOutput(w.id, inflight, inflightOutput), false);
        assert.equal(await work.publish(w.id, inflight, inflightOutput), 'superseded');
        assert.equal((await knowledge.save(w.id, w.userId, replacement)).parsing, 'queued');
        assert.deepEqual(await refresh(w), invalidated, 'a replay cannot invalidate twice or queue generation');
        assert.deepEqual(await events(), beforeReplacement);
        assert.deepEqual(await saved(unrelated), unrelatedSaved);
        assert.deepEqual(await refresh(unrelated), unrelatedRefresh);
        assert.deepEqual(await work.output(w.id, unrelatedFlight), unrelatedTransient);

        const replacementWork = await publishKnowledge(replacement.commandId);
        const afterPublication = await events();
        const addedEvents = afterPublication.filter(event => !beforeReplacement.some(prior => prior.id === event.id));
        assert.equal(addedEvents.length, 1);
        assert.deepEqual(
          addedEvents.map(({ id: _id, ...event }) => event),
          [
            {
              kind: 'knowledge',
              source_id: original.documentId,
              membership_ids: [w.membershipId],
              invalidate: false,
            },
          ],
        );
        assert.doesNotMatch(JSON.stringify(await saved(w)), new RegExp(secret));
        assert.equal((await saved(w)).status, 'pending');
        const publishedRefresh = await refresh(w);
        assert.ok(publishedRefresh.due_at);
        assert.equal((await knowledge.process(replacementWork)).disposition, 'ready');
        assert.equal((await knowledge.save(w.id, w.userId, replacement)).parsing, 'ready');
        assert.deepEqual(await events(), afterPublication, 'publication and save replays emit no duplicate event');
        assert.deepEqual(await refresh(w), publishedRefresh);
        const current = await collect(w);
        assert.equal(current.context.entries.find(row => row.id === original.documentId).label, 'Public process');
        assert.doesNotMatch(JSON.stringify(current.context), new RegExp(secret));
        const nextClaim = await claim(w);
        assert.equal(await work.publish(w.id, nextClaim, await output(w, original.documentId)), 'published');
        assert.doesNotMatch(JSON.stringify(await saved(w)), new RegExp(secret));
        assert.deepEqual(await saved(unrelated), unrelatedSaved);
        assert.deepEqual(await refresh(unrelated), unrelatedRefresh);
        assert.deepEqual(await work.output(w.id, unrelatedFlight), unrelatedTransient);
      } finally {
        await f.close();
      }
    },
  );
