import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { definitionSchema as fullTableDefinitionSchema } from '@tulipfarm/tables/definition';
import { readTableDocument, tableDocument, tableNamesSchema, type TableNames } from '@tulipfarm/tables/names';
import { git, readSoulObject, seedSchema, soulUuidSchema, verifySoulRepository } from './soul.ts';
import { agentDefinitionSchema, serializeAgentDocument } from './agent-document.ts';
export { agentDefinitionSchema } from './agent-document.ts';

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const soulChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('table'),
    commandId: soulUuidSchema,
    expectedParentCommit: commitSchema,
    createdAt: z.iso.datetime(),
    definition: fullTableDefinitionSchema,
    tableNames: tableNamesSchema.optional(),
    previousSha256: digestSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    commandId: soulUuidSchema,
    expectedParentCommit: commitSchema,
    createdAt: z.iso.datetime(),
    definition: agentDefinitionSchema,
  }),
]);
export type SoulChange = z.input<typeof soulChangeSchema>;
export type SoulSeed = z.infer<typeof seedSchema>;
export type SoulStorage = { client: S3Client; bucket: string };
const pointerSchema = z.strictObject({
  commit: commitSchema,
  bucket: z.string().min(1),
  key: z.string().min(1),
  sha256: digestSchema.optional(),
  commandSha256: digestSchema.optional(),
});
export type SoulPointer = z.infer<typeof pointerSchema>;
export const soulProjectionSchema = z.strictObject({
  workspaceId: soulUuidSchema,
  commit: commitSchema,
  kind: z.enum(['table', 'agent']),
  id: soulUuidSchema,
  path: z.string(),
  bucket: z.string().min(1),
  key: z.string(),
  sha256: digestSchema,
  tableNames: tableNamesSchema.optional(),
});
export type SoulProjection = z.infer<typeof soulProjectionSchema>;
const maxBundleBytes = 32 * 1024 * 1024;
const maxProjectionBytes = 1024 * 1024;
const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const prefix = (workspaceId: string) => `workspaces/${workspaceId}/soul/`;
const definitionPath = (kind: 'table' | 'agent', id: string, names?: TableNames) => {
  if (names && (kind !== 'table' || !names[fullTableDefinitionSchema.shape.id.parse(id)]))
    throw new Error('Invalid named Soul projection');
  return `${kind === 'table' ? 'tables' : 'agents'}/${names ? names[fullTableDefinitionSchema.shape.id.parse(id)] : id}.json`;
};
const projectionKey = (workspaceId: string, digest: string) => `${prefix(workspaceId)}projections/${digest}.json`;

async function writeImmutable(
  storage: SoulStorage,
  key: string,
  body: Uint8Array,
  contentType: string,
  maxBytes: number,
  metadata: Record<string, string> = {},
) {
  if (body.length > maxBytes) throw new Error('Invalid Soul object size');
  const digest = sha256(body);
  let uploadError: unknown;
  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Body: body,
        IfNoneMatch: '*',
        ContentType: contentType,
        Metadata: { ...metadata, sha256: digest },
      }),
    );
  } catch (error) {
    uploadError = error;
  }
  try {
    return await readSoulObject(storage, key, maxBytes, digest, metadata);
  } catch (error) {
    if (uploadError && error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) throw uploadError;
    throw error;
  }
}

export function validatePointer(storage: SoulStorage, seed: SoulSeed, input: SoulPointer) {
  const pointer = pointerSchema.parse(input);
  const root = prefix(seed.workspaceId);
  const revision = pointer.key.startsWith(`${root}revisions/`) ? pointer.key.slice(`${root}revisions/`.length) : '';
  if (
    pointer.bucket !== storage.bucket ||
    (pointer.key !== `${root}initial.bundle` && !z.uuid().safeParse(revision.replace(/\.bundle$/, '')).success)
  ) {
    throw new Error('Soul pointer is outside the workspace');
  }
  if (
    pointer.key !== `${root}initial.bundle` &&
    (!revision.endsWith('.bundle') || revision !== revision.toLowerCase() || !pointer.sha256)
  )
    throw new Error('Invalid Soul revision pointer');
  return pointer;
}

