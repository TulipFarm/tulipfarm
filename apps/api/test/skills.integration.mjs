import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture, loadPlatformBaseline } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createSkillImports } from '@tulipfarm/agents/skill-imports';
import { createSkillObjects } from '@tulipfarm/agents/skill-objects';
import { createWorkspaceSkills } from '@tulipfarm/agents/workspace-skills';
import { buildSkillPackage } from '@tulipfarm/agents/skill-packages';
import { authenticatedFixture } from './auth-fixture.mjs';
import { registerSkills } from '../src/skills.ts';
import { registerSkillImports } from '../src/skill-imports.ts';

test(
  'authenticated imports require exact review, retire manual saves, and preserve private access and lifecycle',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let pool, runtime, app;
    try {
      await loadPlatformBaseline(db.platform);
      const authenticated = await authenticatedFixture(db);
      pool = authenticated.identity;
      const w = await db.create(await workspaceTableMigrations(), { userId: authenticated.owner.id });
      await authenticated.addAdmin(w);
      const { auth, owner } = authenticated,
        reader = await authenticated.signIn(),
        stranger = await authenticated.signIn();
      await db.platform.query(
        `INSERT INTO "${w.names.schema}".tf_memberships(id,user_id,role) VALUES ($1,$2,'member')`,
        [randomUUID(), reader.id],
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
      });
      const data = new Map(),
        objects = {
          async putIfAbsent(key, bytes) {
            if (!data.has(key)) data.set(key, Uint8Array.from(bytes));
          },
          async read(key) {
            if (!data.has(key)) throw new Error('missing-object');
            return data.get(key);
          },
          async remove(key) {
            data.delete(key);
          },
        };
      const built = buildSkillPackage([
        {
          path: 'SKILL.md',
          bytes: Buffer.from(
            '---\nname: monthly-close\ndescription: Prepare the monthly close\n---\nRead [the guide](references/guide.md).',
          ),
        },
        { path: 'references/guide.md', bytes: Buffer.from('Reconcile the source totals before reporting.') },
      ]);
      let reviews = 0;
      const worker = createSkillImports(runtime, {
        objects: createSkillObjects(runtime, objects),
        runtimeAvailable: () => false,
        readSource: async () => ({
          kind: 'skills',
          skills: [
            {
              ...built,
              path: '',
              source: {
                submittedUrl: 'https://example.com/close.skill',
                canonicalUrl: 'https://example.com/close.skill',
                digest: built.definition.package.digest,
              },
            },
          ],
        }),
        review: () => async () => {
          reviews++;
          return { summary: 'Controlled review fixture; no live model call.', findings: [] };
        },
      });
      app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
      app.register(
        async routes => {
          registerSkills(routes, { auth, runtime });
          registerSkillImports(routes, { auth, runtime, objects });
        },
        { prefix: '/v1' },
      );
      await app.ready();
      const base = `/v1/workspaces/${w.id}`,
        importId = randomUUID(),
        imported = `${base}/skill-imports/${importId}`;
      async function http(who, method, url, payload, origin = 'http://localhost:5173') {
        const response = await app.inject({
          method,
          url,
          headers: { cookie: who?.cookie ?? '', origin },
          ...(payload ? { payload } : {}),
        });
        assert.equal(response.headers['cache-control'], 'no-store');
        return { status: response.statusCode, body: response.json() };
      }
      async function ok(...args) {
        const response = await http(...args);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body;
      }
      assert.equal((await http(null, 'GET', `${base}/skills`)).status, 401);
      assert.equal((await http(stranger, 'GET', `${base}/skills`)).status, 404);
      const manual = {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: { name: 'Manual', instructions: 'Not allowed.' },
      };
      assert.equal((await http(owner, 'PUT', `${base}/skills/${randomUUID()}`, manual)).status, 410);
      assert.equal(
        (await http(owner, 'PUT', imported, { url: 'https://example.com/close.skill' }, 'https://foreign.example'))
          .status,
        403,
      );
      const input = { url: 'https://example.com/close.skill' };
      await ok(owner, 'PUT', imported, input);
      await ok(owner, 'PUT', imported, input);
      await worker.process(w.id, importId);
      let view = await ok(owner, 'GET', imported);
      assert.equal(view.status, 'discovered');
      assert.equal(reviews, 0);
      assert.equal((await http(reader, 'GET', imported)).status, 404);
      await ok(owner, 'PUT', `${imported}/selection`, { selected: [view.candidates[0].id] });
      await worker.process(w.id, importId);
      view = await ok(owner, 'GET', imported);
      assert.equal(view.status, 'ready');
      const file = `${imported}/packages/${view.candidates[0].id}/file?path=references%2Fguide.md`;
      assert.equal((await ok(owner, 'GET', file)).text, 'Reconcile the source totals before reporting.');
      assert.equal((await http(reader, 'GET', file)).status, 404);
      const decision = {
        commandId: randomUUID(),
        digest: view.digest,
        selected: view.selected,
        acknowledgeWarnings: true,
      };
      assert.equal(
        (await http(owner, 'PUT', `${imported}/decision`, { ...decision, digest: '0'.repeat(64) })).status,
        409,
      );
      const receipts = await ok(owner, 'PUT', `${imported}/decision`, decision),
        [receipt] = receipts;
      assert.deepEqual(await ok(owner, 'PUT', `${imported}/decision`, decision), receipts);
      assert.equal(receipt.enabled, true);
      assert.equal(
        (await ok(owner, 'GET', `${base}/skills?view=reviewed`)).workspace[0].description,
        'Prepare the monthly close',
      );
      const path = `${base}/skills/${receipt.id}`;
      assert.equal((await ok(owner, 'GET', path)).definition.package.digest, built.definition.package.digest);
      assert.equal((await http(reader, 'GET', path)).status, 404);
      assert.equal((await ok(owner, 'GET', `${path}/history`)).items[0].revision, receipt.savedRevision);
      assert.equal((await http(reader, 'GET', `${path}/history`)).status, 404);
      assert.deepEqual(await ok(owner, 'GET', `${path}/runtime`), { available: false, profile: 'skill-runtime-v1' });
      assert.deepEqual((await ok(reader, 'GET', `${base}/skills`)).workspace, []);
      assert.equal(
        (await ok(owner, 'GET', `${path}/revisions/${receipt.savedRevision}/file?path=SKILL.md`)).kind,
        'text',
      );
      const update = randomUUID();
      await ok(owner, 'PUT', `${path}/updates/${update}`);
      await worker.process(w.id, update);
      assert.equal((await ok(owner, 'GET', `${base}/skill-imports/${update}`)).status, 'unchanged');
      assert.equal(reviews, 1);
      const disabled = await ok(owner, 'PUT', `${path}/enabled`, {
        requestId: randomUUID(),
        expectedVersion: receipt.version,
        enabled: false,
      });
      assert.equal(
        (await ok(owner, 'PUT', `${path}/updates/${update}`)).status,
        'unchanged',
        'Replay keeps the old update request after a version change',
      );
      assert.deepEqual((await ok(owner, 'GET', `${base}/skills?view=reviewed`)).workspace, []);
      const archived = await ok(owner, 'PUT', `${path}/lifecycle`, {
        requestId: randomUUID(),
        expectedVersion: disabled.version,
        lifecycle: 'archived',
      });
      assert.equal((await ok(owner, 'GET', `${base}/skills?view=archived`)).workspace[0].id, receipt.id);
      const deletion = { requestId: randomUUID(), expectedVersion: archived.version, lifecycle: 'deleted' };
      const deleted = await ok(owner, 'PUT', `${path}/lifecycle`, deletion);
      assert.equal(deleted.lifecycle, 'deleted');
      assert.deepEqual(await ok(owner, 'PUT', `${path}/lifecycle`, deletion), deleted);
      assert.equal((await http(owner, 'GET', path)).status, 404);
      const actor = { kind: 'human', userId: owner.id, membershipId: w.membershipId };
      const scripts = createSkillImports(runtime, {
        objects: createSkillObjects(runtime, objects),
        runtimeAvailable: () => true,
        review: () => async () => ({ summary: 'Controlled script review.', findings: [] }),
      });
      const scriptImport = randomUUID();
      await scripts.draft(
        w.id,
        actor,
        scriptImport,
        [
          {
            path: 'SKILL.md',
            bytes: Buffer.from(
              '---\nname: script-example\ndescription: Run a local example\n---\nRun scripts/example.sh when asked.',
            ),
          },
          { path: 'scripts/example.sh', bytes: Buffer.from('printf example') },
        ],
        [],
        createSkillObjects(runtime, objects),
      );
      await scripts.process(w.id, scriptImport);
      const scriptView = await scripts.read(w.id, actor, scriptImport);
      const scriptDecision = {
        commandId: randomUUID(),
        digest: scriptView.digest,
        selected: scriptView.selected,
        acknowledgeWarnings: true,
      };
      const scriptReviewPath = `${base}/skill-imports/${scriptImport}/decision`;
      assert.deepEqual(await http(owner, 'PUT', scriptReviewPath, scriptDecision), {
        status: 409,
        body: { error: 'runtime-unavailable' },
      });
      const scriptReceipts = await scripts.approve(w.id, actor, scriptImport, scriptDecision);
      assert.deepEqual(
        await ok(owner, 'PUT', scriptReviewPath, scriptDecision),
        scriptReceipts,
        'An installed decision replays without requiring a live runner',
      );
      const [script] = scriptReceipts,
        scriptPath = `${base}/skills/${script.id}`;
      const stopped = await ok(owner, 'PUT', `${scriptPath}/enabled`, {
        requestId: randomUUID(),
        expectedVersion: script.version,
        enabled: false,
      });
      const enable = { requestId: randomUUID(), expectedVersion: stopped.version, enabled: true };
      assert.deepEqual(await http(owner, 'PUT', `${scriptPath}/enabled`, enable), {
        status: 409,
        body: { error: 'runtime-unavailable' },
      });
      assert.deepEqual(
        await http(owner, 'POST', `${scriptPath}/review`, {
          requestId: randomUUID(),
          expectedVersion: stopped.version,
          revision: script.savedRevision,
        }),
        { status: 409, body: { error: 'runtime-unavailable' } },
      );
      const enabled = await createWorkspaceSkills(runtime).setEnabled(w.id, actor, script.id, enable);
      assert.deepEqual(
        await ok(owner, 'PUT', `${scriptPath}/enabled`, enable),
        enabled,
        'A previously completed enable command keeps its receipt',
      );
    } finally {
      await app?.close();
      await runtime?.close();
      await pool?.end();
      await db.close();
    }
  },
);
