import { useCallback, useMemo } from 'react';
import { freshness, useCatalogRestoration, useFeatureRead } from '@/lib/query';
import { modelKeys } from './queries';
import { modelApi } from './api';

export function useModelCatalog(workspaceId: string) {
  const api = useMemo(() => modelApi(workspaceId), [workspaceId]);
  const load = useCallback((signal: AbortSignal) => api.catalog(signal), [api]);
  const key = modelKeys.catalog();
  const restored = useCatalogRestoration(key);
  return useFeatureRead({ key, load, enabled: restored, staleTime: freshness.catalog });
}
