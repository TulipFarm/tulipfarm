import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadSecretFiles, SecretFileError } from '@tulipfarm/config/secret-files';
import { z } from 'zod';
import { installExtensions } from './extensions.ts';
import { loadDatabaseExtensions, migrate } from './migrations.ts';
import { bootstrap, connect } from './postgres.ts';
import { createEmailLogin, inspectEmailLogin } from './product-release-access.ts';
import { productEmailRole, ProductReleaseError } from './product-release.ts';
import { DatabaseError } from './config.ts';
import { StorageReleaseError } from './storage-release.ts';
import {
  configureReleaseLogins,
  databaseUrl,
  ensureBucket,
  generateKeys,
  randomHex,
  releaseLoginPasswords,
  serviceEnvironments,
  writeEnvFile,
  type DatabaseEndpoint,
  type ObjectStorage,
} from './setup.ts';

const help = `Usage: pnpm self-host:setup --out DIR

Prepares an empty PostgreSQL server and S3-compatible bucket for a self-hosted
TulipFarm, then writes generated service environment files to DIR:

  api.env  worker.env  storage-worker.env  temporal.env  state.json

Safe to rerun. state.json holds every generated key and password; later runs reuse
it so encrypted data stays readable. Keep DIR private and back it up, or import the
files into your secret store and delete them. Output never prints secret values.

Environment:
  TULIPFARM_DATABASE_ADMIN_URL          Superuser URL, for example postgresql://postgres:PASSWORD@postgres:5432/postgres
                                        Query parameters such as ?sslmode=require are copied to generated URLs.
  TULIPFARM_DATABASE_HOST               Optional host:port that services use. Defaults to the admin URL host.
  TULIPFARM_OBJECT_STORAGE_ENDPOINT     S3-compatible endpoint, for example http://object-storage:9000
  TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID
  TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY
  TULIPFARM_OBJECT_STORAGE_BUCKET       Optional. Defaults to tulipfarm-soul.
  TULIPFARM_OBJECT_STORAGE_REGION       Optional. Defaults to auto.
`;

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z
  .object({
    version: z.literal(1),
    keys: z.object({ runtime: hex, migration: hex, confirmation: hex, email: hex, integration: hex }),
    roles: z.object({ owner: hex, application: hex, temporal: hex, email: hex }),
    releaseLogins: z.record(z.string(), hex),
    betterAuthSecret: hex,
  })
  .strict();
type State = z.infer<typeof stateSchema>;

const envSchema = z.object({
  TULIPFARM_DATABASE_ADMIN_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  TULIPFARM_DATABASE_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.-]+(:\d+)?$/)
    .optional(),
  TULIPFARM_OBJECT_STORAGE_ENDPOINT: z.url({ protocol: /^https?$/ }),
  TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1),
  TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  TULIPFARM_OBJECT_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('tulipfarm-soul'),
  TULIPFARM_OBJECT_STORAGE_REGION: z.string().min(1).default('auto'),
});

class SetupError extends Error {}

// Encrypted workspace credentials depend on these keys, so they are generated once and reused.
async function loadState(path: string): Promise<State> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new SetupError(`${path} is unreadable or invalid. Restore it from backup; do not delete it.`);
  }
  const state: State = {
    version: 1,
    keys: generateKeys(),
    releaseLogins: releaseLoginPasswords(),
    betterAuthSecret: randomHex(),
    roles: { owner: randomHex(), application: randomHex(), temporal: randomHex(), email: randomHex() },
  };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return state;
}

