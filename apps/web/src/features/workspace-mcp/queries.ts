import { useCallback, useMemo } from 'react';
import { featureKey, featureReadOptions, useFeatureChanges, useFeatureRead } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { concealQueries, useProviderAuthority } from '@/features/integrations/query-authority';
import { conversationKeys } from '@/features/chat/queries';
import { taskKeys } from '@/features/tasks/queries';
import { mcpAccessEvent, mcpApi, type McpApi, type PrepareMcpChat } from './api';
import type { SelectionOrigin } from './contracts';
import { actionsSchema } from './contracts';

export const mcpKeys = {
  all: ['workspace-mcp'] as const,
  capabilities: ['workspace-mcp', 'capabilities'] as const,
  catalog: (search: string, cursor: string) => ['workspace-mcp', 'catalog', { search, cursor }] as const,
  integrations: ['workspace-mcp', 'integrations'] as const,
  integration: (id: string) => ['workspace-mcp', 'integration', id] as const,
  permissions: (id: string) => ['workspace-mcp', 'permissions', id] as const,
  selections: ['workspace-mcp', 'selections'] as const,
  selection: (origin: SelectionOrigin) =>
    [
      'workspace-mcp',
      'selections',
      origin.kind,
      origin.id,
      { agentId: origin.agentId ?? null, activationId: origin.activationId ?? null },
    ] as const,
  actions: ['workspace-mcp', 'actions'] as const,
  actionPages: (kind: 'chat' | 'task' | 'integration', id: string) => ['workspace-mcp', 'actions', kind, id] as const,
  actionPage: (kind: 'chat' | 'task' | 'integration', id: string, cursor: string) =>
    [...mcpKeys.actionPages(kind, id), { cursor }] as const,
};
const privateKeys = [mcpKeys.selections, mcpKeys.actions, ['conversations'], taskKeys.all] as const;
const originKeys = (origin: SelectionOrigin) =>
  origin.kind === 'chat'
    ? [conversationKeys.detail(origin.id), conversationKeys.lists(), taskKeys.sources]
    : origin.kind === 'task'
      ? [taskKeys.detail(origin.id), taskKeys.lists, taskKeys.sources]
      : [];

export function useMcpApi(workspaceId: string): McpApi {
  const { change } = useFeatureChanges();
  const { runtime, scope, current } = useFeatureContext();
  return useMemo(() => {
    const api = mcpApi(workspaceId, status => {
      if (!current()) return;
      if (status === 401) {
        runtime.revoke({ kind: 'account', userId: scope.userId }, true);
        return;
      }
      concealQueries(
        runtime.client,
        [mcpKeys.all, ['conversations'], taskKeys.all].map(key => featureKey(scope, key)),
      );
      window.dispatchEvent(new CustomEvent(mcpAccessEvent, { detail: { workspaceId } }));
    });
    const authorityChanged = () => {
      if (!current()) return;
      void change({ kind: 'conceal', keys: privateKeys });
      void change({ keys: [mcpKeys.integrations, ['workspace-mcp', 'integration'], ['workspace-mcp', 'permissions']] });
    };
    return {
      ...api,
      setup: async (...args) => {
        const result = await api.setup(...args);
        authorityChanged();
        return result;
      },
      integrationCommand: async (...args) => {
        const result = await api.integrationCommand(...args);
        authorityChanged();
        return result;
      },
      lifecycle: async (...args) => {
        const result = await api.lifecycle(...args);
        authorityChanged();
        return result;
      },
      saveSelection: async (...args) => {
        const result = await api.saveSelection(...args);
        if (current()) {
          void change({
            kind: 'conceal',
            keys: [...originKeys(args[0]), mcpKeys.actionPages(args[0].kind === 'chat' ? 'chat' : 'task', args[0].id)],
          });
          void change({ keys: [mcpKeys.selection(args[0])] });
        }
        return result;
      },
      savePermissions: async (...args) => {
        const result = await api.savePermissions(...args);
        if (current()) void change({ keys: [mcpKeys.permissions(args[0]), mcpKeys.selections, ['agents']] });
        return result;
      },
      decide: async (...args) => {
        const result = await api.decide(...args);
        if (current())
          void change({
            keys: [
              mcpKeys.actions,
              mcpKeys.integrations,
              ['workspace-mcp', 'integration'],
              ['conversations'],
              taskKeys.all,
            ],
          });
        return result;
      },
      reconcile: async (...args) => {
        const result = await api.reconcile(...args);
        if (current())
          void change({
            keys: [
              mcpKeys.actions,
              mcpKeys.integrations,
              ['workspace-mcp', 'integration'],
              mcpKeys.selections,
              ['conversations'],
              taskKeys.all,
            ],
          });
        return result;
      },
    };
  }, [workspaceId, change, runtime, scope, current]);
}

