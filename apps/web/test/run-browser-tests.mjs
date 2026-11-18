// Runs the browser tests. Many share fixed ports and Vite's dependency cache, so they run one at a time unless
// --jobs is above 1. Then each test runs in its own Linux network namespace (unshare), where its ports cannot
// collide, with its worker's own Vite cache, and reaches TEST_ADMIN_DATABASE_URL through a forwarded socket.
// Usage: node test/run-browser-tests.mjs [--shard=<index>/<count>] [--jobs=<count>] [test/name.browser.mjs ...]
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const timeout = 10 * 60_000;
const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const shard = option('shard');
const jobs = Number(option('jobs') ?? 1);
if (!(Number.isInteger(jobs) && jobs >= 1)) throw new Error(`Invalid --jobs=${option('jobs')}`);
let files = args.filter(arg => !arg.startsWith('--'));
if (!files.length)
  files = readdirSync(`${root}/test`)
    .filter(name => name.endsWith('.browser.mjs'))
    .sort()
    .map(name => `test/${name}`);
if (shard) {
  const [index, count] = shard.split('/').map(Number);
  if (!(index >= 1 && index <= count)) throw new Error(`Invalid shard ${shard}`);
  files = files.filter((_, position) => position % count === index - 1);
}

const isolate = jobs > 1;
const isolation = isolate ? await isolatedNetwork() : undefined;

const children = new Set();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const pid of children) killGroup(pid);
    isolation?.close();
    process.exit(1);
  });

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}

// Checks that unprivileged network namespaces work, and forwards the test database into them.
async function isolatedNetwork() {
  const probe = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'sh', '-c', 'ip link set lo up'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0)
    throw new Error(
      `--jobs needs unprivileged network namespaces (Linux unshare and ip): ${probe.error ?? probe.stderr}`,
    );
  const env = {};
  let server;
  const database = process.env.TEST_ADMIN_DATABASE_URL && new URL(process.env.TEST_ADMIN_DATABASE_URL);
  if (database) {
    const socket = join(tmpdir(), `tulipfarm-browser-db-${process.pid}.sock`);
    rmSync(socket, { force: true });
    const port = Number(database.port || 5432);
    server = createServer(client => {
      const upstream = createConnection(port, database.hostname);
      client.pipe(upstream).pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve));
    server.unref();
    Object.assign(env, { TULIPFARM_TEST_DATABASE_SOCKET: socket, TULIPFARM_TEST_DATABASE_PORT: String(port) });
  }
  return {
    env,
    close: () => server?.close(),
  };
}

function run(file, worker) {
  const usesTestRunner = readFileSync(`${root}/${file}`, 'utf8').includes("from 'node:test'");
  let command = [process.execPath, ...(usesTestRunner ? ['--test', '--test-concurrency=1'] : []), file];
  let env = process.env;
  if (isolate) {
    command = [
      'unshare',
      '--user',
      '--map-root-user',
      '--net',
      'sh',
      '-c',
      'ip link set lo up && exec "$@"',
      'sh',
      command[0],
      '--import',
      './test/isolated-network.mjs',
      ...command.slice(1),
    ];
    env = { ...env, ...isolation.env, TULIPFARM_VITE_CACHE_DIR: `node_modules/.vite-browser-${worker}` };
  }
  return new Promise(resolve => {
    const output = [];
    // Each test gets its own process group so its Vite servers and browsers stop with it.
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
let next = 0;
let finished = 0;
async function work(worker) {
  while (next < files.length) {
    const file = files[next++];
    const started = Date.now();
    const { code, output } = await run(file, worker);
    const label = `[${++finished}/${files.length}] ${file} (${Math.round((Date.now() - started) / 1000)}s)`;
    if (code === 0) console.log(`ok ${label}`);
    else {
      failed.push(file);
      console.log(`::group::FAIL ${label}\n${output}\n::endgroup::`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, (_, worker) => work(worker + 1)));
isolation?.close();
if (failed.length) {
  console.log(`\n${failed.length} of ${files.length} browser tests failed:\n${failed.join('\n')}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} browser tests passed`);
