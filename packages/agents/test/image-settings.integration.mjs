import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';

const rate = [{ usdPerMillionTokens: { input: 1, output: 2 } }];
const chat = (id, extra = {}) => ({
  id,
  name: id,
  vendor: 'acme',
  routes: [{ provider: 'anthropic', model: `${id}-1` }],
  limits: { maxInputTokens: 1000, maxOutputTokens: 100 },
  pricing: rate,
  ...extra,
});
const image = (id, extra = {}) => ({
  id,
  name: id,
  vendor: 'acme',
  routes: [{ provider: 'openai', model: `${id}-1`, api: 'openai-images' }],
  aspects: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
  pricing: 'unmetered',
  ...extra,
});
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-key';
delete process.env.MODEL_CATALOG_FILE;
process.env.MODEL_CATALOG = JSON.stringify({
  version: 1,
  models: [
    chat('paired', {
      default: true,
      imageModel: 'pair-image',
      capabilities: { imageInput: true },
      roles: ['document-vision'],
    }),
    chat('reader', { capabilities: { imageInput: true } }),
    chat('plain'),
    chat('other'),
  ],
  imageModels: [image('pair-image'), image('main-image', { default: true }), image('held-image', { paused: true })],
});

const { createWorkspaceRuntime, commonCompatibility } = await import('@tulipfarm/workspace-storage/runtime');
const { provisionWorkspace } = await import('@tulipfarm/workspace-storage/provisioning');
const { workspaceTableMigrations } = await import('@tulipfarm/workspaces/table-migrations');
const { createImageSettingsService, recognitionAvailability, resolveImageModels, workspaceRecognitionFamily } =
  await import('../src/image-settings.ts');
const { loadModelCatalog } = await import('@tulipfarm/config');
const { provisionTestPgvector } = await import('../../workspace-storage/test/integration/pgvector.fixture.mjs');
const { loadPlatformBaseline, registerPlatformWorkspace } =
  await import('../../workspace-storage/test/integration/fixture.mjs');

