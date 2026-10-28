import { useMemo } from 'react';
import { useFeatureRead } from '@/lib/query';
import { systemPackageApi } from './api';

export function usePackageInstallations(workspaceId: string, chatId: string, enabled = true) {
  const api = useMemo(() => systemPackageApi(workspaceId), [workspaceId]);
  const read = useFeatureRead({
    key: ['system-package-installations', 'chat', chatId],
    load: signal => api.list(signal, undefined, chatId),
    enabled,
    pollWhile: value => value.installations.some(item => item.status === 'running' || item.status === 'pending'),
    interval: 2000,
    maxChecks: Infinity,
  });
  return { api, read };
}
