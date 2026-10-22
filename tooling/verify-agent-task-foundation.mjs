import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { taskPrerequisites } from './verification-preflight.mjs';

await taskPrerequisites();
const require = createRequire(new URL('../packages/agents/package.json', import.meta.url));
const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { Client } = require('pg');
const directory = await mkdtemp(join(tmpdir(), 'agent-task-foundation-'));
const database = join(directory, 'postgres'),
  objects = join(directory, 'objects');
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${command} failed`);
}
let postgres, rustfs, client;
try {
  await run(join(process.env.POSTGRES_BIN, 'initdb'), [
    '-D',
    database,
    '-U',
    'postgres',
    '-A',
    'trust',
    '--encoding=UTF8',
    '--locale=C',
  ]);
  const pgPort = await freePort(),
    objectPort = await freePort();
  postgres = spawn(
    join(process.env.POSTGRES_BIN, 'postgres'),
    ['-D', database, '-h', '127.0.0.1', '-p', String(pgPort), '-k', directory],
    { stdio: 'ignore' },
  );
  const accessKeyId = randomUUID(),
    secretAccessKey = randomUUID(),
    bucket = 'tulipfarm-cloud-soul-local';
  await mkdir(objects);
  rustfs = spawn(process.env.RUSTFS_BINARY, ['server', '--address', `127.0.0.1:${objectPort}`, objects], {
    env: {
      ...process.env,
      RUSTFS_ACCESS_KEY: accessKeyId,
      RUSTFS_SECRET_KEY: secretAccessKey,
      RUSTFS_CONSOLE_ENABLE: 'false',
    },
    stdio: 'ignore',
  });
  const endpoint = `http://127.0.0.1:${objectPort}`;
  client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      break;
    } catch (error) {
      if (attempt >= 100 || rustfs.exitCode !== null) throw error;
      await delay(100);
    }
  }
  const env = {
    ...process.env,
    TEST_ADMIN_DATABASE_URL: `postgres://postgres@127.0.0.1:${pgPort}/postgres`,
    R2_ENDPOINT: endpoint,
    R2_SOUL_BUCKET: bucket,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  };
  for (let attempt = 0; ; attempt++) {
    const connection = new Client({ connectionString: env.TEST_ADMIN_DATABASE_URL, connectionTimeoutMillis: 1000 });
    try {
      await connection.connect();
      await connection.query('SELECT 1');
      break;
    } catch (error) {
      if (attempt >= 100 || postgres.exitCode !== null) throw error;
      await delay(100);
    } finally {
      await connection.end();
    }
  }
  await run(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      ...(process.argv.length > 2
        ? process.argv.slice(2)
        : [
            'packages/agents/test/tasks.integration.mjs',
            'apps/api/test/agent-tasks.integration.mjs',
            'packages/agents/test/run-skills.integration.mjs',
            'packages/agents/test/workspace-skills.integration.mjs',
            'packages/conversations/test/integration/*.test.mjs',
            'apps/api/test/skills.integration.mjs',
            'apps/api/test/slack-intake.integration.mjs',
            'packages/atlassian/test/accounts.integration.mjs',
          ]),
    ],
    env,
  );
} finally {
  client?.destroy();
  for (const child of [rustfs, postgres])
    if (child && child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
  await rm(directory, { recursive: true, force: true });
}
