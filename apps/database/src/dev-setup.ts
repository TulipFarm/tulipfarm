import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadSecretFiles } from '@tulipfarm/config/secret-files';
import { loadDatabaseExtensions, migrate } from './migrations.ts';
import { connect } from './postgres.ts';
import { installExtensions } from './extensions.ts';
import {
  configureReleaseLogins,
  ensureBuckets,
  generateKeys,
  releaseLoginPasswords,
  serviceEnvironments,
  writeEnvFile,
  type SetupKeys,
} from './setup.ts';

const root = new URL('../../../', import.meta.url);
const host = '127.0.0.1:5432';
const objectStorage = {
  endpoint: 'http://127.0.0.1:9000',
  region: 'auto',
  accessKeyId: 'local-object-storage',
  secretAccessKey: 'local-object-storage-secret',
  soulBucket: 'tulipfarm-cloud-soul-local',
  filesBucket: 'tulipfarm-files-local',
};

// Matches the keep service in compose.yaml. Local development only.
const keep = { KEEP_ENDPOINT: 'http://127.0.0.1:7357', KEEP_TOKEN: 'local-keep-token' };

// Matches apps/browser-host's local .env.local below. Local development only.
const browserHost = {
  BROWSER_HOST_ENDPOINT: 'http://127.0.0.1:3010',
  BROWSER_HOST_TOKEN: 'local-browser-host-token-not-a-secret',
};

type State = { keys: SetupKeys; passwords: Record<string, string> };

// Encrypted workspace credentials depend on these keys, so they are generated once and reused.
async function loadState(): Promise<State> {
  const path = new URL('.env.dev-setup.json', root);
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as State & { keys: { connection?: string } }; // pre-rename state file
    if (!state.keys.connection) return state; // pre-rename
    // Local credentials were encrypted with this key before the integrations rename; keep it under its new name.
    const { connection, ...keys } = state.keys; // pre-rename
    const migrated = { ...state, keys: { ...keys, integration: keys.integration ?? connection } }; // pre-rename
    await writeFile(path, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const state: State = { keys: generateKeys(), passwords: releaseLoginPasswords() };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

async function main() {
  loadSecretFiles();
  process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
  const state = await loadState();

  const owner = await connect(`postgresql://tulipfarm:local-tulipfarm@${host}/tulipfarm`);
  try {
    await loadDatabaseExtensions();
    await migrate(owner, fileURLToPath(new URL('../migrations/', import.meta.url)));
  } finally {
    await owner.end();
  }

  const admin = await connect(`postgresql://postgres:local-postgres@${host}/tulipfarm`);
  try {
    await installExtensions(admin, false);
    await configureReleaseLogins(admin, 'tulipfarm', state.passwords);
  } finally {
    await admin.end();
  }

  await ensureBuckets(objectStorage);

  const env = serviceEnvironments({
    keys: state.keys,
    keyId: 'local-v1',
    passwords: state.passwords,
    endpoint: { host, database: 'tulipfarm', search: '' },
    databaseUrl: `postgresql://tulipfarm:local-tulipfarm@${host}/tulipfarm`,
    objectStorage,
  });
  const write = (path: string, values: Record<string, string>) =>
    writeEnvFile(new URL(path, root), 'pnpm dev:setup', values);
  const connections = Object.fromEntries(
    [
      'TEMPORAL_ADDRESS',
      'TEMPORAL_NAMESPACE',
      'TEMPORAL_TLS',
      'TEMPORAL_API_KEY',
      'HUNTSMAN_ENDPOINT',
      'HUNTSMAN_TOKEN',
      'SEARXNG_ENDPOINT',
      'SEARXNG_TOKEN',
      'BROWSER_HOST_ENDPOINT',
      'BROWSER_HOST_TOKEN',
      'KEEP_ENDPOINT',
      'KEEP_TOKEN',
    ]
      .filter(name => process.env[name] !== undefined)
      .map(name => [name, process.env[name]!]),
  );
  await write('apps/api/.env.local', { ...env.api, ...keep, ...browserHost, ...connections });
  await write('apps/worker/.env.local', {
    ...env.worker,
    ...keep,
    ...browserHost,
    ...connections,
  });
  await write('apps/browser-host/.env.local', {
    BROWSER_HOST_TOKEN: browserHost.BROWSER_HOST_TOKEN,
    ...Object.fromEntries(
      ['CHROMIUM_EXECUTABLE_PATH', 'BROWSER_HOST_ALLOW_PRIVATE_NETWORKS']
        .filter(name => process.env[name] !== undefined)
        .map(name => [name, process.env[name]!]),
    ),
  });
  await write('apps/render-worker/.env.local', {
    ...env.renderWorker,
    ...Object.fromEntries(Object.entries(connections).filter(([name]) => name.startsWith('TEMPORAL_'))),
  });
  await write('apps/worker/.env.storage.local', {
    ...env.storageWorker,
    ...Object.fromEntries(Object.entries(connections).filter(([name]) => name.startsWith('TEMPORAL_'))),
  });
  process.stdout.write('Local isolated storage is ready.\n');
}

await main();