test(
  'image settings resolve paired, default and chosen models and save with revisions',
  { timeout: 60000 },
  async () => {
    const workspaceId = randomUUID();
    const membershipId = randomUUID();
    const memberId = randomUUID();
    const database = `images_${randomUUID().replaceAll('-', '')}`;
    const databaseURL = new URL(
      process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:local-postgres@127.0.0.1:5432/postgres',
    );
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseURL.hostname));
    const admin = new Client({ connectionString: databaseURL.href });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await provisionTestPgvector(admin, database);
    databaseURL.pathname = `/${database}`;
    const connectionString = databaseURL.href;
    const passwords = { runtime: randomUUID(), migration: randomUUID(), confirmation: randomUUID() };
    const owner = new Client({ connectionString });
    await owner.connect();
    let runtime;
    let names;
    try {
      await loadPlatformBaseline(owner);
      names = await provisionWorkspace({
        connectionString,
        workspaceId,
        passwords,
        initialAdmin: { userId: 'admin', membershipId },
        migrations: await workspaceTableMigrations(),
      });
      await registerPlatformWorkspace(owner, workspaceId);
      await owner.query(
        `INSERT INTO "${names.schema}".tf_memberships (id, user_id, role) VALUES ($1, 'member', 'member')`,
        [memberId],
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => {
          const url = new URL(connectionString);
          url.username = names.runtime;
          url.password = passwords.runtime;
          return { workspaceId: id, generation: 1, connectionString: url.href };
        },
      });
      const resolve = familyId =>
        runtime.transaction(workspaceId, commonCompatibility, tx => resolveImageModels(tx, familyId));
      const disable = async familyId =>
        owner.query(
          `INSERT INTO "${names.schema}".tf_model_availability (family_id, enabled, revision, last_disabled_revision, editor_membership_id)
        VALUES ($1, false, 1, 1, $2) ON CONFLICT (family_id) DO UPDATE SET enabled = false`,
          [familyId, membershipId],
        );
      const enable = familyId =>
        owner.query(`DELETE FROM "${names.schema}".tf_model_availability WHERE family_id = $1`, [familyId]);
      const settings = createImageSettingsService(runtime);

      const initial = await settings.read(workspaceId, 'member');
      assert.deepEqual(
        initial,
        {
          recognitionFamilyId: null,
          defaultImageModelId: null,
          generationEnabled: true,
          revision: 0,
          editorMembershipId: null,
          updatedAt: null,
          effective: { recognitionFamilyId: 'paired', defaultImageModelId: 'main-image' },
          recognitionFamilies: [
            { id: 'paired', name: 'paired', enabled: true },
            { id: 'reader', name: 'reader', enabled: true },
          ],
          imageModels: [
            { id: 'pair-image', name: 'pair-image', enabled: true },
            { id: 'main-image', name: 'main-image', enabled: true },
            { id: 'held-image', name: 'held-image', enabled: false },
          ],
        },
        'no saved row uses the catalog defaults, and a paused image model is not a choice',
      );

      assert.deepEqual(await resolve('paired'), {
        familyId: 'paired',
        image: { status: 'available', imageModelId: 'pair-image' },
        recognition: { status: 'available', familyId: 'paired' },
      });
      assert.deepEqual((await resolve('plain')).image, { status: 'available', imageModelId: 'main-image' });

      await disable('pair-image');
      assert.deepEqual(
        (await resolve('paired')).image,
        { status: 'unavailable', code: 'image-model-unavailable', alternativeFamilyId: 'reader' },
        'a disabled paired model never falls back to the default; another family is suggested',
      );
      await enable('pair-image');

      await assert.rejects(
        settings.save(workspaceId, 'member', {
          requestId: randomUUID(),
          expectedRevision: 0,
          recognitionFamilyId: null,
          defaultImageModelId: null,
          generationEnabled: true,
        }),
        error => error.message === 'Resource not found',
        'members cannot change image settings',
      );
      const save = (input = {}) =>
        settings.save(workspaceId, 'admin', {
          requestId: randomUUID(),
          expectedRevision: 0,
          recognitionFamilyId: null,
          defaultImageModelId: null,
          generationEnabled: true,
          ...input,
        });
      await assert.rejects(save({ recognitionFamilyId: 'plain' }), { code: 'model-family-unavailable', status: 400 });
      await assert.rejects(save({ defaultImageModelId: 'held-image' }), {
        code: 'image-model-unavailable',
        status: 400,
      });
      await assert.rejects(save({ expectedRevision: 3 }), { code: 'image-settings-revision-conflict' });

      const command = {
        requestId: randomUUID(),
        expectedRevision: 0,
        recognitionFamilyId: 'reader',
        defaultImageModelId: 'pair-image',
        generationEnabled: true,
      };
      const receipt = await settings.save(workspaceId, 'admin', command);
      assert.equal(receipt.requestId, command.requestId);
      assert.equal(receipt.revision, 1);
      assert.equal(receipt.editorMembershipId, membershipId);
      assert.deepEqual(receipt.effective, { recognitionFamilyId: 'reader', defaultImageModelId: 'pair-image' });
      assert.deepEqual(await settings.save(workspaceId, 'admin', command), receipt, 'a retried command replays');
      assert.deepEqual(await settings.commandStatus(workspaceId, 'admin', command.requestId), receipt);
      await assert.rejects(settings.save(workspaceId, 'admin', { ...command, generationEnabled: false }), {
        code: 'idempotency-conflict',
      });
      await assert.rejects(settings.commandStatus(workspaceId, 'admin', randomUUID()), {
        message: 'Resource not found',
      });
      assert.equal(
        (
          await owner.query(
            `SELECT count(*)::int AS count FROM "${names.schema}".tf_audit_events WHERE operation = 'model.image-settings.save'`,
          )
        ).rows[0].count,
        1,
      );
      assert.deepEqual((await resolve('plain')).image, { status: 'available', imageModelId: 'pair-image' });
      assert.deepEqual((await resolve('plain')).recognition, { status: 'available', familyId: 'reader' });

      await disable('reader');
      assert.deepEqual(
        (await resolve('plain')).recognition,
        { status: 'unavailable', reason: 'recognition-model-unavailable' },
        'a disabled chosen recognition model does not fall back to the catalog one',
      );
      const kept = await save({
        expectedRevision: 1,
        recognitionFamilyId: 'reader',
        defaultImageModelId: 'pair-image',
        generationEnabled: false,
      });
      assert.equal(kept.revision, 2, 'an unusable choice kept from before can still be saved');
      assert.deepEqual(
        (await resolve('paired')).image,
        { status: 'unavailable', code: 'image-model-unavailable', alternativeFamilyId: null },
        'generation off leaves no image model for any family',
      );
      await owner.query(`UPDATE "${names.schema}".tf_knowledge_settings SET media_recognition = false`);
      await enable('reader');
      assert.deepEqual((await resolve('plain')).recognition, { status: 'unavailable', reason: 'recognition-off' });

      const noVisionRole = loadModelCatalog({
        ...process.env,
        MODEL_CATALOG: JSON.stringify({
          version: 1,
          models: [chat('plain', { default: true }), chat('reader', { capabilities: { imageInput: true } })],
          imageModels: [image('main-image', { default: true })],
        }),
      });
      const withFlag = async (value, operation) => {
        const previous = process.env.FEATURE_FLAG_IMAGES;
        process.env.FEATURE_FLAG_IMAGES = value;
        try {
          return await operation();
        } finally {
          if (previous === undefined) delete process.env.FEATURE_FLAG_IMAGES;
          else process.env.FEATURE_FLAG_IMAGES = previous;
        }
      };
      await withFlag('true', async () => {
        assert.equal(
          await workspaceRecognitionFamily(runtime, workspaceId),
          null,
          'with the recognition switch off tasks and Files read no images either',
        );
        await owner.query(`UPDATE "${names.schema}".tf_knowledge_settings SET media_recognition = true`);
        assert.equal(
          await workspaceRecognitionFamily(runtime, workspaceId),
          'reader',
          'under the images flag files are read by the workspace recognition model',
        );
        await disable('reader');
        assert.equal(
          await workspaceRecognitionFamily(runtime, workspaceId),
          null,
          'a disabled chosen model leaves nothing to read images',
        );
        await enable('reader');
      });
      await withFlag('false', async () => {
        assert.equal(
          await workspaceRecognitionFamily(runtime, workspaceId),
          'paired',
          'without the flag files keep the catalog document-vision model',
        );
        assert.equal(await recognitionAvailability(runtime)(workspaceId), true);
        assert.equal(
          await recognitionAvailability(runtime, noVisionRole)(workspaceId),
          false,
          'a catalog with no document-vision model reports recognition unavailable',
        );
      });
    } finally {
      await runtime?.close();
      await owner.end();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (names)
        for (const name of [names.runtime, names.migration, names.confirmation, names.customOwner])
          await admin.query(`DROP ROLE "${name}"`);
      await admin.end();
    }
  },
);
