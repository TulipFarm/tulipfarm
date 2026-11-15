import { useMemo } from 'react';
import { useFeatureRead } from '@/lib/query';
import { codingRunsApi, type CodingRunView } from './api';

export const codingRunKeys = {
  all: ['coding-runs'] as const,
  run: (id: string) => ['coding-runs', 'run', id] as const,
};

const unsettled = (run: CodingRunView) => run.status === 'approved' || run.status === 'running';

export function useCodingRunsApi(workspaceId: string) {
  return useMemo(() => codingRunsApi(workspaceId), [workspaceId]);
}

export function useCodingRun(workspaceId: string, id: string, enabled = true) {
  const api = useCodingRunsApi(workspaceId);
  return useFeatureRead({
    key: codingRunKeys.run(id),
    load: signal => api.get(id, signal),
    enabled: enabled && !!workspaceId,
    pollWhile: unsettled,
    // A run takes up to 30 minutes, so it is checked less often and for longer than most reads.
    interval: 10_000,
    maxChecks: 240,
    maxDuration: 40 * 60 * 1000,
  });
}
