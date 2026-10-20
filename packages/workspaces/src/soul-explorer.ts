import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { git, gitBytes, readSoulObject, seedSchema } from './soul.ts';
import {
  restoreRepository,
  validatePointer,
  type SoulPointer,
  type SoulSeed,
  type SoulStorage,
} from './soul-revisions.ts';
import {
  soulFileQuerySchema,
  soulPathSchema,
  soulPreviewBytes,
  soulSnapshotBytes,
  soulSnapshotFiles,
  soulTreeQuerySchema,
  SoulExplorerError,
  type SoulEntry,
  type SoulFile,
  type SoulRepository,
  type SoulTree,
} from './soul-explorer-contracts.ts';

const directories = new Set(['tables', 'agents', 'workflows', 'skills', 'integrations', 'roles']);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export type SoulExplorerSnapshot = {
  seed: SoulSeed;
  pointer: SoulPointer;
  files: ReadonlyMap<string, string>;
};

async function repository<T>(storage: SoulStorage, snapshot: SoulExplorerSnapshot, read: (path: string) => Promise<T>) {
  const seed = seedSchema.parse(snapshot.seed);
  const pointer = validatePointer(storage, seed, snapshot.pointer);
  const body = await readSoulObject(
    storage,
    pointer.key,
    32 * 1024 * 1024,
    pointer.sha256,
    pointer.commandSha256 ? { 'command-sha256': pointer.commandSha256 } : {},
  );
  const directory = await mkdtemp(join(tmpdir(), 'tulipfarm-soul-explorer-'));
  try {
    const path = await restoreRepository(directory, body, seed, pointer.commit, pointer.commandSha256);
    return await read(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function visibleEntries(repository: string, snapshot: SoulExplorerSnapshot) {
  const entries: SoulEntry[] = [];
  const tree = (await git(repository, ['ls-tree', '-r', '-l', '-z', snapshot.pointer.commit])).stdout;
  for (const record of tree.split('\0').filter(Boolean)) {
    const match = /^(\d+) blob [a-f0-9]{40}\s+(\d+)\t(.+)$/s.exec(record);
    if (!match || match[1] !== '100644') continue;
    const [, , length, rawPath] = match;
    const path = soulPathSchema.safeParse(rawPath);
    if (!path.success) continue;
    const size = Number(length);
    if (!Number.isSafeInteger(size)) throw new SoulExplorerError('soul-unavailable', 503);
    let allowed = snapshot.files.has(path.data);
    if (path.data === 'soul.json' && size <= 4096) {
      const content = (await git(repository, ['show', `${snapshot.pointer.commit}:soul.json`])).stdout;
      const manifest = z
        .strictObject({ ...seedSchema.shape, templateVersion: z.literal(1) })
        .safeParse(JSON.parse(content));
      allowed =
        manifest.success &&
        manifest.data.workspaceId === snapshot.seed.workspaceId &&
        manifest.data.createdBy === snapshot.seed.createdBy &&
        manifest.data.createdAt === snapshot.seed.createdAt;
    }
    if (path.data === 'skills-lock.json' && size <= 4096) {
      const content = (await git(repository, ['show', `${snapshot.pointer.commit}:skills-lock.json`])).stdout;
      allowed = z.strictObject({}).safeParse(JSON.parse(content)).success;
    }
    const [parent, name, extra] = path.data.split('/');
    if (parent && directories.has(parent) && name === '.gitkeep' && extra === undefined && size === 0) allowed = true;
    if (!allowed) continue;
    entries.push({ path: path.data, kind: 'file', size });
  }
  const parents = new Set(
    entries.flatMap(entry => {
      const parts = entry.path.split('/');
      return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    }),
  );
  entries.push(...[...parents].map(path => ({ path, kind: 'directory' as const, size: 0 })));
  return entries;
}

export async function readSoulTree(
  storage: SoulStorage,
  snapshot: SoulExplorerSnapshot,
  input: z.input<typeof soulTreeQuerySchema>,
): Promise<SoulTree> {
  const query = soulTreeQuerySchema.parse(input);
  if (query.revision && query.revision !== snapshot.pointer.commit)
    throw new SoulExplorerError('soul-revision-changed', 409);
  return repository(storage, snapshot, async path => {
    const entries = await visibleEntries(path, snapshot);
    const directory = query.directory ?? '';
    if (directory && !entries.some(entry => entry.kind === 'directory' && entry.path === directory))
      throw new SoulExplorerError('soul-not-found', 404);
    const search = query.search?.trim().toLowerCase();
    const filtered = entries.filter(entry =>
      search
        ? entry.kind === 'file' && entry.path.toLowerCase().includes(search)
        : entry.path.slice(0, entry.path.lastIndexOf('/') + 1) === (directory ? `${directory}/` : ''),
    );
    filtered.sort((a, b) =>
      a.kind === b.kind ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.kind === 'directory' ? -1 : 1,
    );
    const afterIndex = query.after ? filtered.findIndex(entry => entry.path === query.after) : -1;
    if (query.after && afterIndex < 0) throw new SoulExplorerError('soul-revision-changed', 409);
    const page = filtered.slice(afterIndex + 1, afterIndex + 102);
    return {
      revision: snapshot.pointer.commit,
      entries: page.slice(0, 100),
      nextCursor: page.length > 100 ? page[99]!.path : null,
    };
  });
}

export async function readSoulFile(
  storage: SoulStorage,
  snapshot: SoulExplorerSnapshot,
  input: z.input<typeof soulFileQuerySchema>,
): Promise<SoulFile> {
  const query = soulFileQuerySchema.parse(input);
  if (query.revision !== snapshot.pointer.commit) throw new SoulExplorerError('soul-revision-changed', 409);
  return repository(storage, snapshot, async path => {
    const entry = (await visibleEntries(path, snapshot)).find(
      entry => entry.kind === 'file' && entry.path === query.path,
    );
    if (!entry) throw new SoulExplorerError('soul-not-found', 404);
    return readEntry(path, snapshot, entry);
  });
}

async function readEntry(repository: string, snapshot: SoulExplorerSnapshot, entry: SoulEntry): Promise<SoulFile> {
  const result = { revision: snapshot.pointer.commit, path: entry.path };
  if (entry.size > soulPreviewBytes) return { ...result, kind: 'unavailable', reason: 'too-large' };
  const bytes = (await gitBytes(repository, ['show', `${snapshot.pointer.commit}:${entry.path}`])).stdout;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { ...result, kind: 'unavailable', reason: 'binary' };
  }
  if (content.includes('\0')) return { ...result, kind: 'unavailable', reason: 'binary' };
  const expected = snapshot.files.get(entry.path);
  if (expected && digest(content) !== expected) throw new SoulExplorerError('soul-unavailable', 503);
  return { ...result, kind: 'text', content };
}

export async function readSoulRepository(
  storage: SoulStorage,
  snapshot: SoulExplorerSnapshot,
): Promise<SoulRepository> {
  return repository(storage, snapshot, async path => {
    const entries = await visibleEntries(path, snapshot);
    const visibleFiles = entries.filter(entry => entry.kind === 'file');
    if (visibleFiles.length > soulSnapshotFiles) throw new SoulExplorerError('soul-snapshot-too-large', 503);
    const result: SoulRepository = { revision: snapshot.pointer.commit, entries, files: [] };
    let size = Buffer.byteLength(JSON.stringify(result));
    for (const entry of visibleFiles) {
      const file = await readEntry(path, snapshot, entry);
      size += Buffer.byteLength(JSON.stringify(file)) + (result.files.length ? 1 : 0);
      if (size > soulSnapshotBytes) throw new SoulExplorerError('soul-snapshot-too-large', 503);
      result.files.push(file);
    }
    return result;
  });
}
