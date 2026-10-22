import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFiles } from '@tulipfarm/files';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createObjectCleanupSweep } from '../dist/table-cleanup.js';

test(
  'the worker object cleanup sweep finishes Files deletions that failed during the request',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    const { workspace: w } = f;
    const objects = new Map();
    let storeDown = true;
    const bytes = {
      putIfAbsent: async (key, body) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(body));
      },
      read: async key => Buffer.from(objects.get(key)),
      remove: async key => {
        if (storeDown) throw new Error('object store refused');
        objects.delete(key);
      },
    };
    const priorRegistry = process.env.WORKSPACE_AUTHORING_DATABASE_URL;
    let sweep;
    try {
      const files = createFiles(f.runtime, bytes);
      const ids = [randomUUID(), randomUUID()];
      for (const [index, id] of ids.entries()) {
        await files.upload(
          w.id,
          w.userId,
          id,
          { name: `Old ${index}.txt`, parentId: null, mediaType: 'text/plain' },
          Buffer.from(`old contents ${index}`),
        );
        await files.trash(w.id, w.userId, id, true);
        assert.deepEqual(await files.deleteForever(w.id, w.userId, id), { id, state: 'failed' });
      }
      const remaining = async () =>
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS n FROM ${f.table('tf_files')} WHERE id = ANY($1::uuid[])`,
            [ids],
          )
        ).rows[0].n;
      assert.equal(await remaining(), 2);
      assert.equal(objects.size, 2);

      await markWorkspaceReady(f.db.platform, w.id);
      process.env.WORKSPACE_AUTHORING_DATABASE_URL = f.db.connectionString;
      sweep = createObjectCleanupSweep(f.runtime, bytes);
      await assert.rejects(
        sweep.sweep(),
        /object-cleanup-retry/,
        'a store outage leaves the deletions for the next sweep',
      );
      assert.equal(await remaining(), 2);

      storeDown = false;
      await sweep.sweep();
      assert.equal(await remaining(), 0);
      assert.equal(objects.size, 0);
      assert.equal((await files.usage(w.id, w.userId)).usedBytes, 0);
    } finally {
      if (priorRegistry === undefined) delete process.env.WORKSPACE_AUTHORING_DATABASE_URL;
      else process.env.WORKSPACE_AUTHORING_DATABASE_URL = priorRegistry;
      await sweep?.close();
      await f.close();
    }
  },
);
