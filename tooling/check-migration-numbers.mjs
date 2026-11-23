#!/usr/bin/env node
// Each stream's LATEST file names its newest migration. Two pull requests that add the same number both rewrite that
// one line, so git refuses to merge the second instead of both landing.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const streams = ['apps/database/migrations', 'packages/workspace-storage/common'];

const migrationName = /^(\d{4})_[a-z0-9_]+\.sql$/;

export function migrationProblems(stream, names, latest) {
  const files = names.filter(name => name.endsWith('.sql')).sort();
  const newest = files.at(-1);
  const problems = [];
  if (newest && latest?.trim() !== newest)
    problems.push(
      `${stream}/LATEST: names ${latest?.trim() || 'nothing'}, but the newest migration is ${newest}; write ${newest} to it`,
    );
  problems.push(...files.filter(name => !migrationName.test(name)).map(name => `${stream}/${name}: invalid name`));
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

function readStream(tree, stream) {
  if (!tree) {
    const names = readdirSync(stream);
    return { names, latest: names.includes('LATEST') ? readFileSync(`${stream}/LATEST`, 'utf8') : undefined };
  }
  const names = git('ls-tree', '--name-only', `${tree}:${stream}`).split('\n').filter(Boolean);
  return { names, latest: names.includes('LATEST') ? git('show', `${tree}:${stream}/LATEST`) : undefined };
}

function main(argv) {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex === -1 ? undefined : argv[baseIndex + 1];
  if (baseIndex !== -1 && !base) throw new Error('--base needs a git ref');
  const tree = base ? mergedTree(base) : undefined;
  const problems = streams.flatMap(stream => {
    const { names, latest } = readStream(tree, stream);
    return migrationProblems(stream, names, latest);
  });
  const scope = base ? `HEAD merged into ${base}` : 'the working tree';
  if (problems.length) {
    console.error(`Migration numbers are invalid in ${scope}:`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      "Renumber the new migration to follow the highest number on main, and write its file name to the stream's LATEST.",
    );
    process.exitCode = 1;
  } else {
    console.log(`Migration numbers are valid in ${scope}.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
