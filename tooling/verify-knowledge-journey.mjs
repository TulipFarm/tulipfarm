import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, open } from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const { Connection } = require('@temporalio/client');
const binary = process.env.TEMPORAL_BINARY ?? 'temporal';
const postgres = process.env.POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@18/bin';
for (const executable of ['initdb', 'postgres']) await access(join(postgres, executable), constants.X_OK);
const directory = await mkdtemp(
  join(
    process.env.KNOWLEDGE_TEST_TMP ?? '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode',
    'knowledge-journey-',
  ),
);
const log = await open(join(directory, 'temporal.log'), 'w');
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const address = `127.0.0.1:${port}`;
const temporal = spawn(
  binary,
  [
    'server',
    'start-dev',
    '--headless',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--db-filename',
    join(directory, 'temporal.db'),
  ],
  { cwd: root, stdio: ['ignore', log.fd, log.fd] },
);
let spawnError;
temporal.on('error', error => {
  spawnError = error;
});
try {
  for (let attempt = 0; ; attempt++) {
    if (spawnError) throw spawnError;
    assert.equal(temporal.exitCode, null, `Temporal exited. Read ${directory}/temporal.log`);
    let connection;
    try {
      connection = await Connection.connect({ address, connectTimeout: 1000 });
      await connection.workflowService.describeNamespace({ namespace: 'default' });
      break;
    } catch (error) {
      if (attempt >= 60) throw error;
      await delay(200);
    } finally {
      await connection?.close();
    }
  }
  const tests = process.argv.slice(2);
  const selected = tests.length
    ? tests
    : [
        'packages/knowledge/test/storage.integration.mjs',
        'packages/knowledge/test/local.integration.mjs',
        'apps/api/test/knowledge.integration.mjs',
        'apps/api/test/knowledge-shipping.integration.mjs',
        'apps/api/test/knowledge-dispatch.integration.mjs',
        'apps/worker/test/knowledge-activities.test.mjs',
        'apps/worker/test/knowledge-temporal.integration.mjs',
        'apps/web/test/knowledge.browser.mjs',
        'apps/web/test/knowledge-live.browser.mjs',
      ];
  console.log(`Knowledge verification uses disposable native PostgreSQL and Temporal at ${address}.`);
  console.log('Files use the local signed HTTP object fixture. No R2 service or credentials are required.');
  const output = createWriteStream(join(directory, 'tests.log'));
  const child = spawn(process.execPath, ['tooling/verify-knowledge-storage.mjs', ...selected], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, POSTGRES_BIN: postgres, TEST_TEMPORAL_ADDRESS: address },
  });
  child.stdout.on('data', bytes => {
    process.stdout.write(bytes);
    output.write(bytes);
  });
  child.stderr.on('data', bytes => {
    process.stderr.write(bytes);
    output.write(bytes);
  });
  const [code, signal] = await once(child, 'exit');
  await new Promise(resolve => output.end(resolve));
  assert.equal(code, 0, `Knowledge verification failed${signal ? ` with ${signal}` : ''}`);
} finally {
  if (temporal.pid && temporal.exitCode === null && temporal.signalCode === null) {
    const stopped = once(temporal, 'exit');
    temporal.kill('SIGTERM');
    await stopped;
  }
  await log.close();
  console.log(`Stopped owned Temporal process. Logs and disposable service data retained at ${directory}.`);
}
