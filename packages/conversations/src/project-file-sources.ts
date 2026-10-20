import { createHash } from 'node:crypto';
import { uuidSchema, type AuthorizationTransaction, type SourceDependency } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { fileReaders } from '@tulipfarm/files';
import { projectReaders } from './project-membership.ts';

/*
 * A project file added from Files keeps its source identity without a schema change.
 * The entry id is the file id XOR a per-project mask that leaves the UUID version and variant bits untouched,
 * so the file id is recoverable. A source-bound revision id is a version 8 UUID; uploads and pasted text never are.
 * The revision row already holds the content digest, and its created_at is the read time.
 */

const hex = (value: string) => Buffer.from(value.replaceAll('-', ''), 'hex');
const uuid = (bytes: Buffer) =>
  uuidSchema.parse(bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
const hash = (value: string) => createHash('sha256').update(value).digest().subarray(0, 16);

function mask(projectId: string) {
  const bytes = hash(`tulipfarm-project-file:${projectId}`);
  bytes[6] = bytes[6]! & 0x0f;
  bytes[8] = bytes[8]! & 0x3f;
  return bytes;
}

function xor(id: string, projectId: string) {
  const bytes = hex(id),
    key = mask(projectId);
  return uuid(Buffer.from(bytes.map((byte, index) => byte ^ key[index]!)));
}

export const isSourceBoundRevision = (revisionId: string) => revisionId[14] === '8';

/** The project entry for a file, and the revision a promotion command writes. Retrying the command yields the same revision. */
export function projectFileIds(projectId: string, fileId: string, commandId: string) {
  const knowledgeId = xor(fileId, projectId);
  const bytes = hash(`tulipfarm-project-file-revision:${knowledgeId}:${commandId}`);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return { knowledgeId, revisionId: uuid(Buffer.from(bytes)) };
}

/** The Files item a project revision was read from, or null for uploads and pasted text. */
export function projectSourceFile(projectId: string, knowledgeId: string, revisionId: string) {
  return isSourceBoundRevision(revisionId) ? xor(knowledgeId, projectId) : null;
}

/**
 * Whether everyone who can read the project can still read the source file of these revisions.
 * Revisions without a source file are always usable. A trashed, revoked, or deleted source is not.
 * Two queries cover every reader and file: the project's readers, then their access to all source files.
 */
export async function usableProjectSources<T extends { id: string; revisionId: string; digest?: string }>(
  tx: AuthorizationTransaction,
  projectId: string,
  revisions: readonly T[],
) {
  const sources = new Map(
    revisions.map(revision => [revision.revisionId, projectSourceFile(projectId, revision.id, revision.revisionId)]),
  );
  const fileIds = [...new Set([...sources.values()].filter(fileId => fileId !== null))];
  if (!fileIds.length) return new Set(sources.keys());
  const readers = await projectReaders(tx, projectId);
  const readable = await fileReaders(tx, readers, fileIds);
  const usable = new Set<string>(),
    checked = new Set<string>();
  for (const revision of revisions) {
    if (checked.has(revision.revisionId)) continue;
    checked.add(revision.revisionId);
    const fileId = sources.get(revision.revisionId);
    const file = fileId ? readable.get(fileId) : undefined;
    const ok =
      !fileId ||
      !readers.length ||
      (file !== undefined &&
        ((revision.digest ?? null) === null || file.sha256 === revision.digest) &&
        readers.every(reader => file.readers.has(reader.membershipId)));
    if (ok) usable.add(revision.revisionId);
  }
  return usable;
}

/** File dependencies of the project passages a reply used, so later readers of the answer need access to each source file. */
export async function projectPassageFileSources(
  tx: AuthorizationTransaction,
  projectId: string,
  conversationId: string,
  membershipId: string,
  passages: readonly { id: string; revisionId: string }[],
): Promise<SourceDependency[]> {
  const bound = passages.filter(passage => projectSourceFile(projectId, passage.id, passage.revisionId) !== null);
  if (!bound.length) return [];
  const rows = z
    .array(z.object({ id: uuidSchema, knowledgeId: uuidSchema, digest: z.string(), readAt: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT id,knowledge_id AS "knowledgeId",digest,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "readAt" FROM ${qualified(tx.schema, 'tf_project_knowledge_revisions')} WHERE id=ANY($1::uuid[])`,
          [bound.map(passage => passage.revisionId)],
        )
      ).rows,
    );
  return rows.map(row => ({
    kind: 'tulipfarm-file',
    fileId: xor(row.knowledgeId, projectId),
    conversationId,
    membershipId,
    read: { readAt: row.readAt, sha256: row.digest, representation: 'extracted' },
  }));
}
