import { createHash, randomUUID } from 'node:crypto';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';
import { z } from 'zod';
import {
  AccessDenied,
  denyMcpEgress,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { createFiles } from '@tulipfarm/files';
import {
  createProjectMembership,
  projectReaders,
  requireProjectAccess,
  ProjectConflict,
} from './project-membership.ts';
import { resolveFileAudience } from './file-references.ts';
import {
  isSourceBoundRevision,
  projectFileIds,
  projectSourceFile,
  usableProjectSources,
} from './project-file-sources.ts';
export { projectSourceFile };
import { extractKnowledge, readableKnowledgeText } from './knowledge-extraction.ts';
import { selectProjectContext, type ProjectContext } from './project-context.ts';
import type { ConversationRuntime } from './runtime.ts';
import type { createAttachments } from './attachments.ts';

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
export const projectCompatibility = commonCompatibility;
const knowledgeQuotaBytes = 20 * 1024 * 1024;
export const projectContextBudgetBytes = 96 * 1024;
const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(value => !/[\0/\\]/.test(value), 'Unsafe filename');
export const knowledgeInputSchema = z.strictObject({
  revisionId: uuidSchema,
  expectedRevision: uuidSchema.nullable(),
  title: z.string().trim().min(1).max(255),
  content: z.string().min(1).max(1048576),
});
export const knowledgeUploadSchema = z.strictObject({
  revisionId: uuidSchema,
  expectedRevision: uuidSchema.nullable(),
  filename,
});
export const knowledgeStateSchema = z.strictObject({ pinned: z.boolean(), removed: z.boolean() });
export const addFileSchema = z.strictObject({ fileId: uuidSchema, commandId: uuidSchema });
export const fileAudienceSchema = z.strictObject({
  fileIds: z
    .array(uuidSchema)
    .min(1)
    .max(20)
    .refine(ids => new Set(ids).size === ids.length, 'Duplicate file'),
});
export const promoteAttachmentSchema = z.strictObject({
  chatId: uuidSchema,
  attachmentId: uuidSchema,
  id: uuidSchema,
  revisionId: uuidSchema,
});
/** Where a Files-sourced entry came from. `fileId` is null once the source is unavailable to the project audience. */
export const projectFileSourceSchema = z.object({
  kind: z.literal('file'),
  fileId: uuidSchema.nullable(),
  readAt: z.string(),
  available: z.boolean(),
});
export const knowledgeSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  pinned: z.boolean(),
  revisionId: uuidSchema,
  filename: z.string(),
  bytes: z.number().int(),
  updatedAt: z.string(),
  source: projectFileSourceSchema.nullable(),
});
export const projectSourceViewSchema = z.object({ title: z.string(), filename: z.string(), content: z.string() });

type Revision = {
  id: string;
  revisionId: string;
  expectedRevision: string | null;
  title: string;
  filename: string;
  bytes: number;
  digest: string;
  content: string;
  fromFile?: boolean;
};

/** A Files-sourced project revision whose source is no longer readable by everyone in the project. */
export class ProjectSourceUnavailable extends Error {
  constructor() {
    super('project-source-unavailable');
  }
}
/** Someone who can read the project can't read the file, or the requester can't. */
export class ProjectFileAudience extends Error {
  constructor() {
    super('project-file-audience');
  }
}

