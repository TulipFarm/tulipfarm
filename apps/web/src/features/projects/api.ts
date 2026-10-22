import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import { loadCollaborationDirectory } from '@/lib/governance';

const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  instructions: z.string(),
  revision: z.number().int(),
  archived: z.boolean(),
  manager: z.boolean(),
});
const person = { membershipId: z.uuid(), userId: z.string(), name: z.string(), email: z.string() };
const memberSchema = z.object({ ...person, role: z.enum(['manager', 'member']) });
const sourceFileSchema = z.object({
  kind: z.literal('file'),
  fileId: z.uuid().nullable(),
  readAt: z.string(),
  available: z.boolean(),
});
const fileSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  pinned: z.boolean(),
  revisionId: z.uuid(),
  filename: z.string(),
  bytes: z.number().int(),
  updatedAt: z.string(),
  source: sourceFileSchema.nullable().default(null),
});
const fileAudienceSchema = z.object({
  readers: z.number().int(),
  files: z.array(
    z.discriminatedUnion('status', [
      z.object({ fileId: z.uuid(), status: z.literal('ready') }),
      z.object({ fileId: z.uuid(), status: z.literal('unavailable') }),
      z.object({
        fileId: z.uuid(),
        status: z.literal('audience'),
        missing: z.array(z.object({ membershipId: z.uuid(), name: z.string() })).nullable(),
      }),
    ]),
  ),
});
const detailSchema = z.object({ project: projectSchema, members: z.array(memberSchema), files: z.array(fileSchema) });
const sourceSchema = z.object({ title: z.string(), filename: z.string(), content: z.string() });
export type Project = z.infer<typeof projectSchema>;
export type ProjectMember = z.infer<typeof memberSchema>;
export type ProjectFile = z.infer<typeof fileSchema>;
export type ProjectDetail = z.infer<typeof detailSchema>;
export type ProjectEdit = { expectedRevision: number; name: string; instructions: string; archived: boolean };

const messages: Record<string, string> = {
  'project-conflict':
    'This project changed, is archived, or is over its 20 MB knowledge limit. Refresh it and try again. Your edits are kept.',
  'unsupported-file':
    'This file type is not supported. Upload a text, Markdown, JSON, code, PDF, or Word (.docx) file.',
  'unreadable-file':
    'TulipFarm could not read text from this file. Check that it is not empty, protected, or larger than 10 MB.',
  'project-manager-required':
    'Make another current member a manager before you leave, step down, or remove the last manager.',
  'project-not-found': 'This project is unavailable or your access changed.',
  'project-file-audience': 'Someone in this project can’t open this file anymore. Check access again.',
  'project-source-unavailable':
    'The file this text came from was deleted, moved to Trash, or is no longer shared with everyone in this project. Chats don’t use it.',
  'projects-unavailable': 'Projects are not ready in this workspace yet. Try again in a few minutes.',
};

export function projectApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`;
  async function fail(response: Response): Promise<never> {
    const code = responseError(await readJson(response, true), 'project-operation-failed');
    throw new TableRequestError(
      response.status,
      code,
      messages[code] ??
        (response.status === 413
          ? 'This file is larger than 10 MB.'
          : 'Could not complete the project request. Check your connection and try again.'),
    );
  }
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    if (!response.ok) await fail(response);
    return readJson(response);
  }
  return {
    list: async (signal: AbortSignal) => z.array(projectSchema).parse(await request('', 'GET', undefined, signal)),
    read: async (id: string, signal: AbortSignal) =>
      detailSchema.parse(await request(`/${id}`, 'GET', undefined, signal)),
    // Any member may read the collaboration directory: names, avatars, and email addresses only.
    candidates: async (signal: AbortSignal) =>
      (await loadCollaborationDirectory(workspaceId, signal)).members.map(member => ({
        membershipId: member.id,
        name: member.name,
        email: member.email,
      })),
    source: async (id: string, revisionId: string, signal: AbortSignal) =>
      sourceSchema.parse(await request(`/${id}/sources/${revisionId}`, 'GET', undefined, signal)),
    create: async (id: string, name: string) => projectSchema.parse(await request(`/${id}`, 'PUT', { name })),
    edit: async (id: string, edit: ProjectEdit) => projectSchema.parse(await request(`/${id}`, 'PATCH', edit)),
    member: async (id: string, input: { membershipId: string; role: ProjectMember['role']; removed: boolean }) =>
      request(`/${id}/members`, 'PUT', input),
    saveText: async (
      id: string,
      knowledgeId: string,
      input: { revisionId: string; expectedRevision: string | null; title: string; content: string },
    ) => request(`/${id}/knowledge/${knowledgeId}`, 'PUT', input),
    /** Whether everyone who reads the project can open each file. Names come back only for files the requester manages. */
    fileAudience: async (id: string, fileIds: readonly string[], signal: AbortSignal) =>
      fileAudienceSchema.parse(await request(`/${id}/file-audience`, 'POST', { fileIds }, signal)),
    /** Saves the text of a file from Files as a project file bound to that source. Retrying with the same command converges. */
    addFile: async (id: string, input: { fileId: string; commandId: string }) =>
      z
        .object({ id: z.uuid(), revisionId: z.uuid() })
        .parse(await request(`/${id}/files`, 'POST', input, AbortSignal.timeout(60000))),
    knowledgeState: async (id: string, knowledgeId: string, input: { pinned: boolean; removed: boolean }) =>
      request(`/${id}/knowledge/${knowledgeId}`, 'PATCH', input),
    async upload(id: string, knowledgeId: string, revisionId: string, file: File) {
      const query = new URLSearchParams({ revisionId, filename: file.name });
      const response = await fetch(`${base}/${id}/knowledge/${knowledgeId}/file?${query}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) await fail(response);
      return readJson(response);
    },
  };
}
export type ProjectApi = ReturnType<typeof projectApi>;
