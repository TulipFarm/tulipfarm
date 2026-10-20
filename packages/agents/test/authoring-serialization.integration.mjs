import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { initializeSoul, soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision, readVerifiedProjection, verifySoulRevision } from '@tulipfarm/workspaces/soul-revisions';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { agentDefinitionSchema } from '../src/contracts.ts';
import { createAgentAuthoring } from '../src/authoring.ts';

test('agent publication uses immutable Soul bytes for every optional-field combination and input order', async t => {
  const db = await fixture(),
    storage = soulStorageConfig();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    storage.client.destroy();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations()),
    table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  const seed = { workspaceId: w.id, createdBy: w.userId, createdAt: new Date().toISOString() },
    initial = await initializeSoul(storage, seed),
    teamId = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Serialization')`, [teamId]);
  await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, [initial.commit]);
  const authoring = createAgentAuthoring(runtime, () => true);
  let prepared, submitted;
  const writer = authoring.withWriter(async input => {
    submitted = {
      kind: 'agent',
      commandId: input.commandId,
      expectedParentCommit: input.expectedParentCommit,
      createdAt: input.createdAt,
      definition: input.definition,
    };
    prepared = await prepareSoulRevision(
      storage,
      seed,
      input.parent ? { commit: input.expectedParentCommit, bucket: storage.bucket, ...input.parent } : initial,
      submitted,
    );
    return prepared;
  });
  const optional = {
    modelFamilyId: 'claude-opus',
    skills: [{ id: 'agent-authoring', revision: '1' }],
    responseRule: 'every-message',
  };
  assert.deepEqual(
    Object.entries(agentDefinitionSchema.shape)
      .filter(([, schema]) => schema.isOptional())
      .map(([key]) => key)
      .sort(),
    Object.keys(optional).sort(),
    'Add every new optional field to the publication matrix',
  );
  const retained = [];
  for (let mask = 0; mask < 8; mask++)
    for (const reverse of [false, true]) {
      const id = randomUUID(),
        selected = Object.entries(optional).filter((_, index) => mask & (1 << index));
      const definition = {
        name: 'Serialized agent',
        instructions: 'Inspect before changing records.',
        tools: ['rows.list'],
        ...Object.fromEntries(reverse ? selected.reverse() : selected),
      };
      const head = (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0]
        .revision;
      const command = await authoring.save(w.id, w.userId, id, {
        requestId: randomUUID(),
        expectedSoulRevision: head,
        expectedSavedRevision: null,
        owningTeamId: teamId,
        definition,
      });
      assert.equal((await writer.prepare(w.id, command.commandId)).status, 'accepted');
      const expected = {
        formatVersion: 1,
        id,
        name: 'Serialized agent',
        instructions: 'Inspect before changing records.',
        tools: ['rows.list'],
        ...(definition.modelFamilyId ? { modelFamilyId: 'claude-opus' } : {}),
        ...(definition.responseRule ? { responseRule: 'every-message' } : {}),
        ...(definition.skills ? { skills: [{ id: 'agent-authoring', revision: '1' }] } : {}),
      };
      const bytes = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`);
      assert.equal(prepared.projection.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(await readVerifiedProjection(storage, w.id, prepared.projection), expected);
      assert.deepEqual(
        (await verifySoulRevision(storage, seed, prepared.bundle, prepared.projection)).definition,
        expected,
      );
      const stored = await storage.client.send(
        new GetObjectCommand({ Bucket: storage.bucket, Key: prepared.projection.key }),
      );
      assert.deepEqual(Buffer.from(await stored.Body.transformToByteArray()), bytes);
      const parent =
        mask === 0 && !reverse
          ? initial
          : {
              commit: submitted.expectedParentCommit,
              bucket: storage.bucket,
              ...(
                await db.platform.query(
                  `SELECT bundle_key AS key,bundle_sha256 AS sha256 FROM ${table('tf_soul_revisions')} WHERE revision=$1`,
                  [submitted.expectedParentCommit],
                )
              ).rows[0],
            };
      assert.deepEqual(
        await prepareSoulRevision(storage, seed, parent, {
          ...submitted,
          definition: Object.fromEntries(Object.entries(submitted.definition).reverse()),
        }),
        prepared,
      );
      retained.push({ projection: prepared.projection, bytes });
    }
  for (const item of retained) {
    const stored = await storage.client.send(
      new GetObjectCommand({ Bucket: storage.bucket, Key: item.projection.key }),
    );
    assert.deepEqual(
      Buffer.from(await stored.Body.transformToByteArray()),
      item.bytes,
      'Later saves never rewrite an immutable projection',
    );
  }
});
