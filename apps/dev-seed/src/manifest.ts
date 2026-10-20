import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { repositoryRoot } from './env.ts';

export type ManifestUser = { id: string; email: string; name: string; signInUrl: string };
export type ManifestWorkspace = {
  id: string;
  slug: string;
  name: string;
  url: string;
  scenario: string;
  owner: string;
  members: { email: string; role: 'admin' | 'member'; membershipId: string }[];
  teams: { id: string; name: string; managers: string[]; members: string[] }[];
  entities: Record<string, { id: string; label: string; url?: string }[]>;
  unavailable: Record<string, string>;
};
export type Manifest = {
  version: 1;
  updatedAt: string;
  webOrigin: string;
  apiOrigin: string;
  users: Record<string, ManifestUser>;
  workspaces: Record<string, ManifestWorkspace>;
};

export const manifestPath = `${repositoryRoot}.seed/manifest.json`;

export async function readManifest(webOrigin: string, apiOrigin: string): Promise<Manifest> {
  try {
    const value = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    if (value.version === 1) return { ...value, webOrigin, apiOrigin };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { version: 1, updatedAt: new Date().toISOString(), webOrigin, apiOrigin, users: {}, workspaces: {} };
}

export async function writeManifest(manifest: Manifest) {
  manifest.updatedAt = new Date().toISOString();
  await mkdir(`${repositoryRoot}.seed`, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export function recordEntity(
  workspace: ManifestWorkspace,
  kind: string,
  entity: { id: string; label: string; url?: string },
) {
  const list = (workspace.entities[kind] ??= []);
  const index = list.findIndex(item => item.id === entity.id);
  if (index === -1) list.push(entity);
  else list[index] = entity;
}
