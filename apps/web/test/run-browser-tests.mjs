// Runs the browser tests. Many share fixed ports and Vite's dependency cache, so they run one at a time unless
// --jobs is above 1. Then each test runs in its own Linux network namespace (unshare), where its ports cannot
// collide, with its worker's own Vite cache, and reaches TEST_ADMIN_DATABASE_URL through a forwarded socket.
// A test that fails beside others is retried, then tried once alone. A test that measures timings, or that cannot
// share the machine, opts out of running beside others with a `// browser-tests: run alone` comment.
// Usage: node test/run-browser-tests.mjs [--shard=<index>/<count>] [--jobs=<count>] [test/name.browser.mjs ...]
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const timeout = 5 * 60_000;
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
const alone = new Set(
  files.filter(file => readFileSync(`${root}/${file}`, 'utf8').includes('// browser-tests: run alone')),
);
// Seconds each test took on CI with --jobs=4, so shards get similar totals and long tests start first. A test
// that runs alone holds every worker. New tests count as the median until they are added.
const durations = JSON.parse(readFileSync(`${root}/test/browser-test-durations.json`, 'utf8'));
const known = Object.values(durations).sort((a, b) => a - b);
const duration = file => durations[file] ?? known[Math.floor(known.length / 2)] ?? 1;
const cost = file => duration(file) * (alone.has(file) ? jobs : 1);
files.sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
if (shard) {
  const [index, count] = shard.split('/').map(Number);
  if (!(index >= 1 && index <= count)) throw new Error(`Invalid shard ${shard}`);
  const totals = Array.from({ length: count }, () => 0);
  files = files.filter(file => {
    const least = totals.indexOf(Math.min(...totals));
    totals[least] += cost(file);
    return least === index - 1;
  });
}

const isolate = jobs > 1;
// Chromium reports navigator.onLine false without a non-loopback route, which disables the app's send controls.
const namespaceSetup =
  'ip link set lo up && ip link add tf0 type dummy && ip link set tf0 up && ip addr add 10.255.0.1/24 dev tf0 && ip route add default dev tf0';
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
  const probe = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'sh', '-c', namespaceSetup], {
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
      `${namespaceSetup} && exec "$@"`,
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

const queue = [...files.filter(file => alone.has(file)), ...files.filter(file => !alone.has(file))];
const failed = [];
const retried = new Set();
let finished = 0;
async function work(worker, once = false) {
  while (queue.length) {
    const file = queue.shift();
    const started = Date.now();
    const { code, output } = await run(file, worker);
    const label = `[${++finished}/${files.length}] ${file} (${Math.round((Date.now() - started) / 1000)}s)`;
    if (code === 0) {
      console.log(`ok ${label}`);
      if (retried.has(file))
        console.log(`::warning file=apps/web/${file}::${file} failed beside other tests and passed on retry`);
    } else if (isolate && !once && !retried.has(file)) {
      // Contention can push a test past its waits. Retrying it at once overlaps the retry with the other tests.
      retried.add(file);
      finished--;
      queue.unshift(file);
      console.log(`::group::FAIL, retrying ${label}\n${output}\n::endgroup::`);
    } else {
      failed.push(file);
      console.log(`::group::FAIL ${label}\n${output}\n::endgroup::`);
    }
    if (once) return;
  }
}
// Tests that run alone go first, one at a time, before the workers share the rest.
while (alone.has(queue[0])) await work(1, true);
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, (_, worker) => work(worker + 1)));
// A test that still failed gets one last try alone.
if (isolate && failed.length) {
  const retries = failed.splice(0);
  for (const file of retries) {
    const { code, output } = await run(file, 1);
    if (code === 0) console.log(`::warning file=apps/web/${file}::${file} failed beside other tests and passed alone`);
    else {
      failed.push(file);
      console.log(`::group::FAIL again alone ${file}\n${output}\n::endgroup::`);
    }
  }
}
isolation?.close();
for (const file of failed) console.log(`::error file=apps/web/${file}::${file} failed`);
if (failed.length) {
  console.log(`\n${failed.length} of ${files.length} browser tests failed:\n${failed.join('\n')}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} browser tests passed`);
