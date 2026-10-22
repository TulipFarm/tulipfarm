import { useMemo } from 'react';
import type { z } from 'zod';
import {
  definitionViewSchema,
  runDetailSchema,
  workflowSchema,
  runHistoryPageSchema,
  statusSchema,
  unfinishedStatuses,
  providerIntegrationSchema,
  providerStatusSchema,
  webhookDeliveryLogSchema,
} from '@tulipfarm/workflows/contracts';
import { featureKey, useFeatureRead, useFeatureChanges, useLoadedWindow } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { useProviderAuthority } from '@/features/integrations/query-authority';
import { workflowRequest } from './api';

export type RunStatus = z.infer<typeof statusSchema>;
type RunHistoryPage = z.infer<typeof runHistoryPageSchema>;
type RunHistory = { pages: RunHistoryPage[]; runs: RunHistoryPage['runs']; nextCursor: string | null };

function flattenRunPages(pages: RunHistoryPage[]): RunHistory {
  const runs = new Map<string, RunHistoryPage['runs'][number]>();
  for (const page of pages) for (const run of page.runs) runs.set(run.id, run);
  return { pages, runs: [...runs.values()], nextCursor: pages.at(-1)?.nextCursor ?? null };
}

async function readRunPage(
  workspaceId: string,
  id: string,
  status: RunStatus | null,
  before: string | null,
  signal: AbortSignal,
) {
  const params = new URLSearchParams({ ...(status ? { status } : {}), ...(before ? { before } : {}) });
  return runHistoryPageSchema.parse(
    await workflowRequest(
      `/workspaces/${workspaceId}/workflows/${id}/runs${params.size ? `?${params}` : ''}`,
      'GET',
      undefined,
      signal,
    ),
  );
}

