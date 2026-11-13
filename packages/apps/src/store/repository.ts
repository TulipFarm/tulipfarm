import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { AppId, GitCommit } from '../ids.ts';

const execute = promisify(execFile);

/** Bucket that holds each app's source as numbered Git bundles. */
export type AppSourceStorage = { readonly client: S3Client; readonly bucket: string };

export type AppSourceBundle = {
  readonly seq: number;
  readonly baseCommit: GitCommit | null;
  readonly headCommit: GitCommit;
  readonly objectKey: string;
  readonly sha256: string;
  readonly bytes: number;
};

export const maxBundleBytes = 64 * 1024 * 1024;

const bot = { name: 'TulipFarm', email: 'system@tulipfarm.invalid' };

export async function git(directory: string, args: readonly string[], env: Record<string, string> = {}) {
  const { stdout } = await execute(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', ...args],
    {
      cwd: directory,
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
    },
  );
  return stdout.trim();
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * A local cache of app repositories. The cache is disposable: the bundles in object storage and their rows are the
 * source of truth, and any missing or stale repository is rebuilt from them.
 */
export function appRepositories(options: { readonly root: string; readonly storage: AppSourceStorage }) {
  const { root, storage } = options;
  const pathOf = (workspaceId: string, appId: AppId) => join(root, workspaceId, `${appId}.git`);

  async function contains(repository: string, commit: GitCommit) {
    return git(repository, ['cat-file', '-e', `${commit}^{commit}`]).then(
      () => true,
      () => false,
    );
  }

  async function readBundle(bundle: AppSourceBundle) {
    const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: bundle.objectKey }));
    const body = Buffer.from((await object.Body?.transformToByteArray()) ?? []);
    if (body.length !== bundle.bytes || body.length > maxBundleBytes)
      throw new Error(`Source bundle ${bundle.seq} has the wrong size`);
    if (createHash('sha256').update(body).digest('hex') !== bundle.sha256)
      throw new Error(`Source bundle ${bundle.seq} checksum mismatch`);
    return body;
  }

  /** Rebuilds the repository from its bundles in order and checks that it ends at `head`. */
  async function restore(workspaceId: string, appId: AppId, bundles: readonly AppSourceBundle[], head: GitCommit) {
    const target = pathOf(workspaceId, appId);
    await mkdir(dirname(target), { recursive: true });
    const scratch = await mkdtemp(`${target}.restore-`);
    try {
      const repository = join(scratch, 'repository.git');
      await git(scratch, ['init', '--quiet', '--bare', '--initial-branch=main', '--object-format=sha1', repository]);
      // Every bundle lands as its own pack; an automatic gc would repack them while later fetches and fsck run.
      await git(repository, ['config', 'gc.auto', '0']);
      for (const bundle of bundles.toSorted((a, b) => a.seq - b.seq)) {
        const file = join(scratch, `${bundle.seq}.bundle`);
        await writeFile(file, await readBundle(bundle));
        await git(repository, ['bundle', 'verify', '--quiet', file]);
        await git(repository, ['fetch', '--quiet', '--no-auto-gc', file, '+refs/heads/main:refs/heads/main']);
        await rm(file);
      }
      await git(repository, ['fsck', '--full', '--strict', '--no-progress']);
      const restored = await git(repository, ['rev-parse', 'refs/heads/main']);
      if (restored !== head) throw new Error(`Restored source ends at ${restored}, expected ${head}`);
      await rm(target, { recursive: true, force: true });
      await rename(repository, target);
      return target;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  return {
    pathOf,

    /** A repository holding `head`, restored from bundles when the cache lacks it. `null` head is a new empty repo. */
    async open(workspaceId: string, appId: AppId, head: GitCommit | null, bundles: readonly AppSourceBundle[]) {
      const repository = pathOf(workspaceId, appId);
      if (head === null) {
        if (!(await exists(repository))) {
          await mkdir(dirname(repository), { recursive: true });
          await git(dirname(repository), [
            'init',
            '--quiet',
            '--bare',
            '--initial-branch=main',
            '--object-format=sha1',
            repository,
          ]);
          await git(repository, ['config', 'gc.auto', '0']);
        }
        return repository;
      }
      if ((await exists(repository)) && (await contains(repository, head))) return repository;
      return restore(workspaceId, appId, bundles, head);
    },

    /**
     * Commits staged changes on top of `head` as the workspace bot with the editor as co-author, and writes the bundle
     * from `head` to the new commit. The commit lands in the cache unreferenced; only the stored bundle makes it durable.
     */
    async commit(
      repository: string,
      input: {
        readonly head: GitCommit | null;
        readonly changes: readonly { readonly path: string; readonly content: Uint8Array | null }[];
        readonly coAuthor: { readonly name: string; readonly email: string };
        readonly message: string;
      },
    ) {
      const scratch = await mkdtemp(join(dirname(repository), '.commit-'));
      try {
        // A bare repository has no work tree, which `update-index --force-remove` insists on; the scratch directory
        // stands in and is never read.
        const index = { GIT_INDEX_FILE: join(scratch, 'index'), GIT_WORK_TREE: scratch };
        if (input.head) await git(repository, ['read-tree', input.head], index);
        // Deletes go first so a file can take the place of a directory it empties; `--replace` lets a new file or
        // directory displace whatever the other occupies.
        const ordered = input.changes.toSorted((a, b) => Number(a.content !== null) - Number(b.content !== null));
        for (const change of ordered) {
          if (change.content === null) {
            await git(repository, ['update-index', '--force-remove', '--', change.path], index);
            continue;
          }
          const file = join(scratch, 'blob');
          await writeFile(file, change.content);
          const blob = await git(repository, ['hash-object', '-w', '--no-filters', file]);
          await git(
            repository,
            ['update-index', '--add', '--replace', '--cacheinfo', `100644,${blob},${change.path}`],
            index,
          );
        }
        const tree = await git(repository, ['write-tree'], index);
        const sizes = await treeSizes(repository, tree);
        const message = `${input.message}\n\nCo-authored-by: ${input.coAuthor.name} <${input.coAuthor.email}>`;
        const commit = (await git(
          repository,
          ['commit-tree', tree, ...(input.head ? ['-p', input.head] : []), '-m', message],
          {
            GIT_AUTHOR_NAME: bot.name,
            GIT_AUTHOR_EMAIL: bot.email,
            GIT_COMMITTER_NAME: bot.name,
            GIT_COMMITTER_EMAIL: bot.email,
          },
        )) as GitCommit;
        // Concurrent saves share the cache, so the bundle's `main` lives in a scratch repository borrowing the cache's
        // objects; another save can never move it between the commit and the bundle.
        const own = join(scratch, 'save.git');
        await git(scratch, ['init', '--quiet', '--bare', '--object-format=sha1', own]);
        await writeFile(join(own, 'objects', 'info', 'alternates'), `${join(repository, 'objects')}\n`);
        await git(own, ['update-ref', 'refs/heads/main', commit]);
        const file = join(scratch, 'save.bundle');
        await git(own, [
          'bundle',
          'create',
          '--quiet',
          file,
          input.head ? `${input.head}..refs/heads/main` : 'refs/heads/main',
        ]);
        return { commit, sizes, bundle: await readFile(file) };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },

    /** Stores a bundle under a key no other upload can take, so a retried save never overwrites an earlier one. */
    async upload(workspaceId: string, appId: AppId, seq: number, body: Buffer) {
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `apps/${workspaceId}/${appId}/source/${String(seq).padStart(8, '0')}-${randomUUID()}.bundle`;
      await storage.client.send(
        new PutObjectCommand({
          Bucket: storage.bucket,
          Key: objectKey,
          Body: body,
          IfNoneMatch: '*',
          ContentType: 'application/x-git-bundle',
          Metadata: { sha256 },
        }),
      );
      return { objectKey, sha256, bytes: body.length };
    },

    /** Path to size for every file at a commit, which the draft limits are checked against. */
    async tree(repository: string, commit: GitCommit | null): Promise<Map<string, number>> {
      return commit === null ? new Map() : treeSizes(repository, commit);
    },
  };
}

export type AppRepositories = ReturnType<typeof appRepositories>;

async function treeSizes(repository: string, treeish: string) {
  const listing = await git(repository, ['ls-tree', '-r', '-l', '-z', treeish]);
  const sizes = new Map<string, number>();
  for (const entry of listing.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const size = entry.slice(0, tab).trim().split(/\s+/)[3];
    sizes.set(entry.slice(tab + 1), Number(size));
  }
  return sizes;
}
