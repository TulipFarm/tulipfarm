import { z } from 'zod';
import {
  importSystemPackageSchema,
  installationListSchema,
  installationReviewSchema,
  installationApprovalSchema,
  packageValidationSchema,
  systemPackageInstallationSchema,
  validateSystemPackageSchema,
  type SystemPackage,
} from '@tulipfarm/agents/system-package-contracts';
import { providerIntegrationSchema } from '@tulipfarm/workflows/contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { loadCollaborationDirectory, loadGovernance, loadOwnMembership } from '@/lib/governance';
import { agentApi } from '@/features/agents/api';
import { skillApi } from '@/features/skills/api';
import { filesApi } from '@/features/files/api';
import { mcpApi } from '@/features/workspace-mcp/api';
import { TableRequestError } from '@/features/tables/request-state';

export type PackageImport = z.infer<typeof importSystemPackageSchema>;
export type PackageReview = z.infer<typeof installationReviewSchema>;
export type PackageValidation = z.infer<typeof packageValidationSchema>;

const messages: Record<string, string> = {
  'version-conflict': 'The installation changed. Refresh it before deciding.',
  'idempotency-conflict': 'This operation already has different inputs. Check its saved installation.',
  'access-denied': 'Your current membership cannot perform this operation.',
  'invalid-request': 'Check the package and its workspace inputs.',
  'package-invalid': 'The package is not compatible with this workspace.',
  'installation-not-found': 'This installation is unavailable to your membership.',
  'review-stale': 'This review is no longer current. Refresh the installation.',
};

export function systemPackageApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      body,
      signal: requestSignal(signal),
      cache: 'no-store',
    });
    const value = await readJson(response, true);
    if (!response.ok) {
      const error = z
        .object({
          error: z.string(),
          issues: z.array(z.object({ message: z.string() })).optional(),
        })
        .safeParse(value);
      const code = error.success ? error.data.error : 'package-operation-unavailable';
      throw new TableRequestError(
        response.status,
        code,
        error.success && error.data.issues?.length
          ? error.data.issues.map(issue => issue.message).join(' ')
          : (messages[code] ?? `The package operation could not finish (${code}). Check its saved status.`),
      );
    }
    return value;
  }
  const installations = '/system-package-installations';
  return {
    validate: async (input: z.infer<typeof validateSystemPackageSchema>) =>
      packageValidationSchema.parse(await request('/system-packages/validate', 'POST', input)),
    import: async (input: PackageImport) =>
      systemPackageInstallationSchema.parse(await request(installations, 'POST', input)),
    list: async (signal: AbortSignal, after?: string, chatId?: string) =>
      installationListSchema.parse(
        await request(
          `${installations}?${new URLSearchParams({ ...(after ? { after } : {}), ...(chatId ? { chatId } : {}) })}`,
          'GET',
          undefined,
          signal,
        ),
      ),
    read: async (id: string, signal: AbortSignal) =>
      systemPackageInstallationSchema.parse(
        await request(`${installations}/${encodeURIComponent(id)}`, 'GET', undefined, signal),
      ),
    resume: async (id: string, expectedVersion: number) =>
      systemPackageInstallationSchema.parse(
        await request(`${installations}/${encodeURIComponent(id)}/resume`, 'POST', { expectedVersion }),
      ),
    approve: async (id: string, input: z.infer<typeof installationApprovalSchema>) =>
      systemPackageInstallationSchema.parse(
        await request(`${installations}/${encodeURIComponent(id)}/approve`, 'POST', input),
      ),
    review: async (id: string, input: PackageReview) =>
      systemPackageInstallationSchema.parse(
        await request(`${installations}/${encodeURIComponent(id)}/review`, 'POST', input),
      ),
    choices: async (
      kind: SystemPackage['inputs'][number]['kind'],
      signal: AbortSignal,
      after?: string,
      search = '',
    ): Promise<{ items: { id: string; label: string }[]; nextCursor: string | null }> => {
      if (kind === 'agent') {
        const page = await agentApi(workspaceId).list(signal, after, search);
        return { items: page.agents.map(item => ({ id: item.id, label: item.name })), nextCursor: page.nextCursor };
      }
      if (kind === 'skill') {
        const page = await skillApi(workspaceId).reviewed(signal, after, search);
        return {
          items: page.workspace.map(item => ({ id: item.id, label: `${item.name} (${item.revision.slice(0, 8)})` })),
          nextCursor: page.nextCursor,
        };
      }
      if (kind === 'file') {
        const page = await filesApi(workspaceId).suggestions(search, signal, after);
        return {
          items: page.items.filter(item => item.kind === 'file').map(item => ({ id: item.id, label: item.name })),
          nextCursor: page.next,
        };
      }
      if (kind === 'connection') {
        const mcp = mcpApi(workspaceId);
        const [connections, enabled] = await Promise.all([
          request('/workflows/provider-integrations', 'GET', undefined, signal).then(value =>
            providerIntegrationSchema.array().parse(value),
          ),
          mcp.capabilities(signal),
        ]);
        const remote = enabled.enabled ? (await mcp.integrations(signal)).integrations : [];
        return {
          items: [
            ...connections
              .filter(item => item.enabled && item.authorized)
              .map(item => ({
                id: item.id,
                label: `${item.name} (${item.source.provider})`,
              })),
            ...remote
              .filter(item => item.ownership === 'shared' && item.canUse && item.status === 'ready')
              .map(item => ({ id: item.id, label: `${item.name} (MCP)` })),
          ],
          nextCursor: null,
        };
      }
      if (kind === 'slack-destination') {
        const page = z
          .object({ destinations: z.array(z.object({ id: z.uuid(), name: z.string() })) })
          .parse(await request('/slack/destinations', 'GET', undefined, signal));
        return { items: page.destinations.map(item => ({ id: item.id, label: item.name })), nextCursor: null };
      }
      if (kind === 'integration') {
        const providers = providerIntegrationSchema
          .array()
          .parse(await request('/workflows/provider-integrations', 'GET', undefined, signal));
        return {
          items: providers
            .filter(provider => provider.authorized && provider.enabled)
            .map(provider => ({
              id: provider.id,
              label: `${provider.name} (${provider.source.provider})`,
            })),
          nextCursor: null,
        };
      }
      const own = await loadOwnMembership(workspaceId, signal);
      if (kind === 'member') {
        const directory = await loadCollaborationDirectory(workspaceId, signal);
        return {
          items: directory.members.map(member => ({
            id: member.id,
            label: member.id === own.membershipId ? 'You (installation owner)' : member.name || member.email,
          })),
          nextCursor: null,
        };
      }
      const teams = own.capabilities.manageGovernance ? (await loadGovernance(workspaceId, signal)).teams : own.teams;
      return { items: teams.map(team => ({ id: team.id, label: team.name })), nextCursor: null };
    },
  };
}
export type SystemPackageApi = ReturnType<typeof systemPackageApi>;
