import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  FileError,
  fileCopySourceSchema,
  fileSuggestionsQuerySchema,
  fileTypeRules,
  fileNameSchema,
  fileRoleSchema,
  fileSubjectSchema,
  itemSchema,
  libraryQuerySchema,
  moveFingerprintSchema,
  newFileSchema,
  newFolderSchema,
  roleLevel,
  type DeletionOutcome,
  type FileCopySource,
  type FileItem,
  type FileRole,
  type FileSummary,
  type FileSuggestionsPage,
  type LibraryPage,
  type LibrarySort,
} from './contracts.ts';
import { loadSharingGraph, movePreview, requireFileAccess, sharingGraphLimits, sharingSnapshot } from './sharing.ts';
import { recordRecommendationChange, recommendationsInstalled } from '@tulipfarm/workspace-storage/recommendations';

export { FileError } from './contracts.ts';
export { readableFileSql } from './readable-sql.ts';
export type {
  FileRole,
  FileSubject,
  FileReference,
  ReadableFileReference,
  FileGrant,
  FileOwnership,
  FileSharingContribution,
  FileAudienceMember,
  FileSharingSnapshot,
  MoveAudience,
  MovePreview,
  FileSummary,
  FileSuggestionsPage,
  FileSuggestionsQuery,
  FileType,
  LibraryFilters,
  LibraryItem,
  LibraryLocation,
  LibraryPage,
  LibraryQuery,
  LibrarySection,
  LibrarySort,
  FileCopySource,
  FileStorageUsage,
  DeletionPreview,
  DeletionOutcome,
} from './contracts.ts';
/** A membership and the identity user behind it. The HTTP layer resolves display names. */
export type FileMember = { membershipId: string; userId: string };
type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type RecommendationAudience = Map<string, string[]>;
/** `signal` is the caller going away; an adapter stops the transfer so the caller's transfer slot frees at once. */
export type FileBytes = {
  putIfAbsent: (key: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<void>;
  read: (key: string, maximumBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;
  remove: (key: string) => Promise<void>;
};
/** A copy's read. `version` is the source revision when the provider reports one. */
export type FileCopyRead = { mediaType: string; content: Uint8Array; version?: string | undefined };
/**
 * Bytes arriving as a new file. An import names its source, so a replay is recognized without loading the source again.
 * An upload's `signal` is its sender going away: a cancelled upload stops before its row commits, so it holds no quota.
 */
export type FileArrival =
  | { kind: 'upload'; mediaType: string; content: Uint8Array; signal?: AbortSignal | undefined }
  | {
      kind: 'derived';
      mediaType: string;
      content: Uint8Array;
      guard?: ((tx: AuthorizationTransaction) => Promise<void>) | undefined;
    }
  | { kind: 'import'; source: FileCopySource; load: () => Promise<FileCopyRead> };
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const installed = async (tx: AuthorizationTransaction, name: string) =>
  z
    .object({ relation: z.string().nullable() })
    .parse((await tx.client.query('SELECT to_regclass($1)::text AS relation', [table(tx, name)])).rows[0]).relation !==
  null;
/**
 * Bytes charged to the workspace quota: every Files row plus every live chat attachment.
 * A sent attachment published into Files shares its id with that file and is charged once, through the file.
 * Since 0110 the file borrows the attachment's object, so the charge matches storage. Files published earlier keep a
 * second copy that is still charged once. Deleting the file forever charges the attachment again, because its object remains.
 * Callers hold the advisory lock salted 209871 so concurrent checks see each other's writes.
 */
export async function chargedBytes(tx: AuthorizationTransaction) {
  const files = await installed(tx, 'tf_files');
  const attachments = await installed(tx, 'tf_conversation_attachments');
  const packages = await installed(tx, 'tf_skill_package_objects');
  const total = async (sql: string) =>
    z.object({ total: z.coerce.number() }).parse((await tx.client.query(sql)).rows[0]).total;
  return (
    (files ? await total(`SELECT COALESCE(sum(size),0) AS total FROM ${table(tx, 'tf_files')}`) : 0) +
    (attachments
      ? await total(`SELECT COALESCE(sum(a.size),0) AS total FROM ${table(tx, 'tf_conversation_attachments')} a WHERE a.state <> 'abandoned'
      ${files ? `AND NOT (a.state = 'bound' AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_files')} f WHERE f.id = a.id AND f.creator_membership_id = a.membership_id AND f.sha256 = a.sha256))` : ''}`)
      : 0) +
    (packages ? await total(`SELECT COALESCE(sum(size),0) AS total FROM ${table(tx, 'tf_skill_package_objects')}`) : 0)
  );
}
/** Where a file's bytes live. A borrowed object stays in the chat attachment namespace under the attachment's key. */
const objectPath = (workspaceId: string, item: Pick<FileItem, 'object_key' | 'object_owner'>) =>
  item.object_owner === 'attachment' ? `${workspaceId}/${item.object_key}` : `${workspaceId}/files/${item.object_key}`;
const lockStorage = (tx: AuthorizationTransaction) =>
  tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [tx.schema]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const maximumFileBytes = 10 * 1024 * 1024;
const compatibility = commonCompatibility;
/**
 * Copies made before provenance rows existed carry their command in the first 8 bytes of the object key.
 * Replay still recognizes them; new copies record a `tf_file_copy_sources` row instead.
 */
function legacyCopyKeyMatches(objectKey: string | null, source: FileCopySource) {
  const hash = createHash('sha256')
    .update(JSON.stringify([source.provider, source.accountId, source.fileId, source.format]))
    .digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x80, 6);
  return objectKey?.replaceAll('-', '').startsWith(hash.subarray(0, 8).toString('hex')) === true;
}
const deletionState = (item: FileItem) =>
  item.deleting_at === null ? null : item.deletion_failed_at === null ? ('deleting' as const) : ('failed' as const);
const metadata = (item: FileItem, role: FileRole): FileSummary => ({
  id: item.id,
  kind: item.kind,
  name: item.name,
  parentId: item.parent_id,
  creatorMembershipId: item.creator_membership_id,
  mediaType: item.media_type,
  size: item.size,
  trashed: item.trashed_at !== null,
  role,
  deletion: deletionState(item),
});
/** Library order. ICU root collation keeps accented and non-Latin names in reading order; the cursor compares under the same collation. */
const nameOrder = (name: string) => `${name} COLLATE "und-x-icu"`;
const literals = (values: readonly string[]) =>
  `ARRAY[${values.map(value => `'${value.replaceAll("'", "''")}'`).join(',')}]::text[]`;
/** A row's file type for the type filter, generated from `fileTypeRules`. */
function typeOf(alias: string) {
  const media = `lower(COALESCE(${alias}.media_type, ''))`,
    extension = `lower(COALESCE(substring(${alias}.name from '\\.([^.]+)$'), ''))`;
  return `CASE WHEN ${alias}.kind = 'folder' THEN 'folder'${fileTypeRules.map(rule => ` WHEN ${media} = ANY(${literals(rule.mediaTypes)})${rule.mediaPrefixes.map(prefix => ` OR starts_with(${media}, '${prefix}')`).join('')} OR ${extension} = ANY(${literals(rule.extensions)}) THEN '${rule.type}'`).join('')} ELSE 'other' END`;
}
/**
 * Folders stay first in every order. A row whose modified time is unknown sorts after every known time in both directions.
 * `after` compares a row with the cursor's keys in the same order, with the id breaking ties.
 */
function sortOrder(sort: LibrarySort) {
  const [direction, beyond] = sort.direction === 'asc' ? ['ASC', '>'] : ['DESC', '<'];
  const unknown = sort.direction === 'asc' ? 'infinity' : '-infinity';
  const key = (alias: string) =>
    sort.key === 'name' ? nameOrder(`${alias}.name`) : `COALESCE(${alias}.modified_at, '${unknown}'::timestamptz)`;
  const rank = (alias: string) => `(CASE ${alias}.kind WHEN 'folder' THEN 0 ELSE 1 END)`;
  return {
    by: (alias: string) => `${rank(alias)}, ${key(alias)} ${direction}, ${alias}.id ${direction}`,
    after: (alias: string, cursor: string) => {
      const row = key(alias),
        at = key(cursor);
      return `(${rank(alias)} > ${rank(cursor)} OR (${rank(alias)} = ${rank(cursor)} AND (${row} ${beyond} ${at} OR (${row} = ${at} AND ${alias}.id ${beyond} ${cursor}.id))))`;
    },
  };
}

function ancestors(tx: AuthorizationTransaction) {
  return `WITH RECURSIVE ancestors AS (
    SELECT * FROM ${table(tx, 'tf_files')} WHERE id = $1
    UNION SELECT parent.* FROM ${table(tx, 'tf_files')} parent JOIN ancestors child ON parent.id = child.parent_id
  )`;
}

type AccessTraversal = 'ordinary' | 'sharing';

async function lineage(tx: AuthorizationTransaction, id: string, traversal: AccessTraversal) {
  if (traversal === 'sharing') {
    const result = await tx.client.query(
      `WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM ${table(tx, 'tf_files')} WHERE id = $1
      UNION SELECT parent.id, parent.parent_id FROM ${table(tx, 'tf_files')} parent
        JOIN ancestors child ON parent.id = child.parent_id
    ), bounded_ancestors AS MATERIALIZED (SELECT * FROM ancestors LIMIT $2)
      SELECT * FROM bounded_ancestors`,
      [id, sharingGraphLimits.lineage + 1],
    );
    if (result.rows.length > sharingGraphLimits.lineage) throw new FileError('graph-limit');
    const references = z.array(itemSchema.pick({ id: true, parent_id: true })).parse(result.rows);
    const ids = new Set(references.map(entry => entry.id));
    if (references.some(entry => entry.parent_id !== null && !ids.has(entry.parent_id))) throw new AccessDenied();
    if (references.length && !references.some(entry => entry.parent_id === null)) throw new FileError('invalid-move');
    return z
      .array(itemSchema)
      .parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'tf_files')} WHERE id = ANY($1::uuid[])`, [[...ids]])).rows,
      );
  }
  return z.array(itemSchema).parse((await tx.client.query(`${ancestors(tx)} SELECT * FROM ancestors`, [id])).rows);
}

/**
 * `stranded` admits an item the actor owns whose folder another owner moved to Trash, so the owner can restore it elsewhere.
 * Every other trashed lineage stays closed.
 */
async function access(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  id: string,
  required: FileRole = 'viewer',
  {
    trash = false,
    stranded = false,
    traversal = 'ordinary',
  }: { trash?: boolean; stranded?: boolean; traversal?: AccessTraversal } = {},
) {
  const chain = await lineage(tx, id, traversal);
  const item = chain.find(entry => entry.id === id);
  if (!item || chain.some(entry => !entry.ready || entry.deleting_at)) throw new AccessDenied();
  const rescue =
    stranded &&
    item.creator_membership_id === actor.membershipId &&
    chain.some(entry => entry.id !== id && entry.trashed_at);
  if (!rescue && chain.some(entry => entry.trashed_at && !(trash && entry.id === id))) throw new AccessDenied();
  const authority =
    traversal === 'sharing'
      ? `WITH ancestors AS (SELECT * FROM ${table(tx, 'tf_files')} WHERE id = ANY($1::uuid[]))`
      : ancestors(tx);
  const result = await tx.client.query(
    `${authority}
    SELECT CASE WHEN EXISTS (SELECT 1 FROM ancestors WHERE creator_membership_id = $2) THEN 3 ELSE
      COALESCE((SELECT max(CASE g.role WHEN 'manager' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END)
        FROM ${table(tx, 'tf_file_grants')} g JOIN ancestors a ON a.id = g.item_id
        WHERE (g.subject_kind = 'individual' AND g.subject_id = $2)
          OR (g.subject_kind = 'team' AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt
            JOIN ${table(tx, 'tf_teams')} t ON t.id = mt.team_id WHERE mt.membership_id = $2 AND mt.team_id = g.subject_id))), 0) END AS level`,
    [traversal === 'sharing' ? chain.map(entry => entry.id) : id, actor.membershipId],
  );
  const { level } = z.object({ level: z.number().int() }).parse(result.rows[0]);
  if (level < roleLevel[required]) throw new AccessDenied();
  await requireSkillFileSources(tx, actor, id, requireReadableFile);
  const role: FileRole = level === 3 ? 'manager' : level === 2 ? 'editor' : 'viewer';
  return { item, role };
}

async function readablePath(tx: AuthorizationTransaction, actor: HumanActor, parentId: string | null) {
  const path: FileSummary[] = [];
  for (let parent = parentId; parent !== null && path.length < sharingGraphLimits.lineage;) {
    const ancestor = await access(tx, actor, parent).catch((error: unknown) => {
      if (error instanceof AccessDenied) return null;
      throw error;
    });
    if (!ancestor) break;
    path.unshift(metadata(ancestor.item, ancestor.role));
    parent = ancestor.item.parent_id;
  }
  return path;
}

async function activeMembers(tx: AuthorizationTransaction, ids: string[] | null): Promise<FileMember[]> {
  return z.array(z.object({ membershipId: uuidSchema, userId: z.string() })).parse(
    (
      await tx.client.query(
        `SELECT id AS "membershipId", user_id AS "userId"
    FROM ${table(tx, 'tf_memberships')} WHERE removed_at IS NULL AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY created_at, id`,
        [ids],
      )
    ).rows,
  );
}

/**
 * The file `actor` can read now, as its id, digest, and size. It leaves out the object key: since 0110 a key alone does
 * not locate the bytes, so readers go through `download`, which resolves the path from the key and its owner.
 */
export async function requireReadableFile(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
  await currentMember(tx, actor);
  const { item } = await access(tx, actor, uuidSchema.parse(id));
  if (item.kind !== 'file' || !item.object_key || !item.sha256 || item.size === null) throw new AccessDenied();
  return Object.freeze({ id: item.id, sha256: item.sha256, size: item.size });
}

/**
 * Where the bytes of a file `actor` can read now are stored, for a caller that streams them itself under this same check.
 * The caller must verify the bytes it reads against `sha256` and `size`.
 */
export async function requireReadableFileObject(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  workspaceId: string,
  id: string,
) {
  await currentMember(tx, actor);
  const { item } = await access(tx, actor, uuidSchema.parse(id));
  if (item.kind !== 'file' || !item.object_key || !item.sha256 || item.size === null) throw new AccessDenied();
  return Object.freeze({
    id: item.id,
    sha256: item.sha256,
    size: item.size,
    mediaType: item.media_type ?? 'application/octet-stream',
    path: objectPath(uuidSchema.parse(workspaceId), item),
  });
}

/**
 * For each id that `requireReadableFile` would admit for some of `readers`, its digest and the readers it admits, in one query.
 * Readers must be current members; this does not recheck membership.
 */
export async function fileReaders(
  tx: AuthorizationTransaction,
  readers: readonly HumanActor[],
  ids: readonly string[],
) {
  const readable = new Map<string, { sha256: string; readers: Set<string> }>();
  if (!readers.length || !ids.length) return readable;
  // deleting_at arrives with the lifecycle migration; reading it through to_jsonb keeps older schemas working, as `SELECT *` does in `access`.
  const rows = z.array(z.object({ file_id: uuidSchema, sha256: z.string(), membership_id: uuidSchema })).parse(
    (
      await tx.client.query(
        `WITH RECURSIVE lineage AS (
      SELECT f.id AS file_id, f.id, f.parent_id, f.creator_membership_id, f.ready AND f.trashed_at IS NULL AND to_jsonb(f)->>'deleting_at' IS NULL AS clear
      FROM ${table(tx, 'tf_files')} f WHERE f.id = ANY($1::uuid[])
      UNION SELECT l.file_id, p.id, p.parent_id, p.creator_membership_id, p.ready AND p.trashed_at IS NULL AND to_jsonb(p)->>'deleting_at' IS NULL
      FROM lineage l JOIN ${table(tx, 'tf_files')} p ON p.id = l.parent_id
    ), clear AS (SELECT file_id FROM lineage GROUP BY file_id HAVING bool_and(clear))
    SELECT f.id AS file_id, f.sha256, r.membership_id FROM ${table(tx, 'tf_files')} f JOIN clear c ON c.file_id = f.id
      CROSS JOIN unnest($2::uuid[]) AS r(membership_id)
    WHERE f.kind = 'file' AND f.object_key IS NOT NULL AND f.sha256 IS NOT NULL AND f.size IS NOT NULL
      AND (EXISTS (SELECT 1 FROM lineage l WHERE l.file_id = f.id AND l.creator_membership_id = r.membership_id)
        OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_file_grants')} g JOIN lineage l ON l.id = g.item_id AND l.file_id = f.id
          WHERE (g.subject_kind = 'individual' AND g.subject_id = r.membership_id)
            OR (g.subject_kind = 'team' AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt
              JOIN ${table(tx, 'tf_teams')} t ON t.id = mt.team_id WHERE mt.membership_id = r.membership_id AND mt.team_id = g.subject_id))))`,
        [ids, readers.map(reader => reader.membershipId)],
      )
    ).rows,
  );
  for (const row of rows) {
    const reader = readers.find(reader => reader.membershipId === row.membership_id);
    if (!reader) throw new AccessDenied();
    try {
      await requireSkillFileSources(tx, reader, row.file_id, requireReadableFile);
    } catch (error) {
      if (error instanceof AccessDenied) continue;
      throw error;
    }
    const entry = readable.get(row.file_id) ?? { sha256: row.sha256, readers: new Set<string>() };
    entry.readers.add(row.membership_id);
    readable.set(row.file_id, entry);
  }
  return readable;
}

async function recommendationAudience(tx: AuthorizationTransaction, id: string): Promise<RecommendationAudience> {
  const result: RecommendationAudience = new Map();
  if (!(await recommendationsInstalled(tx))) return result;
  const graph = await loadSharingGraph(tx, id, null, true);
  const readers: HumanActor[] = graph.memberships
    .filter(member => member.removed_at === null)
    .map(member => ({ kind: 'human', membershipId: member.id, userId: member.user_id }));
  const readable = await fileReaders(
    tx,
    readers,
    graph.items.filter(item => item.kind === 'file').map(item => item.id),
  );
  for (const [fileId, file] of readable)
    for (const membershipId of file.readers) {
      const actor = readers.find(reader => reader.membershipId === membershipId)!;
      const entries = result.get(membershipId) ?? [];
      entries.push(JSON.stringify([fileId, file.sha256, requireFileAccess(graph, actor, fileId).role]));
      result.set(membershipId, entries);
    }
  for (const entries of result.values()) entries.sort();
  return result;
}

async function recommendationChanges(tx: AuthorizationTransaction, id: string, before: RecommendationAudience) {
  const after = await recommendationAudience(tx, id);
  const changed: string[] = [];
  const invalidated = new Map<string, string[]>();
  for (const membershipId of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(membershipId) ?? [],
      current = after.get(membershipId) ?? [];
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    const lost = previous.filter(entry => !current.includes(entry));
    if (!lost.length) changed.push(membershipId);
    for (const entry of lost) {
      const fileId = z.tuple([z.uuid(), z.string(), z.string()]).parse(JSON.parse(entry))[0];
      const members = invalidated.get(fileId) ?? [];
      members.push(membershipId);
      invalidated.set(fileId, members);
    }
  }
  if (changed.length)
    await recordRecommendationChange(tx, { id: randomUUID(), kind: 'file', sourceId: id, membershipIds: changed });
  for (const [sourceId, membershipIds] of invalidated) {
    await recordRecommendationChange(tx, { id: randomUUID(), kind: 'file', sourceId, membershipIds, invalidate: true });
  }
}

/** The actor's role on a readable item; throws `AccessDenied` when they cannot read it. */
export async function fileRole(tx: AuthorizationTransaction, actor: HumanActor, id: string): Promise<FileRole> {
  await currentMember(tx, actor);
  return (await access(tx, actor, uuidSchema.parse(id))).role;
}

/** Records an explicit successful use inside a caller-held authorization write transaction. */
export async function recordFileUse(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
  await currentMember(tx, actor);
  const { item } = await access(tx, actor, uuidSchema.parse(id));
  if (item.kind !== 'file') throw new AccessDenied();
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_file_usage')} (membership_id,file_id,used_at)
    VALUES ($1,$2,clock_timestamp())
    ON CONFLICT (membership_id,file_id) DO UPDATE SET used_at = clock_timestamp()`,
    [actor.membershipId, item.id],
  );
  return { id: item.id };
}

