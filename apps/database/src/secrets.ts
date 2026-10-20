import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseError } from './config.ts';

// Production database commands read and store connection secrets through a SecretStore.
// The default store reads environment variables (database-admin-url → DATABASE_ADMIN_URL)
// and cannot write. Point TULIPFARM_DATABASE_SECRET_STORE at a module whose default export
// is a SecretStore to read and write a vault instead.
export type SecretStore = {
  read(name: string): Promise<string | undefined>;
  write(name: string, value: string): Promise<void>;
};

export const environmentSecretStore: SecretStore = {
  async read(name) {
    return process.env[name.replaceAll('-', '_').toUpperCase()] || undefined;
  },
  async write(name) {
    throw new DatabaseError(
      `Cannot store ${name}: set TULIPFARM_DATABASE_SECRET_STORE to a writable secret store module.`,
    );
  },
};

let store: Promise<SecretStore> | undefined;
export function secretStore() {
  store ??= (async () => {
    const path = process.env.TULIPFARM_DATABASE_SECRET_STORE?.trim();
    if (!path) return environmentSecretStore;
    const loaded: { default?: Partial<SecretStore> } = await import(pathToFileURL(resolve(path)).href);
    if (typeof loaded.default?.read !== 'function' || typeof loaded.default.write !== 'function') {
      throw new DatabaseError('TULIPFARM_DATABASE_SECRET_STORE must default-export { read, write }.');
    }
    return loaded.default as SecretStore;
  })();
  return store;
}

export async function optionalSecret(name: string) {
  return (await secretStore()).read(name);
}

export async function readSecret(name: string) {
  const value = await optionalSecret(name);
  if (!value) throw new DatabaseError(`Secret ${name} is unavailable.`);
  return value;
}

export async function saveSecret(name: string, value: string) {
  if ((await optionalSecret(name)) === value) return;
  await (await secretStore()).write(name, value);
}

export async function generatedPassword(name: string) {
  const existing = await optionalSecret(name);
  if (existing) return existing;
  const value = `${randomBytes(32).toString('base64url')}aA1!`;
  await (await secretStore()).write(name, value);
  return value;
}

export async function rolePasswords() {
  return {
    owner: await generatedPassword('database-owner-password'),
    application: await generatedPassword('database-password'),
    temporal: await generatedPassword('temporal-database-password'),
  };
}