export async function restoreRepository(
  directory: string,
  body: Uint8Array,
  seed: SoulSeed,
  expectedCommit: string,
  commandSha256?: string,
) {
  await writeFile(join(directory, 'soul.bundle'), body);
  await git(directory, ['clone', '--bare', 'soul.bundle', 'repository']);
  const repository = join(directory, 'repository');
  const commit = await verifySoulRepository(repository, seed);
  if (commit !== expectedCommit) throw new Error('Soul parent commit mismatch');
  const refs = (await git(repository, ['for-each-ref', '--format=%(refname)'])).stdout.trim();
  if (refs !== 'refs/heads/main') throw new Error('Unexpected Soul references');
  if (commandSha256) {
    const message = (await git(repository, ['show', '-s', '--format=%B', commit])).stdout;
    if (!message.split('\n').includes(`Command-SHA256: ${commandSha256}`))
      throw new Error('Soul command digest does not match Git');
  }
  return repository;
}

function parseDefinition(body: Uint8Array, kind: 'table' | 'agent', id: string, names?: TableNames) {
  const value: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
  const definition =
    kind === 'table'
      ? names
        ? readTableDocument(value, id, names)
        : fullTableDefinitionSchema.parse(value)
      : agentDefinitionSchema.parse(value);
  if (definition.id !== id) throw new Error('Soul definition identity mismatch');
  return definition;
}

function validateProjection(storage: SoulStorage, workspaceId: string, input: SoulProjection) {
  workspaceId = soulUuidSchema.parse(workspaceId);
  const projection = soulProjectionSchema.parse(input);
  if (
    projection.workspaceId !== workspaceId ||
    projection.bucket !== storage.bucket ||
    projection.key !== projectionKey(workspaceId, projection.sha256) ||
    projection.path !== definitionPath(projection.kind, projection.id, projection.tableNames)
  ) {
    throw new Error('Soul projection is outside the selected definition');
  }
  return projection;
}

/**
 * Use the exact projection descriptor from authorized, accepted database metadata.
 * This reader needs only GetObject permission and does not execute Git.
 */
export async function readVerifiedProjection(storage: SoulStorage, workspaceId: string, input: SoulProjection) {
  const projection = validateProjection(storage, workspaceId, input);
  const body = await readSoulObject(storage, projection.key, maxProjectionBytes, projection.sha256);
  return parseDefinition(body, projection.kind, projection.id, projection.tableNames);
}

/**
 * Restore the selected commit and check its file against the stored projection.
 * Resolve both descriptors from trusted revision metadata before calling.
 */
