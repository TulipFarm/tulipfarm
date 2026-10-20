import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  ...new Set(execFileSync('git', ['ls-files', 'packages', 'apps', 'infra'], { encoding: 'utf8' }).trim().split('\n')),
];
const patch = [];
const from = process.argv.find(value => value.startsWith('--from='))?.slice(7);
const to = process.argv.find(value => value.startsWith('--to='))?.slice(5);
if (from || to) assert.ok(/^\d+$/.test(from ?? '') && /^\d+$/.test(to ?? ''), 'Use --from=<version> --to=<version>');
for (const path of files) {
  if (!/\.(ts|mjs)$/.test(path) || !/\/(src|test)\//.test(path)) continue;
  const source = readFileSync(path, 'utf8');
  const versions = from ?? '(?:62|63)';
  const changed = source
    .replace(new RegExp(`(?<=\\bmaximum\\s*:\\s*)${versions}\\b`, 'g'), to ?? '64')
    .replace(new RegExp(`(?<=assert\\.equal\\((?:[\\w.]+)\\.length,\\s*)${versions}\\b`, 'g'), to ?? '64');
  if (source === changed) continue;
  if (process.argv.includes('--write')) {
    writeFileSync(path, changed);
    continue;
  }
  patch.push(`*** Update File: ${path}`);
  const before = source.split('\n'),
    after = changed.split('\n');
  before.forEach((line, index) => {
    if (line !== after[index]) patch.push('@@', `-${line}`, `+${after[index]}`);
  });
}
if (process.argv.includes('--patch'))
  process.stdout.write(['*** Begin Patch', ...patch, '*** End Patch', ''].join('\n'));
else assert.deepEqual(patch, [], 'Current full-stream compatibility must admit the appended GitHub task receipt');
