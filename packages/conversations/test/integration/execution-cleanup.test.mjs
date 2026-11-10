import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  commitManifest,
  createExecutionCleanup,
  enqueueIntent,
  ensureArea,
  executionChunkBytes,
  finishUpload,
  lockExecutionStorage,
  nextJobGeneration,
  readObject,
  reserveAllocation,
  reserveUpload,
  transitionAllocation,
  writeExecutionObject,
} from '@tulipfarm/execution';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { conversationFixture } from '../fixture.mjs';

test(
  'execution cleanup persists bounded progress independently of the worker instance',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture();
    let fresh;
    try {
      const w = f.workspace;
      const tx = operation => f.runtime.transaction(w.id, commonCompatibility, operation);
      const chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const area = await tx(t =>
        ensureArea(t, chatId, {
          profile: {
            id: 'small',
            resources: { kind: 'limited', cpuMillis: 500, memoryMiB: 1024, diskBytes: 67108864 },
          },
          policyRevision: 'a'.repeat(64),
          scopeRevision: 'b'.repeat(64),
          baseRevision: 'c'.repeat(64),
        }),
      );
      const limits = {
        fileBytes: 4 * executionChunkBytes,
        workspaceStorageBytes: 16 * executionChunkBytes,
        fileCount: 32,
        jobTimeoutSeconds: 30,
      };
      const data = new Map(),
        retired = [];
      let afterRetire;
      const objects = {
        async putIfAbsent(key, bytes) {
          if (!data.has(key)) data.set(key, Buffer.from(bytes));
        },
        async read(key, expected) {
          const body = data.get(key);
          assert.equal(body?.length, expected);
          return body;
        },
        async retireExecutionChunk(key) {
          data.set(key, Buffer.alloc(0));
          retired.push(key);
          await afterRetire?.();
        },
      };
      const operation = { leaseSeconds: 60, signal: new AbortController().signal };
      async function upload(content, path, owner = area) {
        const file = {
          path,
          size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          executable: false,
        };
        const saved = await tx(async t => {
          await lockExecutionStorage(t);
          return reserveUpload(t, owner, file, [], limits);
        });
        const ref = {
          workspaceId: w.id,
          areaId: owner.id,
          objectId: saved.objectId,
          size: file.size,
          sha256: file.sha256,
        };
        const chunks = await writeExecutionObject(
          objects,
          ref,
          (async function* () {
            yield content;
          })(),
          operation.signal,
        );
        await tx(t => finishUpload(t, owner, saved.objectId, chunks));
        return saved;
      }
      async function due(objectId) {
        await f.db.platform.query(
          `UPDATE ${f.table('tf_execution_objects')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [objectId],
        );
        await f.db.platform.query(
          `UPDATE ${f.table('tf_execution_outbox')} SET available_at=clock_timestamp()-interval '1 second' WHERE object_id=$1`,
          [objectId],
        );
      }

      await t.test(
        'a fresh worker resumes one chunk at a time and expired claims cannot advance or finish',
        async () => {
          await tx(t => enqueueIntent(t, area, 'start', 'untouched-start'));
          const file = await upload(Buffer.alloc(2 * executionChunkBytes + 17, 7), 'progress.bin');
          await due(file.objectId);
          const cleanup = createExecutionCleanup(f.runtime, objects);
          assert.equal(await cleanup.process(w.id, operation), 'pending');
          assert.equal((await tx(t => readObject(t, area.id, file.objectId))).retired_chunks, 1);
          assert.equal(retired.length, 1);
          const start = await f.db.platform.query(
            `SELECT attempts,lease_id FROM ${f.table('tf_execution_outbox')} WHERE dedupe_key='untouched-start'`,
          );
          assert.deepEqual(start.rows[0], { attempts: 0, lease_id: null });
          fresh = f.createRuntime();
          const restarted = createExecutionCleanup(fresh, objects);
          await due(file.objectId);
          afterRetire = async () => {
            afterRetire = undefined;
            await tx(async t => {
              await t.client.query("SET LOCAL lock_timeout='2s'");
              await t.client.query(`SELECT id FROM ${f.table('tf_execution_areas')} WHERE id=$1 FOR UPDATE`, [area.id]);
              await t.client.query(
                `UPDATE ${f.table('tf_execution_outbox')} SET lease_until=clock_timestamp()-interval '1 second' WHERE object_id=$1`,
                [file.objectId],
              );
            });
          };
          await assert.rejects(restarted.process(w.id, operation), /stale/);
          assert.equal((await tx(t => readObject(t, area.id, file.objectId))).retired_chunks, 1);
          assert.equal(retired.length, 2);
          assert.equal(await restarted.process(w.id, operation), 'pending');
          assert.equal((await tx(t => readObject(t, area.id, file.objectId))).retired_chunks, 2);
          await due(file.objectId);
          assert.equal(await restarted.process(w.id, operation), 'deleted');
          const finished = await tx(t => readObject(t, area.id, file.objectId));
          assert.equal(finished.retired_chunks, 3);
          assert.equal(finished.state, 'deleted');
          assert.deepEqual(
            retired.map(key => Number(key.split('/').at(-1))),
            [0, 1, 1, 2],
          );
          assert.equal(
            [...data.values()].reduce((sum, bytes) => sum + bytes.length, 0),
            0,
          );
        },
      );

      await t.test(
        'current saves stay protected while removed files survive neither replacement nor area deletion',
        async () => {
          const cleanup = createExecutionCleanup(f.runtime, objects);
          const kept = await upload(Buffer.from('keep this current save'), 'kept.txt');
          const manifest = await tx(async t => {
            await lockExecutionStorage(t);
            return commitManifest(t, area, null, [kept], limits);
          });
          await due(kept.objectId);
          const count = retired.length;
          assert.equal(await cleanup.process(w.id, operation), 'retained');
          assert.equal(retired.length, count);
          assert.equal((await tx(t => readObject(t, area.id, kept.objectId))).state, 'ready');
          const empty = await upload(Buffer.alloc(0), 'empty.txt');
          await due(empty.objectId);
          assert.equal(await cleanup.process(w.id, operation), 'deleted');
          assert.equal(retired.length, count);
          let allocation = await tx(t =>
            reserveAllocation(t, area, randomUUID(), new Date(Date.now() + 60000).toISOString()),
          );
          allocation = await tx(t => transitionAllocation(t, allocation, 'stopping'));
          await tx(t => transitionAllocation(t, allocation, 'stopped'));
          const advanced = await tx(t => nextJobGeneration(t, area));
          assert.equal(advanced.generation, 2);
          await tx(async t => {
            await lockExecutionStorage(t);
            await commitManifest(t, advanced, manifest.id, [], limits);
          });
          assert.equal(await cleanup.process(w.id, operation), 'deleted');
          const removed = await tx(t => readObject(t, area.id, kept.objectId));
          assert.equal(removed.state, 'deleted');
          assert.equal(removed.generation, 1);
          const deleting = await upload(Buffer.from('delete with area'), 'area.txt', advanced);
          await f.db.platform.query(`UPDATE ${f.table('tf_execution_areas')} SET state='deleting' WHERE id=$1`, [
            area.id,
          ]);
          await f.db.platform.query(
            `UPDATE ${f.table('tf_execution_outbox')} SET available_at=clock_timestamp()-interval '1 second' WHERE object_id=$1`,
            [deleting.objectId],
          );
          assert.equal(await cleanup.process(w.id, operation), 'deleted');
          assert.equal((await tx(t => readObject(t, area.id, deleting.objectId))).state, 'deleted');
          assert.equal(await cleanup.process(w.id, operation), 'idle');
        },
      );
    } finally {
      await fresh?.close();
      await f.close();
    }
  },
);
