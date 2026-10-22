import { z } from 'zod';
import {
  skillImportViewSchema,
  skillPreviewSchema,
  type skillImportDecisionSchema,
  type skillImportInputSchema,
} from '@tulipfarm/agents/skill-import-contracts';
import { workspaceSkillReceiptSchema } from '@tulipfarm/agents/workspace-skill-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export const importErrors: Record<string, string> = {
  'source-unsupported': 'Use a public skills.sh, GitHub, or HTTPS skill package link.',
  'source-unavailable': 'The source could not be read. Check that the link is public, then try again.',
  'source-rate-limit': 'The source is limiting downloads. Wait a few minutes, then try again.',
  'invalid-package': 'This is not a complete skill package. Ask its author for a package with a valid SKILL.md.',
  'package-limit':
    'This request exceeds a package or pending-import limit. Cancel unused imports or choose a smaller package.',
  'package-quota': 'Workspace storage is full. Free space before trying again.',
  'import-expired': 'This review expired. Find the source again to prepare a new review.',
  'import-conflict': 'This review or target changed. Check its current status before continuing.',
  'review-required': 'Read the warnings and any local-change replacement notice before installing.',
  'package-unavailable': 'The package is unavailable. Check the source and prepare it again.',
  'runtime-unavailable':
    'The isolated script runner is unavailable. Ask a workspace operator to check it, then retry this decision.',
  'credits-unavailable': 'The safety review needs more Credits. Check workspace Credits, then start a new review.',
};
export function skillImportApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${workspaceId}/skill-imports`;
  async function request(id: string, suffix: string, method: string, body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}/${id}${suffix}`, {
      method,
      ...(body === undefined ? {} : { body }),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    const value = await readJson(response);
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(value).data?.error ?? 'skill-import-unavailable';
      throw new TableRequestError(
        response.status,
        code,
        importErrors[code] ??
          ([401, 403, 404].includes(response.status)
            ? 'This import is unavailable or your access changed.'
            : 'Could not confirm the import request. Check its status, or retry the same request.'),
      );
    }
    return value;
  }
  return {
    preview: async (id: string, candidateId: string, path: string, offset: number, signal: AbortSignal) =>
      skillPreviewSchema.parse(
        await request(
          id,
          `/packages/${candidateId}/file?${new URLSearchParams({ path, offset: String(offset) })}`,
          'GET',
          undefined,
          signal,
        ),
      ),
    prepare: async (id: string, input: z.infer<typeof skillImportInputSchema>) =>
      skillImportViewSchema.parse(await request(id, '', 'PUT', input)),
    read: async (id: string, signal?: AbortSignal) =>
      skillImportViewSchema.parse(await request(id, '', 'GET', undefined, signal)),
    select: async (id: string, selected: string[]) =>
      skillImportViewSchema.parse(await request(id, '/selection', 'PUT', { selected })),
    cancel: async (id: string) => skillImportViewSchema.parse(await request(id, '/cancel', 'POST')),
    approve: async (id: string, input: z.input<typeof skillImportDecisionSchema>) =>
      z.array(workspaceSkillReceiptSchema).parse(await request(id, '/decision', 'PUT', input)),
  };
}
