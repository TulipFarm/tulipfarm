#!/usr/bin/env node
// Checks that each migration stream is numbered 0001, 0002, ... with no duplicates or gaps.
// With --base <ref>, it checks the tree that merging HEAD into <ref> would produce, so a pull
// request is checked against the latest main rather than the main it branched from.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const streams = ['apps/database/migrations', 'packages/workspace-storage/common'];

const migrationName = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Returns one message per problem in a stream's file names; an empty list means the stream is valid. */
export function migrationProblems(stream, names) {
  const files = names.filter(name => name.endsWith('.sql')).sort();
  const problems = files.filter(name => !migrationName.test(name)).map(name => `${stream}/${name}: invalid name`);
  const byNumber = Map.groupBy(
    files.filter(name => migrationName.test(name)),
    name => Number(name.slice(0, 4)),
  );
  for (const [number, group] of byNumber) {
    if (group.length > 1) problems.push(`${stream}: ${group.join(' and ')} share number ${number}`);
  }
  const highest = Math.max(0, ...byNumber.keys());
  for (let number = 1; number <= highest; number++) {
    if (!byNumber.has(number)) problems.push(`${stream}: number ${String(number).padStart(4, '0')} is missing`);
  }
  return problems;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function mergedTree(base) {
  try {
    return git('merge-tree', '--write-tree', '--no-messages', base, 'HEAD').split('\n')[0];
  } catch (error) {
    // Exit status 1 means the merge has conflicts; the first line is still the merged tree.
    if (error.status === 1 && error.stdout) return error.stdout.split('\n')[0];
    throw error;
  }
}

function listStream(tree, stream) {
  return git('ls-tree', '--name-only', `${tree}:${stream}`).split('\n').filter(Boolean);
}

function main(argv) {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex === -1 ? undefined : argv[baseIndex + 1];
  if (baseIndex !== -1 && !base) throw new Error('--base needs a git ref');
  const tree = base ? mergedTree(base) : 'HEAD';
  const problems = streams.flatMap(stream => migrationProblems(stream, listStream(tree, stream)));
  const scope = base ? `HEAD merged into ${base}` : 'HEAD';
  if (problems.length) {
    console.error(`Migration numbers are invalid in ${scope}:`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('Renumber the new migration to follow the highest number on main.');
    process.exitCode = 1;
  } else {
    console.log(`Migration numbers are valid in ${scope}.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
