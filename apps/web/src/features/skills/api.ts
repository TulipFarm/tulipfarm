import { z } from 'zod';
import { skillHistoryPageSchema } from '@tulipfarm/agents/skill-import-contracts';
import {
  workspaceSkillSummarySchema,
  workspaceSkillDefinitionSchema,
  workspaceSkillDeletionSchema,
  workspaceSkillLifecycleSchema,
  workspaceSkillQuerySchema,
  workspaceSkillReceiptSchema,
} from '@tulipfarm/agents/workspace-skill-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import { skillSharingSchema } from '@tulipfarm/agents/workspace-skill-contracts';
import {
  skillImportViewSchema,
  skillProvenanceSchema,
  skillPreviewSchema,
} from '@tulipfarm/agents/skill-import-contracts';

const item = workspaceSkillSummarySchema;
const page = z.object({ workspace: z.array(item), nextCursor: z.string().nullable() });
const detail = z.object({
  id: z.uuid(),
  revision: z.string(),
  definition: workspaceSkillDefinitionSchema,
  reviewedDefinition: workspaceSkillDefinitionSchema.nullable().default(null),
  management: workspaceSkillReceiptSchema.nullable(),
  canReview: z.boolean(),
  lifecycle: z.enum(['active', 'archived']).default('active'),
  canManageLifecycle: z.boolean().default(false),
});
export type SkillDetail = z.infer<typeof detail>;
export type SkillReceipt = z.infer<typeof workspaceSkillReceiptSchema>;
export type SkillListView = Exclude<z.infer<typeof workspaceSkillQuerySchema>['view'], 'reviewed'>;
export type SkillCommand = { requestId: string; expectedVersion: number } & (
  | { kind: 'review'; revision: string }
  | { kind: 'enable'; enabled: boolean }
  | { kind: 'lifecycle'; lifecycle: z.infer<typeof workspaceSkillLifecycleSchema> }
);
export type SkillLifecycleCommand = Extract<SkillCommand, { kind: 'lifecycle' }>;
const commandRoutes = {
  review: ['/review', 'POST'],
  enable: ['/enabled', 'PUT'],
  lifecycle: ['/lifecycle', 'PUT'],
} as const satisfies Record<SkillCommand['kind'], readonly [string, string]>;
const conflicts = new Map([
  [
    'runtime-unavailable',
    'The isolated script runner is unavailable. Ask a workspace operator to check it before enabling this skill.',
  ],
  ['skill-in-use', "Agents now use this skill, so it wasn't deleted. Archive it instead."],
  ['skill-archived', 'This skill is archived. Restore it to edit or review it. Your edits are retained.'],
]);
export function skillApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${workspaceId}/skills`;
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    const value = await readJson(response);
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(value).data?.error ?? 'skill-operation-unavailable';
      throw new TableRequestError(
        response.status,
        code,
        response.status === 409
          ? (conflicts.get(code) ??
              'This skill changed. Refresh and review the saved version before trying again. Your edits are retained.')
          : [401, 403, 404].includes(response.status)
            ? 'This skill is unavailable or your access has changed.'
            : 'Could not complete the skill request. Your edits are retained.',
      );
    }
    return value;
  }
  return {
    history: async (id: string, offset: number, signal: AbortSignal) =>
      skillHistoryPageSchema.parse(await request(`/${id}/history?offset=${offset}`, 'GET', undefined, signal)),
    runtime: async (id: string, signal: AbortSignal) =>
      z
        .strictObject({ available: z.boolean(), profile: z.literal('skill-runtime-v1') })
        .parse(await request(`/${id}/runtime`, 'GET', undefined, signal)),
    preview: async (id: string, revision: string, path: string, offset: number, signal: AbortSignal) =>
      skillPreviewSchema.parse(
        await request(
          `/${id}/revisions/${revision}/file?${new URLSearchParams({ path, offset: String(offset) })}`,
          'GET',
          undefined,
          signal,
        ),
      ),
    provenance: async (id: string, signal: AbortSignal) =>
      skillProvenanceSchema.nullable().parse(await request(`/${id}/provenance`, 'GET', undefined, signal)),
    update: async (id: string, importId: string) =>
      skillImportViewSchema.parse(await request(`/${id}/updates/${importId}`, 'PUT')),
    sharing: async (id: string, signal: AbortSignal) =>
      skillSharingSchema.parse(await request(`/${id}/sharing`, 'GET', undefined, signal)),
    share: async (id: string, input: z.infer<typeof skillSharingSchema>) => request(`/${id}/sharing`, 'PUT', input),
    reviewed: async (signal: AbortSignal, after?: string, search = '', limit?: number) =>
      page.parse(
        await request(
          `?${new URLSearchParams({ view: 'reviewed', ...(after ? { after } : {}), ...(search ? { search } : {}), ...(limit ? { limit: String(limit) } : {}) })}`,
          'GET',
          undefined,
          signal,
        ),
      ),
    list: async (signal: AbortSignal, after?: string, search = '', view: SkillListView = 'visible') =>
      page.parse(
        await request(
          `?${new URLSearchParams({ ...(view === 'visible' ? {} : { view }), ...(after ? { after } : {}), ...(search ? { search } : {}) })}`,
          'GET',
          undefined,
          signal,
        ),
      ),
    read: async (id: string, signal: AbortSignal) => detail.parse(await request(`/${id}`, 'GET', undefined, signal)),
    deletion: async (id: string, signal: AbortSignal) =>
      workspaceSkillDeletionSchema.parse(await request(`/${id}/deletion`, 'GET', undefined, signal)),
    send: async (id: string, command: SkillCommand) => {
      const { kind, ...input } = command;
      const [path, method] = commandRoutes[kind];
      return workspaceSkillReceiptSchema.parse(await request(`/${id}${path}`, method, input));
    },
  };
}