export async function verifySoulRevision(
  storage: SoulStorage,
  input: SoulSeed,
  pointerInput: SoulPointer,
  projectionInput?: SoulProjection,
) {
  const seed = seedSchema.parse(input);
  const pointer = validatePointer(storage, seed, pointerInput);
  const projection = projectionInput ? validateProjection(storage, seed.workspaceId, projectionInput) : undefined;
  if (projection && projection.commit !== pointer.commit) throw new Error('Soul projection revision mismatch');
  const body = await readSoulObject(
    storage,
    pointer.key,
    maxBundleBytes,
    pointer.sha256,
    pointer.commandSha256 ? { 'command-sha256': pointer.commandSha256 } : {},
  );
  const directory = await mkdtemp(join(tmpdir(), 'tulipfarm-soul-restore-'));
  try {
    const repository = await restoreRepository(directory, body, seed, pointer.commit, pointer.commandSha256);
    if (!projection) return { commit: pointer.commit, sha256: sha256(body) };
    const file = Buffer.from((await git(repository, ['show', `${pointer.commit}:${projection.path}`])).stdout);
    if (sha256(file) !== projection.sha256) throw new Error('Soul projection does not match Git');
    const definition = parseDefinition(file, projection.kind, projection.id, projection.tableNames);
    await readVerifiedProjection(storage, seed.workspaceId, projection);
    return { commit: pointer.commit, sha256: sha256(body), definition };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Persist the command ID, timestamp, expected parent and definition before calling.
 * Retry with that same command. Reusing its ID for different content fails.
 * UUIDs are lowercased before hashing. commandSha256 binds the parsed seed and
 * change, including the exact timestamp string, into Git and verified metadata.
 * The change contains one version-1 resource document or agent definition.
 * Resource documents preserve the bounded compiler change, including backfill,
 * conversion and explicit deletion. Deletion writes a tombstone document rather
 * than removing the file. Records and arbitrary file paths are rejected.
 *
 * Reauthorize and compare-and-swap parentCommit in the acceptance transaction.
 * Persist bundle and projection there with the command receipt and dispatch work.
 * Uploads alone do not accept a revision. These descriptors are server-only.
 */
export async function prepareSoulRevision(
  storage: SoulStorage,
  input: SoulSeed,
  parentInput: SoulPointer,
  changeInput: SoulChange,
) {
  const seed = seedSchema.parse(input);
  const parent = validatePointer(storage, seed, parentInput);
  const change = soulChangeSchema.parse(changeInput);
  if (change.expectedParentCommit !== parent.commit) throw new Error('Soul parent commit mismatch');
  const commandSha256 = sha256(Buffer.from(JSON.stringify({ seed, change })));
  const parentBody = await readSoulObject(
    storage,
    parent.key,
    maxBundleBytes,
    parent.sha256,
    parent.commandSha256 ? { 'command-sha256': parent.commandSha256 } : {},
  );
  const directory = await mkdtemp(join(tmpdir(), 'tulipfarm-soul-revision-'));
  try {
    const repository = await restoreRepository(directory, parentBody, seed, parent.commit, parent.commandSha256);
    const tableNames = change.kind === 'table' ? change.tableNames : undefined;
    const path = definitionPath(change.kind, change.definition.id, tableNames);
    if (change.kind === 'table' && change.previousSha256) {
      if (!tableNames) throw new Error('A Soul naming conversion requires table names');
      const previous = Buffer.from(
        (await git(repository, ['show', `${parent.commit}:${definitionPath('table', change.definition.id)}`])).stdout,
      );
      if (sha256(previous) !== change.previousSha256) throw new Error('Soul conversion source does not match Git');
      if (
        JSON.stringify(parseDefinition(previous, 'table', change.definition.id)) !== JSON.stringify(change.definition)
      )
        throw new Error('Soul conversion changes the saved definition');
    }
    const file = Buffer.from(
      change.kind === 'agent'
        ? serializeAgentDocument(change.definition)
        : `${JSON.stringify(tableNames ? tableDocument(change.definition, tableNames) : change.definition, null, 2)}\n`,
    );
    if (file.length > maxProjectionBytes) throw new Error('Invalid Soul definition size');
    const filePath = join(directory, 'definition.json');
    await writeFile(filePath, file);
    const blob = (await git(repository, ['hash-object', '-w', filePath])).stdout.trim();
    await git(repository, ['read-tree', parent.commit]);
    const legacyPath = definitionPath(change.kind, change.definition.id);
    if (tableNames)
      await git(repository, ['update-index', '--index-info'], undefined, `0 ${'0'.repeat(40)}\t${legacyPath}\n`);
    await git(repository, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    const tree = (await git(repository, ['write-tree'])).stdout.trim();
    const action = change.kind === 'table' && change.previousSha256 ? 'Name' : 'Save';
    const message = `${action} ${change.kind} ${change.definition.id}\n\nCommand: ${change.commandId}\nWorkspace: ${seed.workspaceId}\nCommand-SHA256: ${commandSha256}`;
    const commit = (
      await git(repository, ['commit-tree', tree, '-p', parent.commit, '-m', message], {
        ...seed,
        createdAt: change.createdAt,
      })
    ).stdout.trim();
    const changed = (
      await git(repository, ['diff-tree', '-z', '--no-commit-id', '--name-only', '-r', parent.commit, commit])
    ).stdout
      .split('\0')
      .filter(Boolean);
    if (changed.some(file => file !== path && !(tableNames && file === legacyPath)))
      throw new Error('Soul revision changes more than the selected definition');
    await git(repository, ['update-ref', 'refs/heads/main', commit, parent.commit]);
    await verifySoulRepository(repository, seed);
    const bundlePath = join(directory, 'revision.bundle');
    await git(repository, ['bundle', 'create', bundlePath, 'refs/heads/main']);
    const body = await readFile(bundlePath);
    const key = `${prefix(seed.workspaceId)}revisions/${change.commandId}.bundle`;
    const bundle = { commit, bucket: storage.bucket, key, sha256: sha256(body), commandSha256 };
    await writeImmutable(storage, key, body, 'application/x-git-bundle', maxBundleBytes, {
      'command-sha256': commandSha256,
    });
    const extracted = Buffer.from((await git(repository, ['show', `${commit}:${path}`])).stdout);
    if (!file.equals(extracted)) throw new Error('Soul projection does not match Git');
    const digest = sha256(extracted);
    const projection: SoulProjection = {
      workspaceId: seed.workspaceId,
      commit,
      kind: change.kind,
      id: change.definition.id,
      path,
      bucket: storage.bucket,
      key: projectionKey(seed.workspaceId, digest),
      sha256: digest,
      ...(tableNames ? { tableNames } : {}),
    };
    await writeImmutable(storage, projection.key, extracted, 'application/json', maxProjectionBytes);
    await verifySoulRevision(storage, seed, bundle, projection);
    return { commandId: change.commandId, commandSha256, parentCommit: parent.commit, commit, bundle, projection };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
