import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/knowledge/package.json', import.meta.url));
const { Client } = require('pg');
const root = process.env.KNOWLEDGE_TEST_TMP ?? tmpdir();
const binaries = process.env.POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@18/bin';
const directory = await mkdtemp(join(root, 'knowledge-p0-'));
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${command} failed`);
}
const server = createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
let postgres;
try {
  await run(join(binaries, 'initdb'), [
    '-D',
    join(directory, 'data'),
    '-U',
    'postgres',
    '-A',
    'trust',
    '--encoding=UTF8',
    '--locale=C',
  ]);
  postgres = spawn(
    join(binaries, 'postgres'),
    ['-D', join(directory, 'data'), '-h', '127.0.0.1', '-p', String(port), '-k', ''],
    { stdio: 'ignore' },
  );
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  for (let attempt = 0; ; attempt++) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      break;
    } catch (error) {
      if (attempt >= 100 || postgres.exitCode !== null) throw error;
      await delay(100);
    } finally {
      await client.end();
    }
  }
  const tests = process.argv.length > 2 ? process.argv.slice(2) : ['packages/knowledge/test/storage.integration.mjs'];
  await run(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
    ...process.env,
    TEST_ADMIN_DATABASE_URL: url,
  });
} finally {
  if (postgres && postgres.exitCode === null) {
    const stopped = once(postgres, 'exit');
    postgres.kill('SIGTERM');
    await stopped;
  }
  if (process.env.KEEP_TEST_ARTIFACTS === '1')
    console.log(`Stopped disposable PostgreSQL. Cluster retained at ${directory}.`);
  else await rm(directory, { recursive: true, force: true });
}
