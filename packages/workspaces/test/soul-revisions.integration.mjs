import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { initializeSoul, soulStorageConfig } from '../src/soul.ts';
import { prepareSoulRevision, readVerifiedProjection, verifySoulRevision } from '../src/soul-revisions.ts';

test('local R2 restores an immutable resource revision and preserves the starter on replay', async () => {
  const storage = soulStorageConfig();
  assert.equal(storage.bucket, 'tulipfarm-cloud-soul-local');
  const seed = { workspaceId: randomUUID(), createdBy: randomUUID(), createdAt: new Date().toISOString() };
  try {
    const parent = await initializeSoul(storage, seed);
    const initial = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: parent.key }));
    const initialBytes = await initial.Body.transformToByteArray();
    const tableId = randomUUID();
    const fieldId = randomUUID();
    const definition = {
      formatVersion: 2,
      id: tableId,
      owningTeamId: randomUUID(),
      label: 'Soul restore probe',
      fields: [{ id: fieldId, label: 'Amount', kind: 'text', required: false, maxLength: 100 }],
      uniqueKeys: [],
    };
    const timestamp = `${new Date().toISOString().slice(0, 19)}.001Z`;
    const command = {
      kind: 'table',
      commandId: randomUUID(),
      expectedParentCommit: parent.commit,
      createdAt: timestamp,
      definition,
    };
    const revision = await prepareSoulRevision(storage, seed, parent, command);
    assert.deepEqual(await prepareSoulRevision(storage, seed, parent, command), revision);
    assert.deepEqual(
      await prepareSoulRevision(storage, { ...seed, workspaceId: seed.workspaceId.toUpperCase() }, parent, {
        ...command,
        commandId: command.commandId.toUpperCase(),
      }),
      revision,
    );
    await assert.rejects(
      prepareSoulRevision(storage, seed, parent, {
        ...command,
        commandId: command.commandId.toUpperCase(),
        definition: { ...definition, label: 'Conflicting' },
      }),
      /checksum|metadata/,
    );
    await assert.rejects(
      prepareSoulRevision(storage, seed, parent, { ...command, createdAt: timestamp.replace('.001Z', '.999Z') }),
      /checksum|metadata/,
    );
    const stored = await storage.client.send(
      new GetObjectCommand({ Bucket: storage.bucket, Key: revision.bundle.key }),
    );
    await stored.Body.transformToByteArray();
    assert.equal(stored.Metadata['command-sha256'], revision.commandSha256);
    assert.deepEqual(await readVerifiedProjection(storage, seed.workspaceId, revision.projection), definition);
    assert.deepEqual(
      (await verifySoulRevision(storage, seed, revision.bundle, revision.projection)).definition,
      definition,
    );
    let pointer = revision.bundle;
    for (const document of [
      { ...definition, fields: [{ ...definition.fields[0], required: true }] },
      { ...definition, label: 'Renamed probe' },
    ]) {
      const prepared = await prepareSoulRevision(storage, seed, pointer, {
        kind: 'table',
        commandId: randomUUID(),
        expectedParentCommit: pointer.commit,
        createdAt: new Date().toISOString(),
        definition: document,
      });
      assert.deepEqual(
        (await verifySoulRevision(storage, seed, prepared.bundle, prepared.projection)).definition,
        document,
      );
      pointer = prepared.bundle;
    }
    const after = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: parent.key }));
    assert.equal(after.ETag, initial.ETag);
    assert.deepEqual(await after.Body.transformToByteArray(), initialBytes);
  } finally {
    storage.client.destroy();
  }
});
