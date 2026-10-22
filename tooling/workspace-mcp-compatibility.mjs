import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = '41056577';
const files = execFileSync(
  'git',
  ['ls-tree', '-r', '--name-only', baseline, 'packages', 'apps', 'infra/storage-release'],
  { cwd: root, encoding: 'utf8' },
)
  .trim()
  .split('\n');
const ceilings = /(?<=\bmaximum\s*:\s*)(?:60|61)\b/g;
const counts = /(?<=assert\.equal\((?:[\w.]+)\.length,\s*)60\b/g;
const failures = [];
const patch = [];
let inspected = 0;
for (const path of files) {
  if (!/\.(?:ts|mjs)$/.test(path) || !/(?:\/src\/|\/test\/)/.test(path)) continue;
  if (path.startsWith('apps/api/src/')) continue;
  const source = readFileSync(resolve(root, path), 'utf8');
  const changed = source
    .replace(ceilings, '62')
    .replace(counts, '62')
    .replace('common version 60', 'common version 62');
  inspected++;
  if (source === changed) continue;
  failures.push(path);
  patch.push(`*** Update File: ${path}`);
  const lines = source.split('\n');
  const next = changed.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== next[index]) patch.push('@@', `-${lines[index]}`, `+${next[index]}`);
  }
}
if (process.argv.includes('--patch')) {
  process.stdout.write(['*** Begin Patch', ...patch, '*** End Patch', ''].join('\n'));
} else {
  assert.deepEqual(failures, [], 'Pre-existing full-stream source ceilings or fixture counts remain stale');
  process.stdout.write(
    `Compatibility census passed for ${inspected} pre-existing source and test files. API source is owned separately.\n`,
  );
}
