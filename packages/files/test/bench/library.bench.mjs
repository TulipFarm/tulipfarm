/**
 * Library listing benchmark. Run against a disposable cluster:
 *   POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin node tooling/verify-knowledge-storage.mjs packages/files/test/bench/library.bench.mjs
 * BENCH_SIZES (default "2000,20000"), BENCH_SAMPLES (default 20), and BENCH_OUT (a JSON path) tune a run.
 * The seed is deterministic, so `digest` matches between two revisions exactly when every scenario returns the same page.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fixture } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createFiles } from '../../src/index.ts';

const sizes = (process.env.BENCH_SIZES ?? '2000,20000').split(',').map(Number);
const samples = Number(process.env.BENCH_SAMPLES ?? 20);
const uuid = (...parts) => {
  const hex = createHash('sha256').update(parts.join(':')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return state / 2 ** 32;
  };
}
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const mediaTypes = [
  'text/plain',
  'application/pdf',
  'image/png',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

async function seed(db, w, count) {
  const table = name => qualified(w.names.schema, name);
  const rand = random(count);
  const members = { me: w.membershipId };
  for (let index = 0; index < 9; index++) {
    members[`peer${index}`] = uuid('member', index);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      members[`peer${index}`],
      `peer${index}`,
    ]);
  }
  const team = uuid('team', 'a');
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Team A')`, [team]);
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$3),($2,$3)`, [
    members.me,
    members.peer0,
    team,
  ]);
  const owners = Object.values(members);
  const pick = list => list[Math.floor(rand() * list.length)];
  const rows = [],
    folders = [],
    depth = new Map();
  const projects = uuid('item', 'projects');
  rows.push({ id: projects, kind: 'folder', owner: members.me, parent: null, name: 'Projects' });
  folders.push(projects);
  depth.set(projects, 1);
  for (let index = 0; rows.length < count; index++) {
    const id = uuid('item', count, index);
    const kind = rand() < 0.12 ? 'folder' : 'file';
    const roll = rand();
    const parent = roll < 0.1 ? null : roll < 0.15 ? projects : roll < 0.6 ? pick(folders.slice(-20)) : pick(folders);
    const parentDepth = parent ? depth.get(parent) : 0;
    const owner = parent === projects ? pick([members.me, members.me, members.peer1]) : pick(owners);
    const name = `${rand() < 0.06 ? 'Quarterly report' : kind === 'folder' ? 'Folder' : 'Note'} ${index}${kind === 'file' ? ['.txt', '.pdf', '.png', '.csv', '.docx'][index % 5] : ''}`;
    rows.push({
      id,
      kind,
      owner,
      parent: parentDepth >= 10 ? null : parent,
      name,
      media: kind === 'file' ? mediaTypes[index % 5] : null,
      trashed: rand() < 0.02,
    });
    if (kind === 'folder' && parentDepth < 10) {
      folders.push(id);
      depth.set(id, parentDepth + 1);
    }
  }
  for (let start = 0; start < rows.length; start += 1000) {
    const batch = rows.slice(start, start + 1000);
    await db.platform.query(
      `INSERT INTO ${table('tf_files')} (id,kind,creator_membership_id,parent_id,name,object_key,media_type,size,sha256,ready,trashed_at,modified_at)
      SELECT r.id, r.kind, r.owner, r.parent, r.name, CASE WHEN r.kind = 'file' THEN r.object_key END, r.media, CASE WHEN r.kind = 'file' THEN 10 END,
        CASE WHEN r.kind = 'file' THEN repeat('a', 64) END, true, CASE WHEN r.trashed THEN timestamptz '2026-01-02' END, timestamptz '2026-01-01' + r.ordinal * interval '1 minute'
      FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::uuid[], $7::text[], $8::boolean[]) WITH ORDINALITY
        AS r(id, kind, owner, parent, name, object_key, media, trashed, ordinal)`,
      [
        batch.map(row => row.id),
        batch.map(row => row.kind),
        batch.map(row => row.owner),
        batch.map(row => row.parent),
        batch.map(row => row.name),
        batch.map(row => uuid('object', row.id)),
        batch.map(row => row.media),
        batch.map(row => row.trashed),
      ],
    );
  }
  const grants = [];
  for (const row of rows) {
    if (row.owner === members.me || rand() > 0.06) continue;
    const subject = rand() < 0.3 ? ['team', team] : ['individual', rand() < 0.7 ? members.me : pick(owners)];
    grants.push([row.id, ...subject, pick(['viewer', 'editor', 'manager'])]);
  }
  await db.platform.query(
    `INSERT INTO ${table('tf_file_grants')} (item_id,subject_kind,subject_id,role) SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[]) ON CONFLICT DO NOTHING`,
    [
      grants.map(grant => grant[0]),
      grants.map(grant => grant[1]),
      grants.map(grant => grant[2]),
      grants.map(grant => grant[3]),
    ],
  );
  await db.platform.query(`ANALYZE ${table('tf_files')}; ANALYZE ${table('tf_file_grants')}`);
  return { members, projects, grants: grants.length };
}

test('library listing latency', { timeout: 60 * 60 * 1000 }, async () => {
  const results = [];
  for (const count of sizes) {
    const db = await fixture();
    let runtime;
    try {
      const w = await db.create(db.baseline);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const seeded = await seed(db, w, count);
      const names = new Map(Object.entries(seeded.members).map(([name, id]) => [id, name]));
      const files = createFiles(runtime, {
        putIfAbsent: async () => {},
        read: async () => new Uint8Array(),
        remove: async () => {},
      });
      const base = { query: '', location: { kind: 'root' } };
      const scenarios = [
        ['root mine', w.userId, { ...base, section: 'mine' }],
        ['root shared', w.userId, { ...base, section: 'shared' }],
        ['folder', w.userId, { ...base, section: 'mine', location: { kind: 'folder', id: seeded.projects } }],
        ['search', w.userId, { ...base, section: 'shared', query: 'report' }],
        [
          'filtered',
          w.userId,
          {
            ...base,
            section: 'mine',
            query: 'note',
            filters: { type: 'document', owner: 'me' },
            sort: { key: 'modified', direction: 'desc' },
          },
        ],
        ['trash', w.userId, { ...base, section: 'trash' }],
        ['peer root shared', 'peer0', { ...base, section: 'shared' }],
      ];
      for (const [scenario, user, query] of scenarios) {
        const page = await files.library(w.id, user, query);
        const digest = createHash('sha256')
          .update(
            JSON.stringify({
              items: page.items.map(item => [item.id, item.role, item.stranded, item.parentName, item.modifiedAt]),
              next: page.next,
              breadcrumbs: page.breadcrumbs.map(crumb => crumb.id),
              owners: page.owners.map(owner => names.get(owner.membershipId) ?? owner.userId).sort(),
            }),
          )
          .digest('hex')
          .slice(0, 12);
        const timings = [];
        for (let sample = 0; sample < samples; sample++) {
          const started = performance.now();
          await files.library(w.id, user, query);
          timings.push(performance.now() - started);
        }
        timings.sort((a, b) => a - b);
        const result = {
          files: count,
          grants: seeded.grants,
          scenario,
          samples,
          items: page.items.length,
          digest,
          p50: Number(percentile(timings, 0.5).toFixed(1)),
          p95: Number(percentile(timings, 0.95).toFixed(1)),
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    } finally {
      await runtime?.close();
      await db.close();
    }
  }
  if (process.env.BENCH_OUT) await writeFile(process.env.BENCH_OUT, `${JSON.stringify(results, null, 2)}\n`);
});
