// Runs the browser tests one at a time, since many share Vite's dependency cache and fixed ports.
// Usage: node test/run-browser-tests.mjs [--shard=<index>/<count>] [test/name.browser.mjs ...]
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const timeout = 10 * 60_000;
const args = process.argv.slice(2);
const shard = args.find(arg => arg.startsWith('--shard='));
let files = args.filter(arg => !arg.startsWith('--'));
if (!files.length)
  files = readdirSync(`${root}/test`)
    .filter(name => name.endsWith('.browser.mjs'))
    .sort()
    .map(name => `test/${name}`);
if (shard) {
  const [index, count] = shard.slice('--shard='.length).split('/').map(Number);
  if (!(index >= 1 && index <= count)) throw new Error(`Invalid shard ${shard}`);
  files = files.filter((_, position) => position % count === index - 1);
}

const children = new Set();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const pid of children) killGroup(pid);
    process.exit(1);
  });

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}

function run(file) {
  const usesTestRunner = readFileSync(`${root}/${file}`, 'utf8').includes("from 'node:test'");
  const command = usesTestRunner ? ['--test', '--test-concurrency=1', file] : [file];
  return new Promise(resolve => {
    const output = [];
    // Each test gets its own process group so its Vite servers and browsers stop with it.
    const child = spawn(process.execPath, command, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child.pid);
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => output.push(chunk));
    const timer = setTimeout(() => {
      output.push(Buffer.from(`\nTimed out after ${timeout / 1000}s\n`));
      killGroup(child.pid);
    }, timeout);
    child.on('close', code => {
      clearTimeout(timer);
      children.delete(child.pid);
      killGroup(child.pid);
      resolve({ code, output: Buffer.concat(output).toString() });
    });
  });
}

const failed = [];
for (const [position, file] of files.entries()) {
  const started = Date.now();
  const { code, output } = await run(file);
  const label = `[${position + 1}/${files.length}] ${file} (${Math.round((Date.now() - started) / 1000)}s)`;
  if (code === 0) console.log(`ok ${label}`);
  else {
    failed.push(file);
    console.log(`::group::FAIL ${label}\n${output}\n::endgroup::`);
  }
}
if (failed.length) {
  console.log(`\n${failed.length} of ${files.length} browser tests failed:\n${failed.join('\n')}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} browser tests passed`);
