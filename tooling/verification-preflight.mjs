import { access, constants, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = new URL('../', import.meta.url);

export async function checkPrerequisites({ environment = [], executables = {}, files = [] }, env = process.env) {
  const missing = environment.filter(name => !env[name]).map(name => `Set ${name}`);
  for (const [name, path] of Object.entries(executables)) {
    if (!path) missing.push(`Set ${name}`);
    else {
      try {
        await access(path, constants.X_OK);
        if (!(await stat(path)).isFile()) throw new Error('Not a file');
      } catch {
        missing.push(`${name} must name an executable file`);
      }
    }
  }
  for (const file of files) {
    try {
      await access(new URL(file, root), constants.R_OK);
    } catch {
      missing.push(`Build or install ${file}`);
    }
  }
  if (missing.length)
    throw new Error(`Verification prerequisites:\n- ${missing.join('\n- ')}\nSee docs/verification.md`);
}

export async function taskPrerequisites(env = process.env, temporal = false) {
  await checkPrerequisites(
    {
      executables: {
        'POSTGRES_BIN/initdb': env.POSTGRES_BIN && join(env.POSTGRES_BIN, 'initdb'),
        'POSTGRES_BIN/postgres': env.POSTGRES_BIN && join(env.POSTGRES_BIN, 'postgres'),
        RUSTFS_BINARY: env.RUSTFS_BINARY,
        ...(temporal ? { TEMPORAL_BINARY: env.TEMPORAL_BINARY } : {}),
      },
      files: [
        'packages/agents/dist/tasks.js',
        'apps/worker/dist/workflows.js',
        'apps/api/dist/agent-tasks.js',
        'apps/api/dist/table-dispatch.js',
        'apps/api/dist/conversations.js',
        'apps/api/dist/auth.js',
      ],
    },
    env,
  );
  if (temporal) await browserPrerequisites();
}

async function browserPrerequisites() {
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, timeout: 10000 });
  } catch {
    throw new Error(
      'Chromium is unavailable. Install Playwright Chromium and its system dependencies; see docs/verification.md',
    );
  } finally {
    await browser?.close();
  }
}

export function localServiceUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid local URL. See docs/verification.md`);
  }
  const protocols = name === 'R2_ENDPOINT' ? ['http:', 'https:'] : ['postgres:', 'postgresql:'];
  if (url.search || !protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`${name} must point to a disposable local service. See docs/verification.md`);
  }
  return url;
}

export async function slackPrerequisites(env = process.env) {
  await checkPrerequisites(
    {
      environment: [
        'TEST_ADMIN_DATABASE_URL',
        'R2_ENDPOINT',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_SOUL_READ_ACCESS_KEY_ID',
        'R2_SOUL_READ_SECRET_ACCESS_KEY',
      ],
      executables: { TEST_TEMPORAL_CLI: env.TEST_TEMPORAL_CLI },
      files: [
        'apps/worker/dist/workflows.js',
        'apps/web/node_modules/playwright/index.mjs',
        'apps/api/dist/agents.js',
        'apps/api/dist/skills.js',
        'apps/api/dist/slack.js',
      ],
    },
    env,
  );
  for (const name of ['TEST_ADMIN_DATABASE_URL', 'R2_ENDPOINT']) {
    localServiceUrl(name, env[name]);
  }
  const bucket = env.R2_SOUL_BUCKET ?? 'tulipfarm-cloud-soul-local';
  if (bucket !== 'tulipfarm-cloud-soul-local') throw new Error('R2_SOUL_BUCKET must be tulipfarm-cloud-soul-local');
  const require = createRequire(new URL('../packages/agents/package.json', import.meta.url));
  const { Client } = require('pg');
  const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
  const database = new Client({
    connectionString: env.TEST_ADMIN_DATABASE_URL,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  const failures = [];
  try {
    await database.connect();
    await database.query('SELECT 1');
  } catch {
    failures.push('TEST_ADMIN_DATABASE_URL is not ready for authenticated queries');
  } finally {
    await database.end().catch(() => {});
  }
  for (const mode of ['write', 'read']) {
    const client = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT,
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: env[mode === 'write' ? 'R2_ACCESS_KEY_ID' : 'R2_SOUL_READ_ACCESS_KEY_ID'],
        secretAccessKey: env[mode === 'write' ? 'R2_SECRET_ACCESS_KEY' : 'R2_SOUL_READ_SECRET_ACCESS_KEY'],
      },
      requestHandler: { connectionTimeout: 3000, requestTimeout: 3000 },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(5000) });
    } catch {
      failures.push(`Local Soul bucket is unavailable with ${mode} credentials`);
    } finally {
      client.destroy();
    }
  }
  if (failures.length)
    throw new Error(`Verification prerequisites:\n- ${failures.join('\n- ')}\nSee docs/verification.md`);
  await browserPrerequisites();
}