/** Pino's `warn(fields, message)` shape, so the API passes its request logger. */
export type FilesLog = { warn: (fields: Record<string, unknown>, message: string) => void };
const consoleLog: FilesLog = {
  warn: (fields, message) => console.warn(JSON.stringify({ level: 'warn', msg: message, ...fields })),
};

export function createFiles(runtime: Runtime, bytes: FileBytes, options: { quotaBytes?: number; log?: FilesLog } = {}) {
  const quota = z
    .number()
    .int()
    .positive()
    .parse(options.quotaBytes ?? 1024 * 1024 * 1024);
  const log = options.log ?? consoleLog;
  let transfers = 0;
  async function bounded<T>(operation: () => Promise<T>) {
    if (transfers >= 4) throw new FileError('busy');
    transfers++;
    try {
      return await operation();
    } finally {
      transfers--;
    }
  }
  async function transaction<T>(
    workspaceId: string,
    userId: string,
    write: boolean,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      return operation(tx, await resolveHuman(tx, userId));
    });
  }
  async function destination(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    parentId: string | null,
    traversal: AccessTraversal = 'ordinary',
  ) {
    if (parentId === null) return;
    const { item } = await access(tx, actor, parentId, 'editor', { traversal });
    if (item.kind !== 'folder') throw new FileError('invalid-move');
  }
  async function read(workspaceId: string, userId: string, id: string) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const { item, role } = await access(tx, actor, id);
      return metadata(item, role);
    });
  }
  /** Summaries of the listed items the reader can open, in request order. Unreadable or missing ids are left out. */
  async function summaries(workspaceId: string, userId: string, ids: readonly string[]) {
    const requested = [...new Set(z.array(uuidSchema).max(100).parse(ids))];
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const items: FileSummary[] = [];
      for (const id of requested) {
        try {
          const { item, role } = await access(tx, actor, id);
          items.push(metadata(item, role));
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
        }
      }
      return { items };
    });
  }
  async function createFolder(workspaceId: string, userId: string, id: string, value: unknown) {
    denyMcpEgress();
    id = uuidSchema.parse(id);
    const input = newFolderSchema.parse(value);
    return transaction(workspaceId, userId, true, async (tx, actor) => {
      await destination(tx, actor, input.parentId);
      const existing = itemSchema
        .optional()
        .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'tf_files')} WHERE id = $1`, [id])).rows[0]);
      if (existing) {
        if (existing.creator_membership_id !== actor.membershipId) throw new AccessDenied();
        if (
          existing.kind !== 'folder' ||
          existing.name !== input.name ||
          existing.parent_id !== input.parentId ||
          existing.trashed_at
        )
          throw new FileError('conflict');
        return metadata(existing, 'manager');
      }
      const item = itemSchema.parse(
        (
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_files')}
        (id,kind,creator_membership_id,parent_id,name,ready) VALUES ($1,'folder',$2,$3,$4,true) RETURNING *`,
            [id, actor.membershipId, input.parentId, input.name],
          )
        ).rows[0],
      );
      return metadata(item, 'manager');
    });
  }
  /** Removes an attempt's object unless a row references it, as after a commit whose response was lost. */
  async function discard(workspaceId: string, key: string) {
    try {
      const referenced = await runtime.transaction(
        workspaceId,
        compatibility,
        async tx =>
          (await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_files')} WHERE object_key = $1`, [key])).rowCount,
      );
      if (!referenced) await bytes.remove(`${workspaceId}/files/${key}`);
    } catch (error) {
      // An unremoved object is unreferenced and holds no quota, but it is storage nobody will reclaim, so operators see it.
      log.warn(
        {
          event: 'files.discard_failed',
          workspaceId,
          objectKey: `${workspaceId}/files/${key}`,
          error: error instanceof Error ? error.name : typeof error,
          code: error instanceof Error && 'code' in error ? String(error.code) : null,
        },
        'Files could not remove an unpublished object',
      );
    }
  }
  /** Stores verified bytes first and then inserts one ready row, so a failed or abandoned transfer never holds quota. */
  async function publish(workspaceId: string, userId: string, id: string, value: unknown, arrival: FileArrival) {
    denyMcpEgress();
    workspaceId = uuidSchema.parse(workspaceId);
    id = uuidSchema.parse(id);
    const target = newFolderSchema.parse(value);
    const sameCopy = async (tx: AuthorizationTransaction, existing: FileItem, source: FileCopySource) => {
      const recorded = z
        .object({ provider: z.string(), account_id: z.string(), source_file_id: z.string(), format: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT provider, account_id, source_file_id, format FROM ${table(tx, 'tf_file_copy_sources')} WHERE file_id = $1`,
              [existing.id],
            )
          ).rows[0],
        );
      return recorded
        ? recorded.provider === source.provider &&
            recorded.account_id === source.accountId &&
            recorded.source_file_id === source.fileId &&
            recorded.format === source.format
        : legacyCopyKeyMatches(existing.object_key, source);
    };
    const replay = async (tx: AuthorizationTransaction, actor: HumanActor, existing: FileItem) => {
      if (existing.creator_membership_id !== actor.membershipId) throw new AccessDenied();
      if (arrival.kind === 'derived') {
        await arrival.guard?.(tx);
        await requireSkillFileSources(tx, actor, existing.id, requireReadableFile);
        if (existing.kind !== 'file' || existing.sha256 !== digest(arrival.content)) throw new FileError('conflict');
        if (!existing.ready || existing.trashed_at !== null || existing.deleting_at !== null)
          throw new FileError('conflict');
        return metadata(existing, 'manager');
      }
      const same =
        existing.kind === 'file' &&
        existing.ready &&
        existing.trashed_at === null &&
        existing.name === target.name &&
        existing.parent_id === target.parentId &&
        (arrival.kind === 'upload'
          ? existing.sha256 === digest(arrival.content) && existing.media_type === arrival.mediaType
          : await sameCopy(tx, existing, arrival.source));
      if (!same) throw new FileError('conflict');
      const { item, role } = await access(tx, actor, id);
      return metadata(item, role);
    };
    const signal = arrival.kind === 'upload' ? arrival.signal : undefined;
    const cancelled = () => signal?.throwIfAborted();
    const row = async (tx: AuthorizationTransaction) =>
      itemSchema
        .optional()
        .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'tf_files')} WHERE id = $1`, [id])).rows[0]);
    return bounded(async () => {
      // `used` is an unlocked reading taken before any transfer, so a file that cannot fit fails before it moves bytes.
      // The locked check after the insert stays authoritative.
      const prior = await transaction(workspaceId, userId, false, async (tx, actor) => {
        const existing = await row(tx);
        if (existing && arrival.kind === 'derived') return { summary: await replay(tx, actor, existing) };
        await destination(tx, actor, target.parentId);
        if (existing) return { summary: await replay(tx, actor, existing) };
        return { used: await chargedBytes(tx) };
      });
      if ('summary' in prior) return prior.summary;
      const fits = (size: number) => {
        if (prior.used + size > quota) throw new FileError('quota');
      };
      if (arrival.kind === 'import') fits(1);
      const content: FileCopyRead =
        arrival.kind === 'import' ? await arrival.load() : { mediaType: arrival.mediaType, content: arrival.content };
      const readAt = new Date();
      const { mediaType } = newFileSchema.pick({ mediaType: true }).parse({ mediaType: content.mediaType });
      const version = z.string().min(1).max(64).optional().parse(content.version);
      if (content.content.byteLength < 1 || content.content.byteLength > maximumFileBytes) throw new FileError('size');
      fits(content.content.byteLength);
      const hash = digest(content.content),
        size = content.content.byteLength,
        key = randomUUID();
      try {
        cancelled();
        await bytes.putIfAbsent(`${workspaceId}/files/${key}`, content.content, signal);
        const stored = await bytes.read(`${workspaceId}/files/${key}`, size, signal);
        if (stored.byteLength !== size || digest(stored) !== hash) throw new FileError('integrity');
        cancelled();
        const published = await transaction(workspaceId, userId, true, async (tx, actor) => {
          await lockStorage(tx);
          const existing = await row(tx);
          if (existing && arrival.kind === 'derived')
            return { key: existing.object_key, summary: await replay(tx, actor, existing) };
          await destination(tx, actor, target.parentId);
          if (existing) return { key: existing.object_key, summary: await replay(tx, actor, existing) };
          if (arrival.kind === 'derived') await arrival.guard?.(tx);
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_files')}
            (id,kind,creator_membership_id,parent_id,name,object_key,media_type,size,sha256,ready)
            VALUES ($1,'file',$2,$3,$4,$5,$6,$7,$8,true)`,
            [id, actor.membershipId, target.parentId, target.name, key, mediaType, size, hash],
          );
          if (arrival.kind === 'import')
            await tx.client.query(
              `INSERT INTO ${table(tx, 'tf_file_copy_sources')}
            (file_id,provider,account_id,source_file_id,format,source_version,read_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [
                id,
                arrival.source.provider,
                arrival.source.accountId,
                arrival.source.fileId,
                arrival.source.format,
                version ?? null,
                readAt,
              ],
            );
          // Checked after the insert, under the lock, so concurrent writers cannot oversubscribe the quota.
          if ((await chargedBytes(tx)) > quota) throw new FileError('quota');
          const { item, role } = await access(tx, actor, id);
          cancelled();
          await recommendationChanges(tx, id, new Map());
          return { key, summary: metadata(item, role) };
        });
        if (published.key !== key) await discard(workspaceId, key);
        return published.summary;
      } catch (error) {
        await discard(workspaceId, key);
        throw error;
      }
    });
  }
  async function upload(
    workspaceId: string,
    userId: string,
    id: string,
    value: unknown,
    content: Uint8Array,
    signal?: AbortSignal,
  ) {
    denyMcpEgress();
    const input = newFileSchema.parse(value);
    return publish(
      workspaceId,
      userId,
      id,
      { name: input.name, parentId: input.parentId },
      { kind: 'upload', mediaType: input.mediaType, content, signal },
    );
  }
  /**
   * Creates a file the system makes for a person, such as an agent output.
   * A replay of the same id returns the stored file even after it was renamed or moved, as long as the bytes match.
   * A trashed or deleting file is a conflict, so a replay never reports or revives a file the person removed.
   * `guard` runs in the publishing transaction, so a revoked input blocks the file instead of following it.
   */
  async function createDerived(
    workspaceId: string,
    userId: string,
    id: string,
    value: unknown,
    content: Uint8Array,
    guard?: (tx: AuthorizationTransaction) => Promise<void>,
  ) {
    const input = newFileSchema.parse(value);
    return publish(
      workspaceId,
      userId,
      id,
      { name: input.name, parentId: input.parentId },
      { kind: 'derived', mediaType: input.mediaType, content, guard },
    );
  }
  /**
   * Publishes the sender's bound chat attachment as a personal file under the attachment's id. The file borrows the
   * attachment's object, so no bytes move and the pair is charged once. Replays follow `createDerived`; a file published
   * before 0110 with its own copy replays the same way.
   */
  async function publishAttachment(workspaceId: string, userId: string, attachmentId: string) {
    denyMcpEgress();
    const id = uuidSchema.parse(attachmentId);
    return transaction(uuidSchema.parse(workspaceId), userId, true, async (tx, actor) => {
      await lockStorage(tx);
      const attachment = z
        .object({
          object_key: uuidSchema,
          filename: z.string(),
          media_type: z.string(),
          size: z.number().int(),
          sha256: z.string(),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT object_key, filename, media_type, size, sha256 FROM ${table(tx, 'tf_conversation_attachments')}
          WHERE id = $1 AND membership_id = $2 AND state = 'bound'`,
              [id, actor.membershipId],
            )
          ).rows[0],
        );
      if (!attachment) throw new AccessDenied();
      const existing = itemSchema
        .optional()
        .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'tf_files')} WHERE id = $1`, [id])).rows[0]);
      if (existing) {
        if (existing.creator_membership_id !== actor.membershipId) throw new AccessDenied();
        if (
          existing.kind !== 'file' ||
          existing.sha256 !== attachment.sha256 ||
          !existing.ready ||
          existing.trashed_at !== null ||
          existing.deleting_at !== null
        )
          throw new FileError('conflict');
        return metadata(existing, 'manager');
      }
      const input = newFileSchema.parse({
        name: attachment.filename,
        parentId: null,
        mediaType: attachment.media_type,
      });
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_files')}
        (id,kind,creator_membership_id,parent_id,name,object_key,object_owner,media_type,size,sha256,ready)
        VALUES ($1,'file',$2,NULL,$3,$4,'attachment',$5,$6,$7,true)`,
        [
          id,
          actor.membershipId,
          input.name,
          attachment.object_key,
          input.mediaType,
          attachment.size,
          attachment.sha256,
        ],
      );
      if ((await chargedBytes(tx)) > quota) throw new FileError('quota');
      const { item, role } = await access(tx, actor, id);
      return metadata(item, role);
    });
  }
  async function importFile(
    workspaceId: string,
    userId: string,
    id: string,
    value: unknown,
    source: FileCopySource,
    load: () => Promise<FileCopyRead>,
  ) {
    return publish(workspaceId, userId, id, value, {
      kind: 'import',
      source: fileCopySourceSchema.parse(source),
      load,
    });
  }
  /** `signal` is the reader going away; the storage read stops so the transfer slot frees at once. */
  async function download(workspaceId: string, userId: string, id: string, signal?: AbortSignal) {
    workspaceId = uuidSchema.parse(workspaceId);
    id = uuidSchema.parse(id);
    return bounded(async () => {
      const authorize = () => transaction(workspaceId, userId, false, async (tx, actor) => access(tx, actor, id));
      const { item } = await authorize();
      if (item.kind !== 'file' || !item.object_key || item.size === null) throw new AccessDenied();
      const content = await bytes.read(objectPath(workspaceId, item), item.size, signal);
      if (content.byteLength !== item.size || digest(content) !== item.sha256) throw new FileError('integrity');
      const current = await authorize();
      return { ...metadata(current.item, current.role), bytes: content };
    });
  }
  async function list(workspaceId: string, userId: string, value: unknown = {}) {
    const input = z
      .strictObject({
        parentId: uuidSchema.nullable().optional(),
        query: z.string().max(255).default(''),
        trash: z.boolean().default(false),
        after: uuidSchema.optional(),
      })
      .parse(value);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      if (input.parentId) await access(tx, actor, input.parentId);
      const rows = z.array(itemSchema.extend({ level: z.number().int() })).parse(
        (
          await tx.client.query(
            `WITH RECURSIVE ancestry AS (
        SELECT id AS item_id, id AS ancestor_id, parent_id FROM ${table(tx, 'tf_files')}
        UNION SELECT a.item_id, p.id, p.parent_id FROM ancestry a JOIN ${table(tx, 'tf_files')} p ON p.id = a.parent_id
      ), authority AS (
        SELECT a.item_id, max(CASE WHEN p.creator_membership_id = $6 THEN 3
          WHEN g.role = 'manager' THEN 3 WHEN g.role = 'editor' THEN 2 WHEN g.role = 'viewer' THEN 1 ELSE 0 END) AS level,
          bool_and(p.ready AND (p.trashed_at IS NULL OR ($5 AND p.id = a.item_id))) AS visible
        FROM ancestry a JOIN ${table(tx, 'tf_files')} p ON p.id = a.ancestor_id
        LEFT JOIN ${table(tx, 'tf_file_grants')} g ON g.item_id = p.id AND
          ((g.subject_kind = 'individual' AND g.subject_id = $6) OR
           (g.subject_kind = 'team' AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt JOIN ${table(tx, 'tf_teams')} t ON t.id = mt.team_id WHERE mt.membership_id = $6 AND mt.team_id = g.subject_id)))
        GROUP BY a.item_id
      ) SELECT f.*, a.level FROM ${table(tx, 'tf_files')} f JOIN authority a ON a.item_id = f.id
        WHERE a.visible AND a.level >= CASE WHEN $5 THEN 3 ELSE 1 END
          AND ($1::uuid IS NULL OR f.id > $1) AND ($2::boolean = false OR f.parent_id IS NOT DISTINCT FROM $3::uuid)
          AND position(lower($4) in lower(f.name)) > 0 AND (f.trashed_at IS NOT NULL) = $5
        ORDER BY f.id LIMIT 101`,
            [
              input.after ?? null,
              input.parentId !== undefined,
              input.parentId ?? null,
              input.query,
              input.trash,
              actor.membershipId,
            ],
          )
        ).rows,
      );
      const page = rows.slice(0, 100);
      return {
        items: (await visibleSkillFiles(tx, actor, page, requireReadableFile)).map(item =>
          metadata(item, item.level === 3 ? 'manager' : item.level === 2 ? 'editor' : 'viewer'),
        ),
        next: rows.length > 100 ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }
  async function rename(workspaceId: string, userId: string, id: string, name: string) {
    denyMcpEgress();
    id = uuidSchema.parse(id);
    name = fileNameSchema.parse(name);
    return transaction(workspaceId, userId, true, async (tx, actor) => {
      await access(tx, actor, id, 'manager');
      await tx.client.query(`UPDATE ${table(tx, 'tf_files')} SET name = $2 WHERE id = $1`, [id, name]);
      const { item, role } = await access(tx, actor, id);
      return metadata(item, role);
    });
  }
  /** The sort keys of a cursor item the reader can still reach by ownership or grant, trashed or not. Anything else is an invalid link. */
  async function cursorKey(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
    // modified_at travels as text so the comparison keeps PostgreSQL's microseconds instead of a millisecond Date.
    const row = z
      .object({ kind: z.enum(['file', 'folder']), name: z.string(), modified_at: z.string().nullable() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `${ancestors(tx)}
      SELECT f.kind, f.name, f.modified_at::text AS modified_at FROM ${table(tx, 'tf_files')} f WHERE f.id = $1 AND f.ready AND (
        EXISTS (SELECT 1 FROM ancestors WHERE creator_membership_id = $2)
        OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_file_grants')} g JOIN ancestors a ON a.id = g.item_id
          WHERE (g.subject_kind = 'individual' AND g.subject_id = $2)
            OR (g.subject_kind = 'team' AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt WHERE mt.membership_id = $2 AND mt.team_id = g.subject_id))))`,
            [id, actor.membershipId],
          )
        ).rows[0],
      );
    if (!row) throw new FileError('invalid-cursor');
    return row;
  }
  async function library(
    workspaceId: string,
    userId: string,
    value: unknown,
  ): Promise<Omit<LibraryPage, 'owners'> & { owners: FileMember[] }> {
    const input = libraryQuerySchema.parse(value);
    const folder = input.location.kind === 'folder' ? input.location.id : null;
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const breadcrumbs: FileSummary[] = [];
      if (folder) {
        if (input.section === 'trash') throw new AccessDenied();
        const opened = await access(tx, actor, folder);
        if (opened.item.kind !== 'folder') throw new AccessDenied();
        breadcrumbs.push(...(await readablePath(tx, actor, opened.item.parent_id)), metadata(opened.item, opened.role));
      }
      const cursor = input.after === undefined ? null : await cursorKey(tx, actor, input.after);
      const { filters } = input;
      // Section roots are decided here, before LIMIT, so pagination never drops or repeats an entry point.
      // A stranded root is the topmost item the reader owns below a trashed folder; it belongs in the reader's Trash.
      // `walk` descends from the roots and hands each child its ancestors' authority (`up_*`), so every item is visited once.
      // An opened folder walks only its path and its children. Outside Trash, the walk stops below items whose descendants
      // can never be listed: hidden ones, and in a section root, owned ones (and in Shared, readable ones).
      const candidates = `WITH RECURSIVE path AS (
        SELECT id, parent_id FROM ${table(tx, 'tf_files')} WHERE id = $3
        UNION SELECT p.id, p.parent_id FROM ${table(tx, 'tf_files')} p JOIN path c ON p.id = c.parent_id
      ), granted AS (
        SELECT g.item_id, max(CASE g.role WHEN 'manager' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END) AS level FROM ${table(tx, 'tf_file_grants')} g
        WHERE (g.subject_kind = 'individual' AND g.subject_id = $1) OR
          (g.subject_kind = 'team' AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt JOIN ${table(tx, 'tf_teams')} t ON t.id = mt.team_id WHERE mt.membership_id = $1 AND mt.team_id = g.subject_id))
        GROUP BY g.item_id
      ), walk AS (
        SELECT f.id, f.name, 0 AS up_level, false AS up_owned, true AS up_clear, true AS up_ready, false AS up_trashed, false AS parent_visible, NULL::text AS parent_name,
          GREATEST(CASE WHEN f.creator_membership_id = $1 THEN 3 ELSE 0 END, COALESCE(g.level, 0)) AS own_level, f.creator_membership_id = $1 AS own_owned,
          f.ready, f.trashed_at IS NOT NULL AS trashed
        FROM ${table(tx, 'tf_files')} f LEFT JOIN granted g ON g.item_id = f.id
        WHERE f.parent_id IS NULL AND ($3::uuid IS NULL OR f.id IN (SELECT id FROM path))
        UNION ALL
        SELECT c.id, c.name, GREATEST(w.up_level, w.own_level), w.up_owned OR w.own_owned, w.up_clear AND w.ready AND NOT w.trashed,
          w.up_ready AND w.ready, w.up_trashed OR w.trashed, w.up_clear AND w.ready AND (NOT w.trashed OR $2 = 'trash'), w.name,
          GREATEST(CASE WHEN c.creator_membership_id = $1 THEN 3 ELSE 0 END, COALESCE(g.level, 0)), c.creator_membership_id = $1,
          c.ready, c.trashed_at IS NOT NULL
        FROM walk w JOIN ${table(tx, 'tf_files')} c ON c.parent_id = w.id LEFT JOIN granted g ON g.item_id = c.id
        WHERE CASE
          WHEN $3::uuid IS NOT NULL THEN w.id = $3 OR c.id IN (SELECT id FROM path)
          WHEN $2 = 'trash' THEN true
          ELSE w.up_clear AND w.ready AND NOT w.trashed AND ($4 <> '' OR (NOT (w.up_owned OR w.own_owned) AND ($2 = 'mine' OR GREATEST(w.up_level, w.own_level) = 0))) END
      ), authority AS (
        SELECT id AS item_id, GREATEST(up_level, own_level) AS level, up_owned OR own_owned AS owned,
          up_clear AND ready AND (NOT trashed OR $2 = 'trash') AS visible, up_ready AND ready AND up_trashed AND NOT up_owned AS buried,
          CASE WHEN parent_visible THEN up_level ELSE 0 END AS parent_level, parent_visible AND up_owned AS parent_owned,
          CASE WHEN parent_visible AND up_level >= 1 THEN parent_name END AS parent_name
        FROM walk
      ), candidates AS (
        SELECT f.*, a.level, ($2 = 'trash' AND f.creator_membership_id = $1 AND a.buried) AS stranded, a.parent_name
        FROM authority a JOIN ${table(tx, 'tf_files')} f ON f.id = a.item_id
        WHERE CASE WHEN $2 = 'trash' THEN (a.visible AND a.level >= 3 AND f.trashed_at IS NOT NULL) OR (f.creator_membership_id = $1 AND a.buried)
            ELSE a.visible AND a.level >= 1 AND f.trashed_at IS NULL END
          AND CASE
            WHEN $3::uuid IS NOT NULL THEN f.parent_id = $3
            WHEN $2 = 'trash' THEN true
            WHEN $4 <> '' THEN a.owned = ($2 = 'mine')
            WHEN $2 = 'mine' THEN f.creator_membership_id = $1 AND NOT a.parent_owned
            ELSE f.creator_membership_id <> $1 AND a.parent_level = 0 END
          AND position(lower($4) in lower(f.name)) > 0
      )`;
      const order = sortOrder(input.sort);
      // Owner choices come from the section before any filter, so narrowing by type, date, or owner never hides an owner from the menu.
      // They share the statement with the page; an empty page still returns one row carrying them.
      const result = z
        .array(z.object({ owners: z.array(uuidSchema) }).loose())
        .min(1)
        .parse(
          (
            await tx.client.query(
              `${candidates}
        , cursor AS (SELECT $9::text AS kind, $10::text AS name, $11::timestamptz AS modified_at, $12::uuid AS id)
        , page AS (SELECT c.* FROM candidates c CROSS JOIN cursor k
          WHERE ($5::text IS NULL OR ${typeOf('c')} = $5)
            AND ($6::timestamptz IS NULL OR c.modified_at >= $6) AND ($7::timestamptz IS NULL OR c.modified_at < $7)
            AND ($8::text IS NULL OR CASE $8 WHEN 'me' THEN c.creator_membership_id = $1 WHEN 'others' THEN c.creator_membership_id <> $1 ELSE c.creator_membership_id::text = $8 END)
            AND (k.id IS NULL OR ${order.after('c', 'k')})
          ORDER BY ${order.by('c')} LIMIT 101)
        , choices AS (SELECT array(SELECT DISTINCT creator_membership_id FROM candidates LIMIT 200) AS owners)
        SELECT p.*, h.owners FROM choices h LEFT JOIN page p ON true ORDER BY ${order.by('p')}`,
              [
                actor.membershipId,
                input.section,
                folder,
                input.query,
                filters.type ?? null,
                filters.modifiedFrom ?? null,
                filters.modifiedBefore ?? null,
                filters.owner ?? null,
                cursor?.kind ?? null,
                cursor?.name ?? null,
                cursor?.modified_at ?? null,
                input.after ?? null,
              ],
            )
          ).rows,
        );
      const choices = result[0]?.owners ?? [];
      const rows = z
        .array(
          itemSchema.extend({ level: z.number().int(), stranded: z.boolean(), parent_name: z.string().nullable() }),
        )
        .parse(result.filter(row => row.id !== null));
      const page = rows.slice(0, 100),
        last = page.at(-1);
      return {
        items: (await visibleSkillFiles(tx, actor, page, requireReadableFile)).map(item => ({
          ...metadata(item, item.level === 3 ? 'manager' : item.level === 2 ? 'editor' : 'viewer'),
          stranded: item.stranded,
          modifiedAt: item.modified_at?.toISOString() ?? null,
          parentName: item.parent_name,
        })),
        breadcrumbs,
        next: rows.length > 100 && last ? last.id : null,
        owners: await activeMembers(tx, [...new Set([...choices, ...page.map(item => item.creator_membership_id)])]),
      };
    });
  }
  async function suggestions(
    workspaceId: string,
    userId: string,
    value: unknown,
    recent = false,
  ): Promise<FileSuggestionsPage> {
    const input = fileSuggestionsQuerySchema.parse(value);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const limit = recent ? 3 : input.query === '' ? 5 : 8;
      const rows = z.array(itemSchema.extend({ level: z.number().int(), used_at: z.date().nullable() })).parse(
        (
          await tx.client.query(
            `WITH RECURSIVE ancestry AS (
        SELECT id AS item_id, id AS ancestor_id, parent_id FROM ${table(tx, 'tf_files')}
        UNION SELECT a.item_id, p.id, p.parent_id FROM ancestry a JOIN ${table(tx, 'tf_files')} p ON p.id = a.parent_id
      ), authority AS (
        SELECT a.item_id, max(CASE WHEN p.creator_membership_id = $1 THEN 3
          WHEN g.role = 'manager' THEN 3 WHEN g.role = 'editor' THEN 2 WHEN g.role = 'viewer' THEN 1 ELSE 0 END) AS level,
          bool_and(p.ready AND p.trashed_at IS NULL AND p.deleting_at IS NULL) AS visible
        FROM ancestry a JOIN ${table(tx, 'tf_files')} p ON p.id = a.ancestor_id
        LEFT JOIN ${table(tx, 'tf_file_grants')} g ON g.item_id = p.id AND
          ((g.subject_kind = 'individual' AND g.subject_id = $1) OR
           (g.subject_kind = 'team' AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt
             JOIN ${table(tx, 'tf_teams')} t ON t.id = mt.team_id WHERE mt.membership_id = $1 AND mt.team_id = g.subject_id)))
        GROUP BY a.item_id
      ), candidates AS (
        SELECT f.*, a.level, u.used_at FROM ${table(tx, 'tf_files')} f
        JOIN authority a ON a.item_id = f.id
        LEFT JOIN ${table(tx, 'tf_file_usage')} u ON u.file_id = f.id AND u.membership_id = $1
        WHERE f.kind = 'file' AND a.visible AND a.level >= 1
          AND CASE WHEN $5 THEN true WHEN $2 = '' THEN u.file_id IS NOT NULL ELSE position(lower($2) in lower(f.name)) > 0 END
      ), cursor AS (
        SELECT * FROM candidates WHERE id = $3
      )
      SELECT c.* FROM candidates c
      WHERE $3::uuid IS NULL OR CASE WHEN $5
        THEN (COALESCE(c.modified_at,c.created_at),c.id)<(SELECT COALESCE(modified_at,created_at),id FROM cursor)
        WHEN $2 = ''
        THEN (c.used_at, c.id) < (SELECT used_at, id FROM cursor)
        ELSE (lower(c.name) COLLATE "und-x-icu", c.id) > (SELECT lower(name) COLLATE "und-x-icu", id FROM cursor) END
      ORDER BY CASE WHEN $5 THEN COALESCE(c.modified_at,c.created_at) END DESC,
        CASE WHEN NOT $5 AND $2 = '' THEN c.used_at END DESC,
        CASE WHEN $2 <> '' THEN lower(c.name) COLLATE "und-x-icu" END ASC,
        CASE WHEN $2 = '' THEN c.id END DESC, CASE WHEN $2 <> '' THEN c.id END ASC
      LIMIT $4`,
            [actor.membershipId, input.query, input.after ?? null, limit + 1, recent],
          )
        ).rows,
      );
      const page = rows.slice(0, limit);
      return {
        items: (await visibleSkillFiles(tx, actor, page, requireReadableFile)).map(item =>
          metadata(item, item.level === 3 ? 'manager' : item.level === 2 ? 'editor' : 'viewer'),
        ),
        next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }
  async function recordRecentUse(workspaceId: string, userId: string, id: string) {
    return transaction(workspaceId, userId, true, (tx, actor) => recordFileUse(tx, actor, id));
  }
  async function share(workspaceId: string, userId: string, id: string, value: unknown, role: FileRole | null) {
    id = uuidSchema.parse(id);
    const subject = fileSubjectSchema.parse(value);
    role = fileRoleSchema.nullable().parse(role);
    return transaction(workspaceId, userId, true, async (tx, actor) => {
      await access(tx, actor, id, 'manager');
      const before = await recommendationAudience(tx, id);
      if (role !== null) {
        const exists = await tx.client.query(
          subject.kind === 'individual'
            ? `SELECT 1 FROM ${table(tx, 'tf_memberships')} WHERE id = $1 AND removed_at IS NULL`
            : `SELECT 1 FROM ${table(tx, 'tf_teams')} WHERE id = $1`,
          [subject.id],
        );
        if (!exists.rowCount) throw new AccessDenied();
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_file_grants')} (item_id,subject_kind,subject_id,role) VALUES ($1,$2,$3,$4)
          ON CONFLICT (item_id,subject_kind,subject_id) DO UPDATE SET role = EXCLUDED.role`,
          [id, subject.kind, subject.id, role],
        );
      } else
        await tx.client.query(
          `DELETE FROM ${table(tx, 'tf_file_grants')} WHERE item_id = $1 AND subject_kind = $2 AND subject_id = $3`,
          [id, subject.kind, subject.id],
        );
      await recommendationChanges(tx, id, before);
      return { id };
    });
  }
  async function details(workspaceId: string, userId: string, id: string) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const { item, role } = await access(tx, actor, id);
      const path = await readablePath(tx, actor, item.parent_id);
      const [owner] = await activeMembers(tx, [item.creator_membership_id]);
      return {
        item: metadata(item, role),
        owner: owner ?? null,
        path,
        pathRestricted: (path.length ? path[0]?.parentId : item.parent_id) !== null,
      };
    });
  }
  /** Members and teams a file manager may grant access to, or name in a restore review. Workspace admin status adds nothing here. */
  async function directory(workspaceId: string, userId: string, id: string) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      await access(tx, actor, id, 'manager', { traversal: 'sharing', trash: true, stranded: true });
      const teams = z
        .array(z.object({ id: uuidSchema, name: z.string() }))
        .parse((await tx.client.query(`SELECT id, name FROM ${table(tx, 'tf_teams')} ORDER BY lower(name), id`)).rows);
      return { members: await activeMembers(tx, null), teams };
    });
  }
  async function readSharing(workspaceId: string, userId: string, id: string) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      await access(tx, actor, id, 'manager', { traversal: 'sharing' });
      return sharingSnapshot(await loadSharingGraph(tx, id), actor, id);
    });
  }
  async function previewMove(workspaceId: string, userId: string, id: string, parentId: string | null) {
    workspaceId = uuidSchema.parse(workspaceId);
    id = uuidSchema.parse(id);
    parentId = uuidSchema.nullable().parse(parentId);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      await access(tx, actor, id, 'manager', { traversal: 'sharing', trash: true, stranded: true });
      await destination(tx, actor, parentId, 'sharing');
      return movePreview(await loadSharingGraph(tx, id, parentId, true), actor, workspaceId, id, parentId);
    });
  }
  async function move(
    workspaceId: string,
    userId: string,
    id: string,
    parentId: string | null,
    expectedFingerprint: string,
  ) {
    workspaceId = uuidSchema.parse(workspaceId);
    id = uuidSchema.parse(id);
    parentId = uuidSchema.nullable().parse(parentId);
    expectedFingerprint = moveFingerprintSchema.parse(expectedFingerprint);
    return transaction(workspaceId, userId, true, async (tx, actor) => {
      await access(tx, actor, id, 'manager', { traversal: 'sharing', trash: true, stranded: true });
      await destination(tx, actor, parentId, 'sharing');
      const preview = movePreview(await loadSharingGraph(tx, id, parentId, true), actor, workspaceId, id, parentId);
      if (preview.fingerprint !== expectedFingerprint) throw new FileError('conflict');
      const before = await recommendationAudience(tx, id);
      // Access admits a trashed source only when it is the item itself or stranded, so clearing trashed_at restores exactly those items.
      await tx.client.query(`UPDATE ${table(tx, 'tf_files')} SET parent_id = $2, trashed_at = NULL WHERE id = $1`, [
        id,
        parentId,
      ]);
      await recommendationChanges(tx, id, before);
      return { id, parentId };
    });
  }
  /** Restoring returns an item to its original folder only while the restorer can still add to it; otherwise the restorer chooses a destination through `move`. */
  async function trash(workspaceId: string, userId: string, id: string, trashed: boolean) {
    id = uuidSchema.parse(id);
    trashed = z.boolean().parse(trashed);
    return transaction(workspaceId, userId, true, async (tx, actor) => {
      const { item } = await access(tx, actor, id, 'manager', { trash: true });
      const before = await recommendationAudience(tx, id);
      if (!trashed && item.trashed_at !== null)
        await destination(tx, actor, item.parent_id).catch((error: unknown) => {
          if (error instanceof AccessDenied) throw new FileError('restore-destination');
          throw error;
        });
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_files')} SET trashed_at = CASE WHEN $2 THEN COALESCE(trashed_at, clock_timestamp()) ELSE NULL END WHERE id = $1`,
        [id, trashed],
      );
      await recommendationChanges(tx, id, before);
      return { id, trashed };
    });
  }
  const subtree = (tx: AuthorizationTransaction) => `WITH RECURSIVE subtree AS (
    SELECT * FROM ${table(tx, 'tf_files')} WHERE id = $1
    UNION SELECT f.* FROM ${table(tx, 'tf_files')} f JOIN subtree s ON f.parent_id = s.id
  )`;
  /** Only the owner of a Trash item who also owns everything inside it may delete it forever. */
  async function deletable(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
    const { item, role } = await access(tx, actor, id, 'manager', { trash: true });
    if (item.trashed_at === null) throw new FileError('not-trashed');
    if (item.creator_membership_id !== actor.membershipId) throw new FileError('not-owner');
    const totals = z
      .object({ files: z.coerce.number().int(), bytes: z.coerce.number().int(), blockers: z.coerce.number().int() })
      .parse(
        (
          await tx.client.query(
            `${subtree(tx)}
      SELECT count(*) FILTER (WHERE kind = 'file') AS files, COALESCE(sum(size), 0) AS bytes,
        count(*) FILTER (WHERE creator_membership_id <> $2) AS blockers FROM subtree`,
            [id, actor.membershipId],
          )
        ).rows[0],
      );
    const blockers =
      totals.blockers === 0
        ? []
        : z.array(itemSchema).parse(
            (
              await tx.client.query(
                `${subtree(tx)}
      SELECT * FROM subtree WHERE creator_membership_id <> $2 ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, lower(name) COLLATE "C", id LIMIT 20`,
                [id, actor.membershipId],
              )
            ).rows,
          );
    return {
      item: metadata(item, role),
      files: totals.files,
      bytes: totals.bytes,
      blockers,
      blockerCount: totals.blockers,
    };
  }
  async function previewDeletion(workspaceId: string, userId: string, id: string) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, userId, false, async (tx, actor) => {
      const preview = await deletable(tx, actor, id);
      const owners = await activeMembers(tx, [...new Set(preview.blockers.map(item => item.creator_membership_id))]);
      return {
        ...preview,
        blockers: preview.blockers.map(item => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          ownerMembershipId: item.creator_membership_id,
        })),
        owners,
      };
    });
  }
  /**
   * Removes the objects of one tombstoned subtree, then deletes its rows, which releases their quota.
   * Every step converges on retry: removing a missing object succeeds and the row delete matches only tombstones.
   * Any failure records `deletion_failed_at`, so the item shows a retryable failure instead of staying in progress.
   */
  async function purge(workspaceId: string, id: string): Promise<'deleted' | 'failed'> {
    try {
      // A borrowed object stays while its attachment is live. Holding the storage lock orders this read against attachment
      // cleanup, so neither side removes the object while the other still reads it. Both may remove it after that, which is
      // harmless because removing a missing object succeeds.
      const doomed = await runtime.transaction(workspaceId, compatibility, async tx => {
        await lockStorage(tx);
        const rows = z.array(itemSchema).parse(
          (
            await tx.client.query(
              `${subtree(tx)}
          SELECT * FROM subtree WHERE deleting_at IS NOT NULL AND object_key IS NOT NULL`,
              [id],
            )
          ).rows,
        );
        const borrowed = rows.filter(row => row.object_owner === 'attachment').map(row => row.id);
        const kept = new Set(
          borrowed.length === 0
            ? []
            : z
                .array(z.object({ id: uuidSchema }))
                .parse(
                  (
                    await tx.client.query(
                      `SELECT id FROM ${table(tx, 'tf_conversation_attachments')}
          WHERE id = ANY($1::uuid[]) AND state <> 'abandoned'`,
                      [borrowed],
                    )
                  ).rows,
                )
                .map(row => row.id),
        );
        return rows.filter(row => !kept.has(row.id));
      });
      for (const item of doomed) await bytes.remove(objectPath(workspaceId, item));
      await runtime.transaction(workspaceId, compatibility, async tx => {
        const ids = z
          .array(z.object({ id: uuidSchema }))
          .parse(
            (await tx.client.query(`${subtree(tx)} SELECT id FROM subtree WHERE deleting_at IS NOT NULL`, [id])).rows,
          )
          .map(row => row.id);
        await tx.client.query(`DELETE FROM ${table(tx, 'tf_file_grants')} WHERE item_id = ANY($1::uuid[])`, [ids]);
        await tx.client.query(`DELETE FROM ${table(tx, 'tf_file_copy_sources')} WHERE file_id = ANY($1::uuid[])`, [
          ids,
        ]);
        await tx.client.query(
          `DELETE FROM ${table(tx, 'tf_files')} WHERE id = ANY($1::uuid[]) AND deleting_at IS NOT NULL`,
          [ids],
        );
      });
      return 'deleted';
    } catch {
      await runtime.transaction(workspaceId, compatibility, async tx =>
        tx.client.query(
          `UPDATE ${table(tx, 'tf_files')} SET deletion_failed_at = clock_timestamp() WHERE id = $1 AND deleting_at IS NOT NULL`,
          [id],
        ),
      );
      return 'failed';
    }
  }
  /** Tombstones a Trash item so reads stop at once, then removes its bytes. A failed removal stays charged and is retried. */
  async function deleteForever(workspaceId: string, userId: string, id: string): Promise<DeletionOutcome> {
    denyMcpEgress();
    workspaceId = uuidSchema.parse(workspaceId);
    id = uuidSchema.parse(id);
    await transaction(workspaceId, userId, true, async (tx, actor) => {
      const existing = itemSchema
        .optional()
        .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'tf_files')} WHERE id = $1`, [id])).rows[0]);
      if (existing?.deleting_at) {
        if (existing.creator_membership_id !== actor.membershipId) throw new FileError('not-owner');
        return;
      }
      if ((await deletable(tx, actor, id)).blockerCount) throw new FileError('owned-by-others');
      await tx.client.query(
        `${subtree(tx)} UPDATE ${table(tx, 'tf_files')} SET deleting_at = clock_timestamp() WHERE id IN (SELECT id FROM subtree)`,
        [id],
      );
    });
    for (let attempt = 0; attempt < 2; attempt++)
      if ((await purge(workspaceId, id)) === 'deleted') return { id, state: 'deleted' };
    return { id, state: 'failed' };
  }
  /**
   * Resumes deletions left by a crash or a failed object removal. Call it from a periodic sweep.
   * Untried items go first, then the oldest failure; each failure restamps its item, so failing items rotate behind the rest.
   */
  async function sweepDeletions(workspaceId: string) {
    workspaceId = uuidSchema.parse(workspaceId);
    const roots = await runtime.transaction(workspaceId, compatibility, async tx => {
      return z.array(z.object({ id: uuidSchema })).parse(
        (
          await tx.client.query(`SELECT f.id FROM ${table(tx, 'tf_files')} f
        LEFT JOIN ${table(tx, 'tf_files')} p ON p.id = f.parent_id
        WHERE f.deleting_at IS NOT NULL AND (p.id IS NULL OR p.deleting_at IS NULL) ORDER BY f.deletion_failed_at NULLS FIRST, f.deleting_at, f.id LIMIT 10`)
        ).rows,
      );
    });
    let failed = 0;
    for (const root of roots) if ((await purge(workspaceId, root.id)) === 'failed') failed++;
    return { attempted: roots.length, failed };
  }
  async function usage(workspaceId: string, userId: string) {
    return transaction(workspaceId, userId, false, async tx => ({
      usedBytes: await chargedBytes(tx),
      quotaBytes: quota,
      maxFileBytes: maximumFileBytes,
    }));
  }
  return {
    createFolder,
    upload,
    createDerived,
    publishAttachment,
    importFile,
    download,
    read,
    summaries,
    details,
    directory,
    list,
    library,
    suggestions,
    recordRecentUse,
    rename,
    share,
    readSharing,
    previewMove,
    move,
    trash,
    previewDeletion,
    deleteForever,
    sweepDeletions,
    usage,
  };
}
import { requireSkillFileSources, visibleSkillFiles } from './skill-sources.ts';