export const workflowKeys = {
  all: () => ['workflows'] as const,
  list: () => ['workflows', 'list'] as const,
  archived: () => ['workflows', 'archived'] as const,
  detail: (id: string) => ['workflows', 'detail', id] as const,
  runs: (id: string, status: RunStatus | null, pages: number) =>
    ['workflows', 'detail', id, 'runs', { status, pages }] as const,
  providers: () => ['workflows', 'providers'] as const,
  authority: () => ['workflows', 'provider-authority'] as const,
  details: () => ['workflows', 'detail'] as const,
  status: (id: string) => ['workflows', 'detail', id, 'provider-status'] as const,
  deliveries: (id: string) => ['workflows', 'detail', id, 'webhook-deliveries'] as const,
};
export const workflowQueries = {
  definition: (workspaceId: string, id: string, revision = 'saved') => ({
    key: [...workflowKeys.detail(id), 'definition', revision],
    load: async (signal: AbortSignal) =>
      definitionViewSchema.parse(
        await workflowRequest(
          `/workspaces/${workspaceId}/workflows/${id}?revision=${encodeURIComponent(revision)}`,
          'GET',
          undefined,
          signal,
        ),
      ),
  }),
  run: (workspaceId: string, id: string, runId: string) => ({
    key: [...workflowKeys.detail(id), 'run', runId],
    load: async (signal: AbortSignal) =>
      runDetailSchema.parse(
        await workflowRequest(`/workspaces/${workspaceId}/workflows/${id}/runs/${runId}`, 'GET', undefined, signal),
      ),
  }),
  list: (workspaceId: string) => ({
    key: workflowKeys.list(),
    load: async (signal: AbortSignal) =>
      workflowSchema
        .array()
        .parse(await workflowRequest(`/workspaces/${workspaceId}/workflows`, 'GET', undefined, signal)),
  }),
  archived: (workspaceId: string) => ({
    key: workflowKeys.archived(),
    load: async (signal: AbortSignal) =>
      workflowSchema
        .array()
        .parse(await workflowRequest(`/workspaces/${workspaceId}/workflows?archived=true`, 'GET', undefined, signal))
        .filter(workflow => workflow.archivedAt !== null),
  }),
  runs: (workspaceId: string, id: string, status: RunStatus | null) => ({
    key: workflowKeys.runs(id, status, 1),
    load: async (signal: AbortSignal) => flattenRunPages([await readRunPage(workspaceId, id, status, null, signal)]),
  }),
  providers: (workspaceId: string) => ({
    key: workflowKeys.providers(),
    load: async (signal: AbortSignal) =>
      providerIntegrationSchema
        .array()
        .parse(
          await workflowRequest(`/workspaces/${workspaceId}/workflows/provider-integrations`, 'GET', undefined, signal),
        ),
  }),
  deliveries: (workspaceId: string, id: string) => ({
    key: workflowKeys.deliveries(id),
    load: async (signal: AbortSignal) =>
      webhookDeliveryLogSchema.parse(
        await workflowRequest(
          `/workspaces/${workspaceId}/workflows/${id}/webhook-deliveries`,
          'GET',
          undefined,
          signal,
        ),
      ),
  }),
  status: (workspaceId: string, id: string) => ({
    key: workflowKeys.status(id),
    load: async (signal: AbortSignal) =>
      providerStatusSchema.parse(
        await workflowRequest(`/workspaces/${workspaceId}/workflows/${id}/provider-status`, 'GET', undefined, signal),
      ),
  }),
};
function useWorkflowRead<T>(input: Parameters<typeof useFeatureRead<T>>[0]) {
  const read = useFeatureRead(input);
  const { runtime, scope } = useFeatureContext();
  return {
    ...read,
    refresh: async () => {
      runtime.client.removeQueries({
        queryKey: featureKey(scope, workflowKeys.all()),
        type: 'inactive',
        predicate: query => query.state.status === 'error',
      });
      await runtime.client.cancelQueries({ queryKey: featureKey(scope, input.key), exact: true });
      await read.refresh();
    },
  };
}
export function useWorkflows(workspaceId: string) {
  return useWorkflowRead(workflowQueries.list(workspaceId));
}
export function useWorkflowDefinition(workspaceId: string, id: string | null, revision = 'saved') {
  useWorkflowAuthority();
  return useWorkflowRead({
    ...workflowQueries.definition(workspaceId, id ?? '', revision),
    enabled: !!id,
    staleTime: 0,
  });
}
export function useWorkflowRun(workspaceId: string, id: string, runId: string) {
  useWorkflowAuthority();
  return useWorkflowRead({
    ...workflowQueries.run(workspaceId, id, runId),
    staleTime: 0,
    pollWhile: detail => unfinishedStatuses.some(status => status === detail.run.status),
  });
}
export function useArchivedWorkflows(workspaceId: string, enabled: boolean) {
  return useWorkflowRead({ ...workflowQueries.archived(workspaceId), enabled });
}
function useWorkflowAuthority() {
  useProviderAuthority(workflowKeys.authority(), [workflowKeys.providers()], [workflowKeys.details()]);
}
export function useWorkflowRuns(workspaceId: string, id: string | null, status: RunStatus | null, pages: number) {
  useWorkflowAuthority();
  const { runtime, scope } = useFeatureContext();
  const query = workflowQueries.runs(workspaceId, id ?? '', status);
  const first = useWorkflowRead({
    ...query,
    enabled: id !== null,
    pollWhile: page => page.runs.some(run => unfinishedStatuses.some(live => live === run.status)),
  });
  // Disabled observers still set a query's loader, so the older-page loader must not replace the first page's.
  const olderKey = workflowKeys.runs(id ?? '', status, Math.max(2, pages));
  const older = useWorkflowRead({
    key: olderKey,
    enabled: id !== null && pages > 1,
    load: async signal => {
      const previous = runtime.client.getQueryData<RunHistory>(
        featureKey(scope, workflowKeys.runs(id ?? '', status, pages - 1)),
      );
      if (!previous?.nextCursor) throw new Error('The previous run-history page is unavailable.');
      return flattenRunPages([
        ...previous.pages,
        await readRunPage(workspaceId, id ?? '', status, previous.nextCursor, signal),
      ]);
    },
  });
  const retainedFirst = useLoadedWindow(first.state, id ?? '', 1, query.key);
  const state =
    pages === 1
      ? retainedFirst
      : older.state.kind === 'ready'
        ? {
            ...older.state,
            data: flattenRunPages([
              ...(retainedFirst.kind === 'ready'
                ? retainedFirst.data.pages.slice(0, 1)
                : older.state.data.pages.slice(0, 1)),
              ...older.state.data.pages.slice(1),
            ]),
          }
        : older.state.kind === 'loading' || older.state.kind === 'error'
          ? (() => {
              const previous = runtime.client.getQueryData<RunHistory>(
                featureKey(scope, workflowKeys.runs(id ?? '', status, pages - 1)),
              );
              return previous
                ? {
                    kind: 'ready' as const,
                    data: previous,
                    refreshing: older.state.kind === 'loading',
                    error: older.state.kind === 'error' ? older.state.message : null,
                  }
                : older.state;
            })()
          : older.state;
  return {
    ...first,
    state,
    retryOlder: older.refresh,
    older:
      pages > 1 && older.state.kind === 'loading'
        ? ('loading' as const)
        : pages > 1 && older.state.kind === 'error'
          ? ('failed' as const)
          : ('idle' as const),
  };
}
export function useWebhookDeliveries(workspaceId: string, id: string) {
  return useWorkflowRead(workflowQueries.deliveries(workspaceId, id));
}
export function useWorkflowProviders(workspaceId: string) {
  useWorkflowAuthority();
  return useWorkflowRead(workflowQueries.providers(workspaceId));
}
export function useWorkflowProviderStatus(workspaceId: string, id: string | null) {
  useWorkflowAuthority();
  return useWorkflowRead({ ...workflowQueries.status(workspaceId, id ?? ''), enabled: id !== null });
}
export function useWorkflowChanges() {
  const { change } = useFeatureChanges();
  return useMemo(
    () => ({
      saved: (id: string) => change({ keys: [workflowKeys.list(), workflowKeys.archived(), workflowKeys.detail(id)] }),
      providers: () => change({ keys: [workflowKeys.all()] }),
    }),
    [change],
  );
}