export function useMcpCapabilities(api: McpApi) {
  useProviderAuthority(['workspace-mcp', 'capability-authority'], [mcpKeys.capabilities], privateKeys);
  return useFeatureRead({ key: mcpKeys.capabilities, load: api.capabilities });
}
export function useMcpIntegrations(api: McpApi, enabled = true) {
  useProviderAuthority(['workspace-mcp', 'authority'], [mcpKeys.integrations], privateKeys);
  return useFeatureRead({ key: mcpKeys.integrations, load: api.integrations, enabled });
}
export function useMcpCatalog(api: McpApi, search: string, cursor: string) {
  return useFeatureRead({ key: mcpKeys.catalog(search, cursor), load: signal => api.catalog(search, cursor, signal) });
}
export function useMcpIntegration(api: McpApi, id: string) {
  useProviderAuthority(['workspace-mcp', 'integration-authority', id], [mcpKeys.integration(id)], privateKeys);
  return useFeatureRead({
    key: mcpKeys.integration(id),
    load: signal => api.integration(id, signal),
    pollWhile: detail => ['oauth-pending', 'discovering', 'setup'].includes(detail.integration.status),
  });
}
export function useMcpSelection(api: McpApi, origin: SelectionOrigin, enabled: boolean) {
  const key = mcpKeys.selection(origin);
  useProviderAuthority(
    ['workspace-mcp', 'selection-authority', ...key.slice(2)],
    [key],
    [...originKeys(origin), mcpKeys.actionPages(origin.kind === 'chat' ? 'chat' : 'task', origin.id)],
  );
  return useFeatureRead({ key, enabled, load: signal => api.selection(origin, signal) });
}
export function useMcpPermissions(api: McpApi, id: string) {
  return useFeatureRead({ key: mcpKeys.permissions(id), load: signal => api.permissions(id, signal) });
}
export function useMcpActions(api: McpApi, kind: 'chat' | 'task' | 'integration', id: string, cursor: string) {
  useProviderAuthority(
    ['workspace-mcp', 'action-authority', kind, id, cursor],
    [mcpKeys.actionPage(kind, id, cursor)],
    kind === 'integration' ? [['conversations'], taskKeys.all] : originKeys({ kind, id }),
    data => {
      const parsed = actionsSchema.safeParse(data);
      return parsed.success ? parsed.data.actions.map(action => [action.id, action.visibility]) : null;
    },
  );
  return useFeatureRead({
    key: mcpKeys.actionPage(kind, id, cursor),
    load: signal => api.actions(kind, id, cursor, signal),
    pollWhile: () => kind !== 'integration',
  });
}

// Status recovery is deliberate and uses the same fenced REST query as the list.
export function useMcpSetupRecovery(api: McpApi) {
  const { runtime, scope, current } = useFeatureContext();
  return useCallback(
    () =>
      runtime.client.fetchQuery({
        ...featureReadOptions(
          runtime,
          scope,
          { key: mcpKeys.integrations, staleTime: 0, load: api.integrations },
          current,
        ),
        retry: false,
      }),
    [runtime, scope, current, api],
  );
}

// Reserving a draft chat is a write. It must never run in a retryable queryFn.
export function useMcpPrepareChat(api: McpApi, origin: SelectionOrigin, prepareChat: PrepareMcpChat | undefined) {
  return useCallback(async () => {
    if (prepareChat) await api.prepareSelection(origin, AbortSignal.timeout(15000), prepareChat);
  }, [api, origin.kind, origin.id, origin.agentId, origin.activationId, prepareChat]);
}
