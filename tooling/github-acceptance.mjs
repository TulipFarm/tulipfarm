import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [];
for (const [directory, pattern] of [
  ['packages/github/test', /\.(test|integration)\.mjs$/],
  ['apps/api/test', /^github.*\.integration\.mjs$/],
  ['apps/worker/test', /^github.*\.integration\.mjs$/],
  ['apps/web/test', /^github.*\.browser\.mjs$/],
]) {
  for (const name of (await readdir(new URL(`../${directory}/`, import.meta.url))).sort())
    if (pattern.test(name)) suites.push(`${directory}/${name}`);
}
if (process.argv.length > 2) {
  if (process.argv.length !== 3 || process.argv[2] !== '--list') throw new Error('Only --list is supported');
  process.stdout.write(`${suites.join('\n')}\n`);
} else {
  const child = spawn(process.execPath, ['tooling/verify-task-journey.mjs', ...suites], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
}
