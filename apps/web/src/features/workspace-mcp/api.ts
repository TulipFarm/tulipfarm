import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import {
  actionSchema,
  actionsSchema,
  agentPermissionsSchema,
  capabilitiesSchema,
  catalogSchema,
  integrationDetailSchema,
  integrationSchema,
  permissionSlotSchema,
  selectionSchema,
  setupResultSchema,
  type PermissionSlot,
  type Selection,
  type SelectionOrigin,
  type SetupInput,
} from './contracts';

export const mcpAccessEvent = 'tulipfarm:mcp-access-lost';
export class McpRequestError extends TableRequestError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(status, code, message);
  }
}
export type PrepareMcpChat = (signal: AbortSignal, create: (requestId: string) => Promise<unknown>) => Promise<void>;
export function mcpApi(workspaceId: string, accessLost: (status: number) => void = () => {}) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/workspace-mcp`;
  const part = encodeURIComponent;
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      body,
      signal: requestSignal(signal),
      cache: 'no-store',
    });
    if (path === '/capabilities' && response.status === 404) return { enabled: false };
    const value = await readJson(response, !response.ok);
    signal?.throwIfAborted();
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) accessLost(response.status);
      const error = z
        .object({ error: z.string(), fieldErrors: z.record(z.string(), z.string()).optional() })
        .safeParse(value).data;
      throw new McpRequestError(
        response.status,
        error?.error ?? 'mcp-unavailable',
        [401, 403, 404].includes(response.status)
          ? 'MCP access changed. Previously loaded protected content has been removed.'
          : response.status === 409
            ? 'This item changed. Check current status and review your retained edits before saving again.'
            : response.status === 410
              ? 'This review expired or was invalidated. Request a fresh proposal.'
              : response.status === 422
                ? 'Review the marked fields and try again.'
                : 'The MCP operation could not be confirmed. Check current status before continuing.',
        error?.fieldErrors,
      );
    }
    return value;
  }
  const selectionPath = (origin: SelectionOrigin) => `/selections/${origin.kind}/${part(origin.id)}`;
  return {
    capabilities: async (signal: AbortSignal) =>
      capabilitiesSchema.parse(await request('/capabilities', 'GET', undefined, signal)),
    catalog: async (search: string, cursor: string, signal: AbortSignal) =>
      catalogSchema.parse(
        await request(
          `/catalog?${new URLSearchParams({ search, ...(cursor ? { cursor } : {}) })}`,
          'GET',
          undefined,
          signal,
        ),
      ),
    integrations: async (signal: AbortSignal) =>
      z
        .object({ integrations: z.array(integrationSchema) })
        .parse(await request('/integrations', 'GET', undefined, signal)),
    integration: async (id: string, signal: AbortSignal) =>
      integrationDetailSchema.parse(await request(`/integrations/${part(id)}`, 'GET', undefined, signal)),
    setup: async (input: SetupInput, id?: string) =>
      setupResultSchema.parse(await request(id ? `/integrations/${part(id)}/setup` : '/integrations', 'POST', input)),
    integrationCommand: async (id: string, command: 'discover' | 'tools' | 'grants' | 'descriptor', input: unknown) =>
      integrationDetailSchema.parse(
        await request(
          `/integrations/${part(id)}/${command}`,
          command === 'discover' || command === 'descriptor' ? 'POST' : 'PUT',
          input,
        ),
      ),
    lifecycle: async (
      id: string,
      input: { requestId: string; expectedVersion: number; operation: 'enable' | 'disable' | 'disconnect' | 'delete' },
    ) =>
      z.object({ saved: z.literal(true) }).parse(await request(`/integrations/${part(id)}/lifecycle`, 'POST', input)),
    prepareSelection: async (origin: SelectionOrigin, signal: AbortSignal, prepareChat: PrepareMcpChat) => {
      if (origin.kind === 'chat' && prepareChat)
        await prepareChat(signal, async requestId =>
          z
            .object({ id: z.uuid() })
            .parse(await request(`${selectionPath(origin)}/reserve`, 'POST', { requestId }, signal)),
        );
    },
    selection: async (origin: SelectionOrigin, signal: AbortSignal) => {
      return selectionSchema.parse(
        await request(
          `${selectionPath(origin)}?${new URLSearchParams(origin.agentId ? { agentId: origin.agentId } : {})}`,
          'GET',
          undefined,
          signal,
        ),
      );
    },
    saveSelection: async (
      origin: SelectionOrigin,
      input: { requestId: string; expectedVersion: number; bindings: Selection['bindings'] },
    ) =>
      selectionSchema.parse(
        await request(selectionPath(origin), 'PUT', {
          ...input,
          ...(origin.agentId ? { agentId: origin.agentId } : {}),
        }),
      ),
    permissions: async (id: string, signal: AbortSignal) =>
      agentPermissionsSchema.parse(await request(`/agents/${part(id)}/permissions`, 'GET', undefined, signal)),
    permissionChoices: async (signal: AbortSignal) =>
      z.array(permissionSlotSchema).parse(await request('/agent-permission-choices', 'GET', undefined, signal)),
    savePermissions: async (
      id: string,
      input: { requestId: string; expectedSavedRevision: string; slots: PermissionSlot[] },
    ) => agentPermissionsSchema.parse(await request(`/agents/${part(id)}/permissions`, 'PUT', input)),
    actions: async (kind: 'chat' | 'task' | 'integration', originId: string, cursor: string, signal: AbortSignal) =>
      actionsSchema.parse(
        await request(
          `/actions?${new URLSearchParams({ kind, originId, ...(cursor ? { cursor } : {}) })}`,
          'GET',
          undefined,
          signal,
        ),
      ),
    decide: async (id: string, input: { requestId: string; digest: string; decision: 'approve' | 'reject' }) =>
      actionSchema.parse(await request(`/actions/${part(id)}/decision`, 'POST', input)),
    reconcile: async (
      id: string,
      input: {
        requestId: string;
        digest: string;
        outcome: 'completed' | 'not-performed' | 'still-unknown';
        notes: string;
      },
    ) => actionSchema.parse(await request(`/actions/${part(id)}/reconciliation`, 'POST', input)),
  };
}
export type McpApi = ReturnType<typeof mcpApi>;
