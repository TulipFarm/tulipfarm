import { useMemo } from 'react';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { skillApi, type SkillListView } from './api';
import { useAgentAccessChanges } from '@/features/agents/queries';

type Api = ReturnType<typeof skillApi>;
export const skillKeys = {
  all: ['skills'] as const,
  lists: ['skills', 'list'] as const,
  list: (after?: string, search = '', view: SkillListView = 'visible') =>
    ['skills', 'list', { after: after ?? null, search, view }] as const,
  reviewed: (after?: string, search = '') =>
    ['skills', 'list', { after: after ?? null, search, view: 'reviewed' }] as const,
  detail: (id: string) => ['skills', 'detail', id] as const,
  deletion: (id: string) => ['skills', 'deletion', id] as const,
};
export const skillReads = {
  list: (api: Api, after?: string, search = '', view: SkillListView = 'visible') => ({
    key: skillKeys.list(after, search, view),
    load: (signal: AbortSignal) => api.list(signal, after, search, view),
  }),
  reviewed: (api: Api, after?: string, search = '') => ({
    key: skillKeys.reviewed(after, search),
    load: (signal: AbortSignal) => api.reviewed(signal, after, search),
  }),
  detail: (api: Api, id: string) => ({
    key: skillKeys.detail(id),
    load: (signal: AbortSignal) => api.read(id, signal),
  }),
};
export function useSkills(api: Api, after?: string, search = '', view: SkillListView = 'visible') {
  return useFeatureRead(skillReads.list(api, after, search, view));
}
export function useReviewedSkills(api: Api, after?: string, search = '') {
  return useFeatureRead(skillReads.reviewed(api, after, search));
}
export function useSkillDetail(api: Api, id: string, enabled = true) {
  return useFeatureRead({ ...skillReads.detail(api, id), enabled });
}
export function useSkillDeletion(api: Api, id: string) {
  return useFeatureRead({ key: skillKeys.deletion(id), staleTime: 0, load: signal => api.deletion(id, signal) });
}
const affected = (id: string) => [skillKeys.lists, skillKeys.detail(id), skillKeys.deletion(id), ['agents'], ['tasks']];
export function useSkillChanges() {
  const { change } = useFeatureChanges();
  return useMemo(() => (id: string) => change({ keys: affected(id) }), [change]);
}
export function useSkillApi(workspaceId: string) {
  const changed = useSkillChanges();
  const accessChanged = useAgentAccessChanges();
  return useMemo(() => {
    const api = skillApi(workspaceId);
    return {
      ...api,
      send: async (...args: Parameters<Api['send']>) => {
        const result = await api.send(...args);
        if (args[1].kind === 'enable' && !args[1].enabled) void accessChanged(affected(args[0]));
        else void changed(args[0]);
        return result;
      },
    };
  }, [workspaceId, changed, accessChanged]);
}
