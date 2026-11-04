import { useMemo } from 'react';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { apiCallsApi, type ApiCallView } from './api';

export const apiCallKeys = {
  all: ['api-calls'] as const,
  call: (id: string) => ['api-calls', 'call', id] as const,
  task: (taskId: string) => ['api-calls', 'task', taskId] as const,
};

const unsettled = (call: ApiCallView) => call.status === 'sending';

export function useApiCallsApi(workspaceId: string) {
  return useMemo(() => apiCallsApi(workspaceId), [workspaceId]);
}

export function useApiCall(workspaceId: string, id: string, enabled = true) {
  const api = useApiCallsApi(workspaceId);
  return useFeatureRead({
    key: apiCallKeys.call(id),
    load: signal => api.get(id, signal),
    enabled: enabled && !!workspaceId,
    pollWhile: unsettled,
  });
}

export function useTaskApiCalls(workspaceId: string, taskId: string, revision: unknown) {
  const api = useApiCallsApi(workspaceId);
  return useFeatureRead({
    key: [...apiCallKeys.task(taskId), revision],
    load: signal => api.forTask(taskId, signal),
    enabled: !!workspaceId,
    pollWhile: calls => calls.some(unsettled),
  });
}

export function useApiCallChanges() {
  const { change } = useFeatureChanges();
  return useMemo(() => ({ changed: () => change({ keys: [apiCallKeys.all] }) }), [change]);
}
