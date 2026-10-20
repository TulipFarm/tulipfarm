import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMigrations } from '../src/migrations.ts';
import { DatabaseError } from '../src/config.ts';

test('migration discovery orders SQL, checksums content, and rejects duplicate sequence numbers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tulipfarm-migrations-'));
  try {
    await writeFile(join(directory, '0002_second.sql'), 'SELECT 2;');
    await writeFile(join(directory, '0001_first.sql'), 'SELECT 1;');
    const migrations = await readMigrations(directory);
    assert.deepEqual(
      migrations.map(item => item.name),
      ['0001_first.sql', '0002_second.sql'],
    );
    assert.equal(migrations[0].checksum, '17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a');
    await writeFile(join(directory, '0001_duplicate.sql'), 'SELECT 3;');
    await assert.rejects(
      readMigrations(directory),
      error => error instanceof DatabaseError && /Duplicate migration numbers/.test(error.message),
    );
    await rm(join(directory, '0001_duplicate.sql'));
    await writeFile(join(directory, 'bad-name.sql'), 'SELECT 4;');
    await assert.rejects(
      readMigrations(directory),
      error => error instanceof DatabaseError && /Invalid migration filename/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
