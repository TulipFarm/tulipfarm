import { useMemo } from 'react';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { projectApi } from './api';

export const projectKeys = {
  all: ['projects'] as const,
  list: () => ['projects', 'list'] as const,
  detail: (id: string) => ['projects', 'detail', id] as const,
  candidates: () => ['projects', 'candidates'] as const,
  source: (id: string, revisionId: string) => ['projects', 'detail', id, 'source', revisionId] as const,
};
export function useProjectApi(workspaceId: string) {
  return useMemo(() => projectApi(workspaceId), [workspaceId]);
}
export function useProjects(api: ReturnType<typeof projectApi>, enabled = true) {
  return useFeatureRead({ key: projectKeys.list(), load: signal => api.list(signal), enabled });
}
export function useProject(api: ReturnType<typeof projectApi>, id: string) {
  return useFeatureRead({ key: projectKeys.detail(id), load: signal => api.read(id, signal) });
}
export function useProjectCandidates(api: ReturnType<typeof projectApi>, enabled: boolean) {
  return useFeatureRead({ key: projectKeys.candidates(), load: signal => api.candidates(signal), enabled });
}
export function useProjectSource(api: ReturnType<typeof projectApi>, id: string, revisionId: string) {
  return useFeatureRead({
    key: projectKeys.source(id, revisionId),
    load: signal => api.source(id, revisionId, signal),
  });
}
export function useProjectChanges() {
  const { change } = useFeatureChanges();
  return useMemo(
    () => (id?: string) => change({ keys: id ? [projectKeys.list(), projectKeys.detail(id)] : [projectKeys.list()] }),
    [change],
  );
}
