import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';

const entrySchema = z.strictObject({
  id: z.string().max(1024),
  name: z.string().max(512),
  title: z.string().max(512),
  description: z.string().max(16384),
  version: z.string().max(256),
  endpoint: z.string().max(4096),
  status: z.enum(['active', 'deprecated']),
  compatibility: z.enum(['unverified', 'template-required']),
  authentication: z.enum(['unknown', 'headers-required']),
});
export const publicMcpSnapshotSchema = z.strictObject({
  policyVersion: z.literal('latest-usable-v1'),
  syncedAt: z.iso.datetime(),
  entries: z.array(entrySchema).max(100000),
});
const filename = /^\d{13}-[a-f0-9]{64}\.json$/;
const maximumBytes = 64 * 1024 * 1024;

export function workspaceMcpCatalogCache(directory: string) {
  if (!isAbsolute(directory)) throw new Error('Workspace MCP catalog cache requires an absolute directory');
  async function read() {
    let names: string[];
    try {
      names = (await readdir(directory))
        .filter(name => filename.test(name))
        .sort()
        .reverse();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    for (const name of names.slice(0, 10)) {
      try {
        const file = await open(join(directory, name), 'r');
        try {
          if ((await file.stat()).size > maximumBytes) continue;
          const bytes = await file.readFile();
          if (createHash('sha256').update(bytes).digest('hex') !== name.slice(14, -5)) continue;
          return publicMcpSnapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
        } finally {
          await file.close();
        }
      } catch {
        continue;
      }
    }
    return null;
  }
  async function publish(input: z.infer<typeof publicMcpSnapshotSchema>) {
    const snapshot = publicMcpSnapshotSchema.parse(input);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > maximumBytes) throw new Error('Workspace MCP catalog cache exceeds limit');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = `${Date.parse(snapshot.syncedAt)}-${createHash('sha256').update(bytes).digest('hex')}.json`;
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, join(directory, target));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const names = (await readdir(directory))
      .filter(name => filename.test(name))
      .sort()
      .reverse();
    for (const name of names.slice(3)) await unlink(join(directory, name)).catch(() => undefined);
  }
  return { read, publish };
}