function withDatabase(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.href;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (!values.out) throw new SetupError('Set --out DIR. Run with --help for usage.');
  loadSecretFiles();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map(issue => String(issue.path[0])))].join(', ');
    throw new SetupError(`Missing or invalid environment: ${names}. Run with --help for usage.`);
  }
  const env = parsed.data;
  process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';

  const out = resolve(values.out);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const state = await loadState(join(out, 'state.json'));

  const adminUrl = env.TULIPFARM_DATABASE_ADMIN_URL;
  const admin = new URL(adminUrl);
  const endpoint: DatabaseEndpoint = {
    host: env.TULIPFARM_DATABASE_HOST ?? admin.host,
    database: 'tulipfarm',
    search: admin.search,
  };
  const objectStorage: ObjectStorage = {
    endpoint: env.TULIPFARM_OBJECT_STORAGE_ENDPOINT,
    region: env.TULIPFARM_OBJECT_STORAGE_REGION,
    bucket: env.TULIPFARM_OBJECT_STORAGE_BUCKET,
    accessKeyId: env.TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY,
  };

  step('Creating roles and databases');
  await bootstrap(adminUrl, {
    owner: state.roles.owner,
    application: state.roles.application,
    temporal: state.roles.temporal,
  });

  const appAdmin = await connect(withDatabase(adminUrl, 'tulipfarm'));
  try {
    step('Installing extensions');
    await installExtensions(appAdmin, false);
    step('Applying migrations');
    const owner = await connect(databaseUrl({ ...endpoint, host: admin.host }, 'tulipfarm_owner', state.roles.owner));
    try {
      await loadDatabaseExtensions();
      await migrate(owner, fileURLToPath(new URL('../migrations/', import.meta.url)));
    } finally {
      await owner.end();
    }
    step('Configuring isolated workspace storage logins');
    await configureReleaseLogins(appAdmin, 'tulipfarm', state.releaseLogins);
    step('Configuring the email delivery login');
    if ((await inspectEmailLogin(appAdmin)) === 'absent') await createEmailLogin(appAdmin, state.roles.email);
  } finally {
    await appAdmin.end();
  }

  const emailUrl = databaseUrl(endpoint, productEmailRole, state.roles.email);
  const email = await connect(
    databaseUrl({ ...endpoint, host: admin.host }, productEmailRole, state.roles.email),
  ).catch(() => {
    throw new SetupError(
      'The existing email delivery login does not accept the stored password. Restore state.json from backup.',
    );
  });
  await email.end();

  step('Creating the object storage bucket');
  await ensureBucket(objectStorage);

  step('Writing environment files');
  const services = serviceEnvironments({
    keys: state.keys,
    keyId: 'v1',
    passwords: state.releaseLogins,
    endpoint,
    objectStorage,
    databaseUrl: databaseUrl(endpoint, 'tulipfarm', state.roles.application),
  });
  const generator = 'pnpm self-host:setup';
  await writeEnvFile(join(out, 'api.env'), generator, { ...services.api, BETTER_AUTH_SECRET: state.betterAuthSecret });
  await writeEnvFile(join(out, 'worker.env'), generator, { ...services.worker, EMAIL_DELIVERY_DATABASE_URL: emailUrl });
  await writeEnvFile(join(out, 'storage-worker.env'), generator, services.storageWorker);
  const [temporalHost, temporalPort = '5432'] = endpoint.host.split(':');
  const tls = ['require', 'verify-ca', 'verify-full'].includes(admin.searchParams.get('sslmode') ?? '');
  await writeEnvFile(join(out, 'temporal.env'), generator, {
    DB: 'postgres12',
    DB_PORT: temporalPort,
    POSTGRES_SEEDS: temporalHost!,
    POSTGRES_USER: 'temporal',
    POSTGRES_PWD: state.roles.temporal,
    SQL_PLUGIN: 'postgres12',
    SQL_HOST: temporalHost!,
    SQL_PORT: temporalPort,
    SQL_USER: 'temporal',
    SQL_PASSWORD: state.roles.temporal,
    ...(tls
      ? { SQL_TLS: 'true', SQL_TLS_ENABLED: 'true', SQL_HOST_VERIFICATION: 'true', SQL_HOST_NAME: temporalHost! }
      : {}),
  });
  process.stdout.write(`Self-hosted storage is ready. Generated files are in ${out}.\n`);
}

function step(message: string) {
  process.stdout.write(`${message}.\n`);
}

main().catch((error: unknown) => {
  if (
    error instanceof Error &&
    [SetupError, SecretFileError, DatabaseError, ProductReleaseError, StorageReleaseError].some(
      type => error instanceof type,
    )
  )
    process.stderr.write(`${error.message}\n`);
  else {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Za-z0-9_]+$/.test(error.code)
        ? ` (${error.code})`
        : '';
    const name = error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? ` ${error.name}` : '';
    process.stderr.write(
      `Self-host setup failed${name}${code}. Check the database and object storage endpoints, then rerun; credentials were not printed.\n`,
    );
  }
  process.exitCode = 1;
});
