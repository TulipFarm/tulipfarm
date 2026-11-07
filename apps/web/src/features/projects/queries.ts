import { useCallback, useMemo } from 'react';
import { editListed, useFeatureChanges, useFeatureRead, useOptimisticUpdate } from '@/lib/query';
import { projectApi, type ProjectEdit } from './api';

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

function editProject(data: unknown, key: readonly unknown[], id: string, edit: ProjectEdit) {
  if (key[1] === 'detail') {
    if (key.length !== 3 || !data || typeof data !== 'object' || !('project' in data)) return data;
    const next = editListed([data.project], id, project => ({
      ...project,
      name: edit.name,
      instructions: edit.instructions,
    }));
    return Array.isArray(next) && next[0] !== data.project ? { ...data, project: next[0] } : data;
  }
  if (key[2] === 'sidebar') return editListed(data, id, item => (edit.archived ? null : { ...item, name: edit.name }));
  return editListed(data, id, project => ({
    ...project,
    name: edit.name,
    instructions: edit.instructions,
    archived: edit.archived,
  }));
}
/**
 * Shows a project edit in the project lists and sidebar, and with `detail` its name and instructions in the
 * open project, before the server confirms it. Undo when the edit fails, and report the change either way.
 */
export function useProjectOptimism() {
  const optimistic = useOptimisticUpdate();
  return useCallback(
    (id: string, edit: ProjectEdit, detail: boolean) =>
      optimistic([projectKeys.list(), ...(detail ? [projectKeys.detail(id)] : [])], (data, key) =>
        editProject(data, key, id, edit),
      ),
    [optimistic],
  );
}
