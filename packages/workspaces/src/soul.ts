import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { objectStorageClient } from './object-storage.ts';

const execute = promisify(execFile);
export const soulUuidSchema = z.uuid().toLowerCase();
export const seedSchema = z.object({
  workspaceId: soulUuidSchema,
  createdBy: soulUuidSchema,
  createdAt: z.iso.datetime(),
});
type Seed = z.infer<typeof seedSchema>;
const manifestSchema = seedSchema.extend({ templateVersion: z.literal(1) });

function gitOptions(directory: string, seed?: Seed) {
  return {
    cwd: directory,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...(seed
        ? {
            GIT_AUTHOR_NAME: 'TulipFarm',
            GIT_AUTHOR_EMAIL: 'system@tulipfarm.invalid',
            GIT_COMMITTER_NAME: 'TulipFarm',
            GIT_COMMITTER_EMAIL: 'system@tulipfarm.invalid',
            GIT_AUTHOR_DATE: seed.createdAt,
            GIT_COMMITTER_DATE: seed.createdAt,
          }
        : {}),
    },
  };
}

const gitArguments = (args: string[]) => ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args];
export async function git(directory: string, args: string[], seed?: Seed, input?: string) {
  const command = execute('git', gitArguments(args), gitOptions(directory, seed));
  if (input === undefined) return command;
  const stdin = command.child.stdin;
  if (!stdin) {
    command.child.kill();
    await command.catch(() => undefined);
    throw new Error('Git input pipe is unavailable');
  }
  const [result] = await Promise.all([command, pipeline([input], stdin)]);
  return result;
}

export function gitBytes(directory: string, args: string[]) {
  return execute('git', gitArguments(args), { ...gitOptions(directory), encoding: 'buffer' });
}

export async function verifySoulRepository(repository: string, seed: Seed) {
  await git(repository, ['fsck', '--full', '--strict']);
  const manifest = manifestSchema.parse(
    JSON.parse((await git(repository, ['show', 'refs/heads/main:soul.json'])).stdout),
  );
  if (
    manifest.workspaceId !== seed.workspaceId ||
    manifest.createdBy !== seed.createdBy ||
    manifest.createdAt !== seed.createdAt
  ) {
    throw new Error('Stored Soul belongs to a different workspace creation');
  }
  return (await git(repository, ['rev-parse', 'refs/heads/main'])).stdout.trim();
}

export async function createStarterBundle(input: Seed) {
  const seed = seedSchema.parse(input);
  const directory = await mkdtemp(join(tmpdir(), 'tulipfarm-soul-'));
  try {
    const repository = join(directory, 'repository');
    await mkdir(repository);
    await git(repository, ['init', '--initial-branch=main', '--object-format=sha1']);
    await writeFile(join(repository, 'soul.json'), `${JSON.stringify({ templateVersion: 1, ...seed }, null, 2)}\n`);
    await writeFile(join(repository, 'skills-lock.json'), '{}\n');
    for (const name of ['tables', 'workflows', 'agents', 'skills', 'integrations', 'roles']) {
      await mkdir(join(repository, name));
      await writeFile(join(repository, name, '.gitkeep'), '');
    }
    await git(repository, ['add', '--all']);
    await git(
      repository,
      [
        'commit',
        '-m',
        `Initialize workspace Soul\n\nCreated-by: ${seed.createdBy}\nWorkspace: ${seed.workspaceId}\nTemplate-version: 1`,
      ],
      seed,
    );
    const commit = (await git(repository, ['rev-parse', 'HEAD'])).stdout.trim();
    const bundlePath = join(directory, 'starter.bundle');
    await git(repository, ['bundle', 'create', bundlePath, '--all']);
    return { commit, body: await readFile(bundlePath) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyStarterBundle(body: Uint8Array, input: Seed) {
  const seed = seedSchema.parse(input);
  const directory = await mkdtemp(join(tmpdir(), 'tulipfarm-soul-verify-'));
  try {
    await writeFile(join(directory, 'starter.bundle'), body);
    await git(directory, ['clone', '--bare', 'starter.bundle', 'repository']);
    const repository = join(directory, 'repository');
    return await verifySoulRepository(repository, seed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function soulStorageConfig(mode: 'write' | 'read' = 'write', env: NodeJS.ProcessEnv = process.env) {
  const requestHandler = { connectionTimeout: 5000, requestTimeout: 30000 };
  const bucket = env.TULIPFARM_OBJECT_STORAGE_SOUL_BUCKET;
  if (bucket) return { bucket, client: objectStorageClient(env, { requestHandler }) };
  const accessKeyId = env[mode === 'read' ? 'R2_SOUL_READ_ACCESS_KEY_ID' : 'R2_ACCESS_KEY_ID'];
  const secretAccessKey = env[mode === 'read' ? 'R2_SOUL_READ_SECRET_ACCESS_KEY' : 'R2_SECRET_ACCESS_KEY'];
  if (!accessKeyId || !secretAccessKey) throw new Error(`Soul ${mode} credentials are required`);
  return {
    bucket: env.R2_SOUL_BUCKET ?? `tulipfarm-cloud-soul-${env.NODE_ENV === 'production' ? 'production' : 'local'}`,
    client: new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT ?? 'https://8814d00cb5fea3365054df9cee16776b.r2.cloudflarestorage.com',
      forcePathStyle: Boolean(env.R2_ENDPOINT),
      credentials: { accessKeyId, secretAccessKey },
      requestHandler,
    }),
  };
}

export async function readSoulObject(
  storage: { client: S3Client; bucket: string },
  key: string,
  maxBytes: number,
  expectedDigest?: string,
  expectedMetadata: Record<string, string> = {},
) {
  const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  if (!object.Body) throw new Error('Invalid Soul object size');
  const stream = object.Body.transformToWebStream();
  const declaredLength = object.ContentLength;
  if (
    declaredLength === undefined ||
    !Number.isSafeInteger(declaredLength) ||
    declaredLength <= 0 ||
    declaredLength > maxBytes
  ) {
    await stream.cancel();
    throw new Error('Invalid Soul object size');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maxBytes || length > declaredLength) throw new Error('Invalid Soul object size');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const digest = createHash('sha256').update(body).digest('hex');
  if (
    length !== declaredLength ||
    digest !== object.Metadata?.sha256 ||
    (expectedDigest && digest !== expectedDigest)
  ) {
    throw new Error('Stored Soul checksum mismatch');
  }
  for (const [name, value] of Object.entries(expectedMetadata)) {
    if (object.Metadata?.[name] !== value) throw new Error('Stored Soul metadata mismatch');
  }
  return body;
}

export async function initializeSoul(storage: { client: S3Client; bucket: string }, input: Seed) {
  const seed = seedSchema.parse(input);
  const key = `workspaces/${seed.workspaceId}/soul/initial.bundle`;
  async function readStored() {
    try {
      const body = await readSoulObject(storage, key, 1024 * 1024);
      return { commit: await verifyStarterBundle(body, seed), bucket: storage.bucket, key };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null;
      throw error;
    }
  }
  const existing = await readStored();
  if (existing) return existing;
  const bundle = await createStarterBundle(seed);
  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Body: bundle.body,
        IfNoneMatch: '*',
        ContentType: 'application/x-git-bundle',
        Metadata: { sha256: createHash('sha256').update(bundle.body).digest('hex') },
      }),
    );
  } catch (error) {
    if (!(error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412)) throw error;
  }
  const stored = await readStored();
  if (!stored) throw new Error('Uploaded starter Soul is missing');
  return stored;
}
