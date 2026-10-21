import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the core SQL fence rejects statements but permits opaque storage ports and host SQL', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tulip-memory-storage-lint-'));
  try {
    const config = JSON.parse(await readFile(path.join(root, '.oxlintrc.json'), 'utf8'));
    config.jsPlugins = [
      fileURLToPath(import.meta.resolve('@shadcn/lint')),
      path.join(root, 'tooling/design-system-lint.mjs'),
    ];
    await writeFile(path.join(directory, '.oxlintrc.json'), JSON.stringify(config));
    for (const [name, source, rejected] of [
      ['select', 'export const value = "SELECT * FROM records";', true],
      ['insert', 'export const value = "INSERT INTO records VALUES ($1)";', true],
      ['update', 'export const value = "UPDATE records SET state=$1";', true],
      ['delete', 'export const value = "DELETE FROM records";', true],
      ['cte', 'export const value = `WITH rows AS (SELECT 1) SELECT * FROM rows`;', true],
      ['template', 'export const value = name => `SELECT * FROM ${name}`;', true],
      ['ddl', 'export const value = "CREATE TABLE records (id text)";', true],
      ['qualify', 'export const value = tx => qualified(tx.schema, "records");', true],
      ['port', 'export const value = (repository, id) => repository.readDocument([id]);', false],
      ['label', 'export const value = "document";', false],
    ]) {
      const filename = path.join(directory, 'packages/memory-core/src', `${name}.ts`);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, source);
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, 'node_modules/oxlint/bin/oxlint'),
          '--config',
          path.join(directory, '.oxlintrc.json'),
          filename,
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      assert.equal(result.status, rejected ? 1 : 0, `${name}: ${result.stdout}${result.stderr}`);
      if (rejected) assert.match(result.stdout + result.stderr, /memory-core-boundary/);
    }
    const host = path.join(directory, 'packages/memory-postgres/src/host.ts');
    await mkdir(path.dirname(host), { recursive: true });
    await writeFile(host, 'export const value = "SELECT * FROM records";');
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'node_modules/oxlint/bin/oxlint'), '--config', path.join(directory, '.oxlintrc.json'), host],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
