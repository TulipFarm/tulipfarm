import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  BucketAlreadyOwnedByYou,
  BucketAlreadyExists,
  CreateBucketCommand,
  HeadBucketCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import { escapeIdentifier, type Client } from 'pg';
import { configureStorageReleaseLogin } from './storage-release-production.ts';
import { releaseLogins } from './storage-release.ts';

// Shared by pnpm dev:setup and pnpm self-host:setup. Both generate the same service
// environment shape; only endpoints, credentials, and output locations differ.

export type SetupKeys = Record<'runtime' | 'migration' | 'confirmation' | 'email' | 'integration', string>;
// Endpoint and keys are optional so AWS S3 can use its regional endpoint and a task role.
export type ObjectStorage = {
  endpoint?: string | undefined;
  region?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  soulBucket: string;
  filesBucket?: string | undefined;
};
export type DatabaseEndpoint = { host: string; database: string; search: string };

export const randomHex = () => randomBytes(32).toString('hex');
export const generateKeys = (): SetupKeys => ({
  runtime: randomHex(),
  migration: randomHex(),
  confirmation: randomHex(),
  email: randomHex(),
  integration: randomHex(),
});
export const releaseLoginPasswords = () => Object.fromEntries(releaseLogins.map(login => [login.role, randomHex()]));

export function databaseUrl(endpoint: DatabaseEndpoint, role: string, password: string) {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${endpoint.host}/${endpoint.database}${endpoint.search}`;
}

function releaseLoginUrl(
  endpoint: DatabaseEndpoint,
  passwords: Record<string, string>,
  capability: (typeof releaseLogins)[number]['capability'],
) {
  const { role } = releaseLogins.find(login => login.capability === capability)!;
  return databaseUrl(endpoint, role, passwords[role]!);
}

// Production revokes PUBLIC database access at bootstrap; the release login checks require the same.
export async function configureReleaseLogins(admin: Client, database: string, passwords: Record<string, string>) {
  await admin.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(database)} FROM PUBLIC`);
  for (const login of releaseLogins) await configureStorageReleaseLogin(admin, login, passwords[login.role]!);
}

function connection(storage: ObjectStorage): Record<string, string> {
  const values = {
    TULIPFARM_OBJECT_STORAGE_ENDPOINT: storage.endpoint,
    TULIPFARM_OBJECT_STORAGE_REGION: storage.region,
    TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID: storage.accessKeyId,
    TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY: storage.secretAccessKey,
  };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

// Checks first so deployments whose buckets are managed elsewhere need no CreateBucket permission.
export async function ensureBuckets(storage: ObjectStorage) {
  const s3 = objectStorageClient(connection(storage));
  try {
    for (const Bucket of [storage.soulBucket, storage.filesBucket]) {
      if (!Bucket) continue;
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
        continue;
      } catch (error) {
        if (!(error instanceof NotFound)) throw error;
      }
      try {
        await s3.send(new CreateBucketCommand({ Bucket }));
      } catch (error) {
        if (!(error instanceof BucketAlreadyOwnedByYou || error instanceof BucketAlreadyExists)) throw error;
      }
    }
  } finally {
    s3.destroy();
  }
}

export function serviceEnvironments(input: {
  keys: SetupKeys;
  keyId: string;
  passwords: Record<string, string>;
  endpoint: DatabaseEndpoint;
  databaseUrl: string;
  objectStorage: ObjectStorage;
}) {
  const { keys, keyId, passwords, endpoint, objectStorage } = input;
  const key = (name: string, value: string) => ({ [`${name}_KEY_ID`]: keyId, [`${name}_KEY`]: value });
  const shared = {
    WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
    ...key('WORKSPACE_RUNTIME', keys.runtime),
    ...key('EMAIL_DELIVERY', keys.email),
    ...key('INTEGRATION_CREDENTIAL', keys.integration),
    ...connection(objectStorage),
    TULIPFARM_OBJECT_STORAGE_SOUL_BUCKET: objectStorage.soulBucket,
  };
  const files = objectStorage.filesBucket ? { TULIPFARM_OBJECT_STORAGE_FILES_BUCKET: objectStorage.filesBucket } : {};
  return {
    api: {
      ...shared,
      DATABASE_URL: input.databaseUrl,
      ...key('WORKSPACE_CONFIRMATION', keys.confirmation),
      WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL: releaseLoginUrl(endpoint, passwords, 'confirmation'),
      ...files,
    },
    worker: {
      ...shared,
      ...files,
      WORKSPACE_AUTHORING_DATABASE_URL: releaseLoginUrl(endpoint, passwords, 'authoring'),
    },
    storageWorker: {
      ...shared,
      ...key('WORKSPACE_MIGRATION', keys.migration),
      ...key('WORKSPACE_CONFIRMATION', keys.confirmation),
      WORKSPACE_PROVISIONING_DATABASE_URL: releaseLoginUrl(endpoint, passwords, 'provisioning'),
      WORKSPACE_DATABASE_ENDPOINT: `postgresql://${endpoint.host}/${endpoint.database}${endpoint.search}`,
      WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL: releaseLoginUrl(endpoint, passwords, 'migration'),
    },
  };
}

export async function writeEnvFile(path: URL | string, generator: string, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${name} must be a single line.`);
  }
  const body = Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  await writeFile(path, `# Generated by ${generator}.\n${body}\n`, { mode: 0o600 });
}
