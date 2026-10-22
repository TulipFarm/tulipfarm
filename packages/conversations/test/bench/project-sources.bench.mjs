/**
 * Queries and latency of the project source audience check for 20 readers and 30 nested files:
 *   POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin node tooling/verify-knowledge-storage.mjs packages/conversations/test/bench/project-sources.bench.mjs
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createFiles } from '../../../files/src/index.ts';
import { createProjects, projectCompatibility } from '../../src/projects.ts';
import { projectFileIds, usableProjectSources } from '../../src/project-file-sources.ts';
import { conversationFixture } from '../fixture.mjs';

const samples = Number(process.env.BENCH_SAMPLES ?? 20);
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

test('project source audience check', { timeout: 10 * 60 * 1000 }, async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const files = createFiles(f.runtime, {
      putIfAbsent: async () => {},
      read: async (_key, size) => new Uint8Array(size).fill(120),
      remove: async () => {},
    });
    const projects = createProjects(f.runtime, undefined, files);
    const projectId = randomUUID();
    await projects.create(w.id, w.userId, { id: projectId, name: 'Bench' });
    for (let index = 0; index < 19; index++) {
      const member = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        member,
        `reader${index}`,
      ]);
      await projects.member(w.id, w.userId, projectId, { membershipId: member, role: 'member', removed: false });
    }
    let parentId = null;
    for (let depth = 0; depth < 3; depth++)
      parentId = (await files.createFolder(w.id, w.userId, randomUUID(), { name: `Level ${depth}`, parentId })).id;
    const top = (await files.library(w.id, w.userId, { section: 'mine', location: { kind: 'root' }, query: 'Level 0' }))
      .items[0];
    const readers = (
      await f.db.platform.query(`SELECT id FROM ${f.table('tf_memberships')} WHERE id <> $1`, [w.membershipId])
    ).rows;
    for (const reader of readers)
      await files.share(w.id, w.userId, top.id, { kind: 'individual', id: reader.id }, 'viewer');
    const content = new Uint8Array(16).fill(120),
      digest = createHash('sha256').update(content).digest('hex');
    const revisions = [];
    for (let index = 0; index < 30; index++) {
      const fileId = randomUUID();
      await files.upload(
        w.id,
        w.userId,
        fileId,
        { name: `File ${index}.txt`, parentId, mediaType: 'text/plain' },
        content,
      );
      const ids = projectFileIds(projectId, fileId, randomUUID());
      revisions.push({ id: ids.knowledgeId, revisionId: ids.revisionId, digest });
    }
    const timings = [];
    let queries = 0,
      usable = 0;
    for (let sample = 0; sample <= samples; sample++) {
      await f.runtime.transaction(w.id, projectCompatibility, async tx => {
        const query = tx.client.query.bind(tx.client);
        let count = 0;
        tx.client.query = (...args) => {
          count++;
          return query(...args);
        };
        const started = performance.now();
        usable = (await usableProjectSources(tx, projectId, revisions)).size;
        if (sample > 0) timings.push(performance.now() - started);
        tx.client.query = query;
        queries = count;
      });
    }
    assert.equal(usable, 30, 'every reader can read every file');
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        readers: readers.length + 1,
        files: 30,
        samples,
        queries,
        p50: Number(percentile(timings, 0.5).toFixed(1)),
        p95: Number(percentile(timings, 0.95).toFixed(1)),
      }),
    );
  } finally {
    await f.close();
  }
});
