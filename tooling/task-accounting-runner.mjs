import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const directory = await mkdtemp(join(process.env.TASK_ACCOUNTING_TMP ?? tmpdir(), 'task-accounting-'));
const bin = process.env.POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@18/bin';
const temporalBin = process.env.TEMPORAL_BINARY ?? 'temporal';
async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
let output = '';
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', chunk => {
      output += chunk;
      process.stdout.write(chunk);
    });
  try {
    const [code] = await once(child, 'exit');
    return code ?? 1;
  } finally {
    clearTimeout(timer);
  }
}
let temporal,
  started = false;
try {
  assert.equal(
    await run(join(bin, 'initdb'), [
      '-D',
      join(directory, 'pg'),
      '-U',
      'postgres',
      '-A',
      'trust',
      '--encoding=UTF8',
      '--locale=C',
    ]),
    0,
  );
  const pgPort = await port(),
    temporalPort = await port();
  assert.equal(
    await run(join(bin, 'pg_ctl'), [
      '-D',
      join(directory, 'pg'),
      '-l',
      join(directory, 'pg.log'),
      '-o',
      `-h 127.0.0.1 -p ${pgPort} -k ''`,
      '-w',
      'start',
    ]),
    0,
  );
  started = true;
  temporal = spawn(
    temporalBin,
    ['server', 'start-dev', '--ip', '127.0.0.1', '--port', String(temporalPort), '--headless', '--log-level', 'error'],
    { stdio: 'ignore' },
  );
  let startError;
  temporal.once('error', error => {
    startError = error;
  });
  for (let n = 0; ; n++) {
    const ready = await new Promise(resolve => {
      const socket = connect(temporalPort, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ready) break;
    if (startError) throw startError;
    assert.ok(n < 100 && temporal.exitCode === null, 'owned Temporal starts');
    await delay(100);
  }
  const database = `postgresql://postgres@127.0.0.1:${pgPort}/postgres`;
  const files = process.argv.slice(2);
  process.exitCode = await run(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      ...(files.length
        ? files
        : [
            'packages/agents/test/task-accounting.integration.mjs',
            'packages/agents/test/task-runtime.integration.mjs',
            'packages/agents/test/task-approvals.integration.mjs',
            'packages/agents/test/tasks.integration.mjs',
            'packages/agents/test/continuity.integration.mjs',
            'packages/conversations/test/integration/credits.test.mjs',
            'apps/worker/test/credits.integration.mjs',
          ]),
    ],
    {
      ...process.env,
      TEST_ADMIN_DATABASE_URL: database,
      CONTINUITY_POSTGRES_URL: database,
      TASK_TEST_TEMPORAL_ADDRESS: `127.0.0.1:${temporalPort}`,
    },
  );
} finally {
  if (temporal?.pid && temporal.exitCode === null) {
    const stopped = once(temporal, 'exit');
    temporal.kill('SIGTERM');
    await stopped;
  }
  if (started)
    assert.equal(await run(join(bin, 'pg_ctl'), ['-D', join(directory, 'pg'), '-m', 'fast', '-w', 'stop']), 0);
  await writeFile(join(directory, 'output.log'), output);
  console.log(JSON.stringify({ artifact: join(directory, 'output.log'), cleanup: 'owned services stopped' }));
}
