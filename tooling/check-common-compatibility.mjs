import assert from 'node:assert/strict';
import { glob, readFile } from 'node:fs/promises';
import { workspaceTableMigrations } from '../packages/workspaces/dist/table-migrations.js';
import { commonCompatibility } from '../packages/workspaces/dist/storage.js';

const stream = await workspaceTableMigrations();
assert.equal(commonCompatibility.maximum, stream.length);
for await (const path of glob(['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'], {
  cwd: new URL('../', import.meta.url),
})) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  for (const match of source.matchAll(/minimum:\s*\d+,\s*maximum:\s*(\d+)/g))
    assert.equal(Number(match[1]), stream.length, path);
}
console.log(`Common compatibility matches ${stream.length} immutable migration receipts.`);
