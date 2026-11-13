import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { qualified, rolloutCommonMigrations } from '../../src/provisioning.ts';
import { catalogShape } from './catalog-shape.mjs';
import { connect, denied, fixture } from './fixture.mjs';

const appsMigration = '0070_apps.sql';
const checkViolation = error => error.code === '23514';

test(
  'app tables are identical on a fresh workspace and one upgraded from before them',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    try {
      const before = db.baseline.findIndex(item => item.name === appsMigration);
      assert.equal(db.baseline.at(-1).name, '0074_app_credit_activities.sql');
      const upgraded = await db.create(db.baseline.slice(0, before));
      assert.equal(
        (await db.platform.query(`SELECT to_regclass($1) AS present`, [`${upgraded.names.schema}.tf_apps`])).rows[0]
          .present,
        null,
      );
      const rollout = await rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations: db.baseline,
        listWorkspaceIds: async () => [upgraded.id],
      });
      assert.deepEqual(rollout.results, [{ workspaceId: upgraded.id, status: 'applied', errorCode: null }]);
      const fresh = await db.create();
      const shape = async workspace => {
        const { relations, columns, constraints, indexes } = await catalogShape(db.platform, workspace.names);
        const app = value => /tf_app|tf_conversations/.test(JSON.stringify(value));
        return {
          relations: relations.filter(app),
          columns: columns.filter(app),
          constraints: constraints.filter(app),
          indexes: indexes.filter(app),
        };
      };
      const freshShape = await shape(fresh);
      assert.deepEqual(await shape(upgraded), freshShape);
      assert.deepEqual(
        freshShape.relations.filter(row => row.relkind === 'r').map(row => row.relname),
        [
          'tf_app_broken_references',
          'tf_app_builds',
          'tf_app_draft_changes',
          'tf_app_drafts',
          'tf_app_grants',
          'tf_app_operations',
          'tf_app_releases',
          'tf_app_source_bundles',
          'tf_app_usage_windows',
          'tf_app_versions',
          'tf_apps',
          'tf_conversations',
        ],
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'app CHECKs keep public-only state off private apps and live releases behind approval',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    const workspace = await db.create();
    const runtime = await connect(db.login(workspace));
    try {
      const table = name => qualified(workspace.names.schema, name);
      const member = workspace.membershipId;
      const insertApp = (kind, slug, columns = {}) => {
        const names = ['id', 'kind', 'slug', 'title', 'created_by', ...Object.keys(columns)];
        const values = [randomUUID(), kind, slug, 'Orders', member, ...Object.values(columns)];
        return runtime.query(
          `INSERT INTO ${table('tf_apps')} (${names.join(',')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
          values,
        );
      };

      await assert.rejects(insertApp('private', 'named', { public_name: 'orders' }), checkViolation);
      await assert.rejects(insertApp('private', 'approved', { approval_state: 'requested' }), checkViolation);
      await assert.rejects(insertApp('private', 'previewed', { preview_key: 'k'.repeat(26) }), checkViolation);
      await assert.rejects(insertApp('public', 'versioned', { live_version_id: randomUUID() }), checkViolation);
      await assert.rejects(insertApp('public', 'unapproved', { live_release_id: randomUUID() }), checkViolation);
      await assert.rejects(
        insertApp('public', 'requested', { approval_state: 'requested', live_release_id: randomUUID() }),
        checkViolation,
      );

      const release = randomUUID();
      const [publicApp] = (
        await insertApp('public', 'storefront', {
          public_name: 'acme-store',
          approval_state: 'approved',
          live_release_id: release,
        })
      ).rows;
      const [privateApp] = (await insertApp('private', 'orders', { live_version_id: randomUUID() })).rows;
      assert.deepEqual(
        (await runtime.query(`SELECT slug, kind, public_name, live_release_id FROM ${table('tf_apps')} ORDER BY slug`))
          .rows,
        [
          { slug: 'orders', kind: 'private', public_name: null, live_release_id: null },
          { slug: 'storefront', kind: 'public', public_name: 'acme-store', live_release_id: release },
        ],
      );
      await assert.rejects(
        runtime.query(`UPDATE ${table('tf_apps')} SET approval_state = 'rejected' WHERE id = $1`, [publicApp.id]),
        checkViolation,
      );
      await assert.rejects(
        runtime.query(`UPDATE ${table('tf_apps')} SET public_name = 'orders' WHERE id = $1`, [privateApp.id]),
        checkViolation,
      );
      await denied(runtime, `UPDATE ${table('tf_apps')} SET kind = 'public' WHERE id = $1`, [privateApp.id]);
      await denied(runtime, `DELETE FROM ${table('tf_apps')} WHERE id = $1`, [privateApp.id]);

      const grant = (grantee, membership, team, role) =>
        runtime.query(
          `INSERT INTO ${table('tf_app_grants')} (app_id, grantee, membership_id, team_id, role, granted_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [privateApp.id, grantee, membership, team, role, member],
        );
      await assert.rejects(grant(`member:${randomUUID()}`, null, null, 'edit'), checkViolation);
      await assert.rejects(grant(`team:${randomUUID()}`, null, null, 'use'), checkViolation);
      await assert.rejects(grant('workspace', null, null, 'edit'), checkViolation);
      await grant(`member:${member}`, member, null, 'edit');
      await grant('workspace', null, null, 'use');
      assert.deepEqual(
        (await runtime.query(`SELECT grantee, role FROM ${table('tf_app_grants')} ORDER BY grantee`)).rows,
        [
          { grantee: `member:${member}`, role: 'edit' },
          { grantee: 'workspace', role: 'use' },
        ],
      );
    } finally {
      await runtime.end();
      await db.close();
    }
  },
);

test('builds, releases and source bundles change only where their lifecycle allows', { timeout: 60000 }, async () => {
  const db = await fixture();
  const workspace = await db.create();
  const runtime = await connect(db.login(workspace));
  try {
    const table = name => qualified(workspace.names.schema, name);
    const member = workspace.membershipId;
    const appId = randomUUID();
    const commit = 'c'.repeat(40);
    const buildId = 'b'.repeat(64);
    await runtime.query(
      `INSERT INTO ${table('tf_apps')} (id, kind, slug, title, created_by) VALUES ($1, 'public', 'site', 'Site', $2)`,
      [appId, member],
    );
    await assert.rejects(
      runtime.query(
        `INSERT INTO ${table('tf_app_builds')} (id, app_id, commit, recipe, builder, status, requested_by) VALUES ($1,$2,$3,'{}','copy','succeeded',$4)`,
        [buildId, appId, commit, member],
      ),
      checkViolation,
    );
    await runtime.query(
      `INSERT INTO ${table('tf_app_builds')} (id, app_id, commit, recipe, builder, status, requested_by) VALUES ($1,$2,$3,'{"kind":"copy","root":"."}','copy','queued',$4)`,
      [buildId, appId, commit, member],
    );
    await runtime.query(
      `UPDATE ${table('tf_app_builds')} SET status = 'succeeded', manifest_digest = $2, files = 3, bytes = 2048 WHERE id = $1`,
      [buildId, 'd'.repeat(64)],
    );
    const releaseId = randomUUID();
    await runtime.query(
      `INSERT INTO ${table('tf_app_releases')} (id, app_id, number, build_id, commit, manifest_digest, published_by) VALUES ($1,$2,1,$3,$4,$5,$6)`,
      [releaseId, appId, buildId, commit, 'd'.repeat(64), member],
    );
    await runtime.query(`UPDATE ${table('tf_app_releases')} SET staged_at = clock_timestamp() WHERE id = $1`, [
      releaseId,
    ]);
    await denied(runtime, `UPDATE ${table('tf_app_releases')} SET commit = $2 WHERE id = $1`, [
      releaseId,
      'e'.repeat(40),
    ]);
    await denied(runtime, `UPDATE ${table('tf_app_source_bundles')} SET object_key = 'x'`);
    await denied(runtime, `UPDATE ${table('tf_app_versions')} SET definition = '{}'`);

    const stage = path =>
      runtime.query(
        `INSERT INTO ${table('tf_app_draft_changes')} (app_id, lease_id, path, content) VALUES ($1,$2,$3,$4)`,
        [appId, randomUUID(), path, Buffer.from('<h1>Hi</h1>')],
      );
    await stage('index.html');
    for (const path of ['/etc/passwd', '../outside', 'a/../../b', '.git/config'])
      await assert.rejects(stage(path), checkViolation, path);
    await assert.rejects(
      runtime.query(
        `INSERT INTO ${table('tf_app_draft_changes')} (app_id, lease_id, path, content) VALUES ($1,$2,'big.bin',$3)`,
        [appId, randomUUID(), Buffer.alloc(512 * 1024 + 1)],
      ),
      checkViolation,
    );

    const operation = requestId =>
      runtime.query(
        `INSERT INTO ${table('tf_app_operations')} (id, app_id, request_id, requested_by, kind, generation, target_release_id, status)
         VALUES ($1,$2,$3,$4,'publish',1,$5,'admitted') ON CONFLICT (requested_by, request_id) DO NOTHING RETURNING id`,
        [randomUUID(), appId, requestId, member, releaseId],
      );
    const requestId = randomUUID();
    assert.equal((await operation(requestId)).rowCount, 1);
    assert.equal((await operation(requestId)).rowCount, 0);
  } finally {
    await runtime.end();
    await db.close();
  }
});
