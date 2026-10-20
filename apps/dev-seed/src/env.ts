import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const envFiles = ['apps/api/.env.local', 'apps/worker/.env.storage.local', 'apps/worker/.env.local'];
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class SeedRefused extends Error {}

export function assertLoopback(key: string, value: string) {
  if (!loopback.has(new URL(value).hostname))
    throw new SeedRefused(`Refusing to seed: ${key} does not point at a loopback host.`);
}

// Seeding writes real identities and workspaces, so it only ever targets the local `pnpm dev` stack.
export function assertLocalTarget(env: NodeJS.ProcessEnv = process.env, root = repositoryRoot) {
  if (env.NODE_ENV === 'production') throw new SeedRefused('Refusing to seed with NODE_ENV=production.');
  if (!existsSync(`${root}.env.dev-setup.json`))
    throw new SeedRefused('Missing .env.dev-setup.json. Run `pnpm dev:setup` first (see docs/mock-data.md).');
  for (const key of [
    'DATABASE_URL',
    'WORKSPACE_PROVISIONING_DATABASE_URL',
    'WORKSPACE_DATABASE_ENDPOINT',
    'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
  ]) {
    const value = env[key];
    if (!value) throw new SeedRefused(`Missing ${key}. Run \`pnpm dev:setup\` first (see docs/mock-data.md).`);
    assertLoopback(key, value);
  }
  if (env.WORKSPACE_STORAGE_CAPABILITY !== 'isolated-v1')
    throw new SeedRefused('Seeding requires WORKSPACE_STORAGE_CAPABILITY=isolated-v1 from pnpm dev:setup.');
}

export function loadLocalEnv(root = repositoryRoot) {
  for (const file of envFiles) if (existsSync(`${root}${file}`)) process.loadEnvFile(`${root}${file}`);
  assertLocalTarget(process.env, root);
}

export const webOrigin = () => new URL(process.env.WEB_ORIGIN ?? 'http://localhost:5173').origin;
export const apiOrigin = () => new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3001').origin;
