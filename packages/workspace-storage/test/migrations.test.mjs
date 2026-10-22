import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMigrations } from '../src/provisioning.ts';
import { commonCompatibility } from '../src/runtime.ts';

test('common migration discovery orders actual SQL and rejects duplicate sequence numbers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-common-migrations-'));
  try {
    await writeFile(join(directory, '0002_second.sql'), 'SELECT 2;');
    await writeFile(join(directory, '0001_first.sql'), 'SELECT 1;');
    const migrations = await readMigrations(directory);
    assert.deepEqual(
      migrations.map(({ name }) => name),
      ['0001_first.sql', '0002_second.sql'],
    );
    assert.equal(migrations[0].checksum, '17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a');
    await writeFile(join(directory, '0001_duplicate.sql'), 'SELECT 3;');
    await assert.rejects(readMigrations(directory), /history differs/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('readers accept every shipped common migration', async () => {
  assert.equal(commonCompatibility.maximum, (await readMigrations()).length);
});