export function createProjects(
  runtime: ConversationRuntime,
  attachments?: ReturnType<typeof createAttachments>,
  files?: Pick<ReturnType<typeof createFiles>, 'download'>,
) {
  const membership = createProjectMembership(runtime, projectCompatibility);
  async function human<T>(
    workspaceId: string,
    userId: string,
    write: boolean,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), projectCompatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      return operation(tx, await resolveHuman(tx, userId));
    });
  }
  async function editable(tx: AuthorizationTransaction, actor: HumanActor, projectId: string) {
    const project = await requireProjectAccess(tx, actor, projectId, true);
    if (project.archived) throw new ProjectConflict();
  }
  async function read(workspaceId: string, userId: string, projectId: string) {
    projectId = uuidSchema.parse(projectId);
    const detail = await membership.read(workspaceId, userId, projectId);
    const entries = await human(workspaceId, userId, false, async (tx, actor) => {
      await requireProjectAccess(tx, actor, projectId);
      const rows = z.array(knowledgeSchema.omit({ source: true }).extend({ digest: z.string() })).parse(
        (
          await tx.client.query(
            `SELECT k.id,k.title,k.pinned,k.current_revision AS "revisionId",r.filename,r.bytes,r.digest,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
        FROM ${table(tx, 'tf_project_knowledge')} k JOIN ${table(tx, 'tf_project_knowledge_revisions')} r ON r.id=k.current_revision
        WHERE k.project_id=$1 AND k.removed_at IS NULL ORDER BY k.pinned DESC,lower(k.title),k.id`,
            [projectId],
          )
        ).rows,
      );
      const usable = await usableProjectSources(tx, projectId, rows);
      return rows.map(({ digest: _digest, ...row }) => {
        const fileId = projectSourceFile(projectId, row.id, row.revisionId);
        const available = usable.has(row.revisionId);
        return {
          ...row,
          source: fileId
            ? { kind: 'file' as const, fileId: available ? fileId : null, readAt: row.updatedAt, available }
            : null,
        };
      });
    });
    return { ...detail, files: entries };
  }
  async function source(workspaceId: string, userId: string, projectId: string, revisionId: string) {
    projectId = uuidSchema.parse(projectId);
    return human(workspaceId, userId, false, async (tx, actor) => {
      await requireProjectAccess(tx, actor, projectId);
      const row = projectSourceViewSchema
        .extend({ id: uuidSchema, revisionId: uuidSchema, digest: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT k.id,r.id AS "revisionId",r.digest,k.title,r.filename,r.content FROM ${table(tx, 'tf_project_knowledge_revisions')} r JOIN ${table(tx, 'tf_project_knowledge')} k ON k.id=r.knowledge_id WHERE r.id=$1 AND k.project_id=$2`,
              [uuidSchema.parse(revisionId), projectId],
            )
          ).rows[0],
        );
      if (!row) throw new AccessDenied();
      if (!(await usableProjectSources(tx, projectId, [row])).has(row.revisionId)) throw new ProjectSourceUnavailable();
      return { title: row.title, filename: row.filename, content: row.content };
    });
  }
  async function save(workspaceId: string, userId: string, projectId: string, revision: Revision) {
    return human(workspaceId, userId, true, async (tx, actor) => {
      await editable(tx, actor, projectId);
      if (isSourceBoundRevision(revision.revisionId) !== Boolean(revision.fromFile)) throw new ProjectConflict();
      if (revision.fromFile) {
        if (
          !(
            await usableProjectSources(tx, projectId, [
              { id: revision.id, revisionId: revision.revisionId, digest: revision.digest },
            ])
          ).has(revision.revisionId)
        )
          throw new ProjectFileAudience();
      }
      const prior = (
        await tx.client.query(
          `SELECT k.project_id,k.current_revision,k.removed_at,r.digest,r.filename FROM ${table(tx, 'tf_project_knowledge')} k JOIN ${table(tx, 'tf_project_knowledge_revisions')} r ON r.id=k.current_revision WHERE k.id=$1 FOR UPDATE OF k`,
          [revision.id],
        )
      ).rows[0];
      if (prior && prior.project_id !== projectId) throw new AccessDenied();
      if (prior?.current_revision === revision.revisionId) {
        if (prior.digest !== revision.digest || prior.filename !== revision.filename) throw new ProjectConflict();
        return { id: revision.id };
      }
      if ((prior?.current_revision ?? null) !== revision.expectedRevision) throw new ProjectConflict();
      const used = Number(
        (
          await tx.client.query(
            `SELECT COALESCE(sum(r.bytes),0) AS bytes FROM ${table(tx, 'tf_project_knowledge')} k JOIN ${table(tx, 'tf_project_knowledge_revisions')} r ON r.id=k.current_revision WHERE k.project_id=$1 AND k.removed_at IS NULL AND k.id<>$2`,
            [projectId, revision.id],
          )
        ).rows[0]?.bytes,
      );
      if (used + revision.bytes > knowledgeQuotaBytes) throw new ProjectConflict();
      if (!prior)
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_project_knowledge')} (id,project_id,title,current_revision) VALUES ($1,$2,$3,$4)`,
          [revision.id, projectId, revision.title, revision.revisionId],
        );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_project_knowledge_revisions')} (id,knowledge_id,filename,digest,bytes,content,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          revision.revisionId,
          revision.id,
          revision.filename,
          revision.digest,
          revision.bytes,
          revision.content,
          actor.membershipId,
        ],
      );
      if (prior)
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_project_knowledge')} SET title=$2,current_revision=$3,removed_at=NULL WHERE id=$1`,
          [revision.id, revision.title, revision.revisionId],
        );
      if (!prior || prior.digest !== revision.digest || prior.removed_at !== null) {
        await recordRecommendationChange(tx, {
          id: randomUUID(),
          kind: 'project',
          sourceId: projectId,
          membershipIds: (await projectReaders(tx, projectId)).map(reader => reader.membershipId),
          invalidate: Boolean(prior),
        });
      }
      return { id: revision.id };
    });
  }
  async function upload(
    workspaceId: string,
    userId: string,
    projectId: string,
    id: string,
    value: unknown,
    bytes: Uint8Array,
  ) {
    denyMcpEgress();
    projectId = uuidSchema.parse(projectId);
    const input = knowledgeUploadSchema.parse(value);
    const content = await extractKnowledge(input.filename, bytes);
    return save(workspaceId, userId, projectId, {
      ...input,
      id: uuidSchema.parse(id),
      title: input.filename,
      bytes: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex'),
      content,
    });
  }
  async function saveKnowledge(workspaceId: string, userId: string, projectId: string, id: string, value: unknown) {
    denyMcpEgress();
    projectId = uuidSchema.parse(projectId);
    const input = knowledgeInputSchema.parse(value);
    const content = readableKnowledgeText(input.content);
    const bytes = Buffer.from(content);
    return save(workspaceId, userId, projectId, {
      id: uuidSchema.parse(id),
      revisionId: input.revisionId,
      expectedRevision: input.expectedRevision,
      title: input.title,
      filename: `${input.title.replace(/[/\\]/g, '-')}.txt`.slice(-255),
      bytes: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex'),
      content,
    });
  }
  async function knowledgeState(workspaceId: string, userId: string, projectId: string, id: string, value: unknown) {
    denyMcpEgress();
    projectId = uuidSchema.parse(projectId);
    const input = knowledgeStateSchema.parse(value);
    return human(workspaceId, userId, true, async (tx, actor) => {
      await editable(tx, actor, projectId);
      const previous = (
        await tx.client.query(
          `SELECT pinned,removed_at IS NOT NULL AS removed FROM ${table(tx, 'tf_project_knowledge')} WHERE id=$1 AND project_id=$2`,
          [uuidSchema.parse(id), projectId],
        )
      ).rows[0];
      if (
        !(
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_project_knowledge')} SET pinned=$3,removed_at=CASE WHEN $4 THEN COALESCE(removed_at,clock_timestamp()) ELSE NULL END WHERE id=$1 AND project_id=$2 RETURNING id`,
            [uuidSchema.parse(id), projectId, input.pinned, input.removed],
          )
        ).rowCount
      )
        throw new AccessDenied();
      if (previous.removed !== input.removed || previous.pinned !== input.pinned) {
        await recordRecommendationChange(tx, {
          id: randomUUID(),
          kind: 'project',
          sourceId: projectId,
          membershipIds: (await projectReaders(tx, projectId)).map(reader => reader.membershipId),
          invalidate: input.removed,
        });
      }
      return { id };
    });
  }
  async function promote(workspaceId: string, userId: string, projectId: string, value: unknown) {
    denyMcpEgress();
    projectId = uuidSchema.parse(projectId);
    const input = promoteAttachmentSchema.parse(value);
    await human(workspaceId, userId, false, async (tx, actor) => {
      await editable(tx, actor, projectId);
      if (
        !(
          await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_conversations')} WHERE id=$1 AND project_id=$2`, [
            input.chatId,
            projectId,
          ])
        ).rowCount
      )
        throw new AccessDenied();
    });
    if (!attachments) throw new AccessDenied();
    const file = await attachments.download(workspaceId, userId, input.chatId, input.attachmentId);
    return upload(
      workspaceId,
      userId,
      projectId,
      input.id,
      { revisionId: input.revisionId, expectedRevision: null, filename: file.filename },
      file.bytes,
    );
  }
  /** Before Add to project: can everyone who reads the project open each file? Adding checks again. */
  async function fileAudience(workspaceId: string, userId: string, projectId: string, value: unknown) {
    projectId = uuidSchema.parse(projectId);
    const { fileIds } = fileAudienceSchema.parse(value);
    return human(workspaceId, userId, false, async (tx, actor) => {
      await editable(tx, actor, projectId);
      return {
        readers: (await projectReaders(tx, projectId)).length,
        files: await resolveFileAudience(tx, actor, projectId, fileIds),
      };
    });
  }
  /**
   * Add to project: copies the text of a file the whole project can read into a new revision of that file's project entry.
   * The revision stays bound to its source, so later revocation or deletion of the file removes it from project context.
   */
  async function addFile(workspaceId: string, userId: string, projectId: string, value: unknown) {
    denyMcpEgress();
    projectId = uuidSchema.parse(projectId);
    const input = addFileSchema.parse(value);
    const { knowledgeId, revisionId } = projectFileIds(projectId, input.fileId, input.commandId);
    const expectedRevision = await human(workspaceId, userId, false, async (tx, actor) => {
      await editable(tx, actor, projectId);
      const audience = (await resolveFileAudience(tx, actor, projectId, [input.fileId]))[0];
      if (audience?.status === 'unavailable') throw new AccessDenied();
      if (audience?.status !== 'ready') throw new ProjectFileAudience();
      return z
        .string()
        .nullable()
        .parse(
          (
            await tx.client.query(
              `SELECT current_revision FROM ${table(tx, 'tf_project_knowledge')} WHERE id=$1 AND project_id=$2`,
              [knowledgeId, projectId],
            )
          ).rows[0]?.current_revision ?? null,
        );
    });
    if (!files) throw new AccessDenied();
    const file = await files.download(workspaceId, userId, input.fileId);
    const content = await extractKnowledge(file.name, file.bytes);
    await save(workspaceId, userId, projectId, {
      id: knowledgeId,
      revisionId,
      expectedRevision,
      title: file.name,
      filename: file.name,
      bytes: file.bytes.byteLength,
      digest: createHash('sha256').update(file.bytes).digest('hex'),
      content,
      fromFile: true,
    });
    return { id: knowledgeId, revisionId };
  }
  async function candidates(workspaceId: string, userId: string, projectId: string) {
    projectId = uuidSchema.parse(projectId);
    return human(workspaceId, userId, false, async (tx, actor) => {
      await requireProjectAccess(tx, actor, projectId, true);
      return z
        .array(z.object({ membershipId: uuidSchema, userId: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT id AS "membershipId",user_id AS "userId" FROM ${table(tx, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY user_id`,
            )
          ).rows,
        );
    });
  }
  return {
    ...membership,
    read,
    source,
    upload,
    saveKnowledge,
    knowledgeState,
    promote,
    fileAudience,
    addFile,
    candidates,
  };
}

export async function captureProjectContext(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  projectId: string,
  query: string,
): Promise<ProjectContext> {
  const project = await requireProjectAccess(tx, actor, projectId);
  const rows = z
    .array(
      z.object({
        id: uuidSchema,
        revisionId: uuidSchema,
        title: z.string(),
        pinned: z.boolean(),
        content: z.string(),
        digest: z.string(),
      }),
    )
    .parse(
      (
        await tx.client.query(
          `SELECT k.id,r.id AS "revisionId",k.title,k.pinned,r.content,r.digest FROM ${table(tx, 'tf_project_knowledge')} k JOIN ${table(tx, 'tf_project_knowledge_revisions')} r ON r.id=k.current_revision WHERE k.project_id=$1 AND k.removed_at IS NULL ORDER BY k.id`,
          [projectId],
        )
      ).rows,
    );
  const usable = await usableProjectSources(tx, projectId, rows);
  const files = rows.filter(row => usable.has(row.revisionId)).map(({ digest: _digest, ...file }) => file);
  const unavailable = rows
    .filter(row => !usable.has(row.revisionId))
    .map(({ id, revisionId, title }) => ({ id, revisionId, title }));
  return selectProjectContext(
    { projectId, revision: project.revision, instructions: project.instructions, files, unavailable },
    query,
    projectContextBudgetBytes,
  );
}

/** A turn's saved project context, without any source-bound file the project audience can no longer read or whose source content changed since capture. */
export async function recheckProjectContext(
  tx: AuthorizationTransaction,
  context: ProjectContext,
): Promise<ProjectContext> {
  const digests = new Map(
    z
      .array(z.object({ id: uuidSchema, digest: z.string() }))
      .parse(
        (
          await tx.client.query(
            `SELECT id,digest FROM ${table(tx, 'tf_project_knowledge_revisions')} WHERE id=ANY($1::uuid[])`,
            [context.files.map(file => file.revisionId)],
          )
        ).rows,
      )
      .map(row => [row.id, row.digest]),
  );
  const usable = await usableProjectSources(
    tx,
    context.projectId,
    context.files.map(file => ({ ...file, digest: digests.get(file.revisionId) ?? '' })),
  );
  const dropped = context.files.filter(file => !usable.has(file.revisionId));
  if (!dropped.length) return context;
  const unavailable = [...context.unavailable];
  for (const file of dropped)
    if (!unavailable.some(entry => entry.revisionId === file.revisionId))
      unavailable.push({ id: file.id, revisionId: file.revisionId, title: file.title });
  return { ...context, files: context.files.filter(file => usable.has(file.revisionId)), unavailable };
}
