import { useMemo } from 'react';
import { editListedIn, useFeatureChanges, useFeatureRead, useOptimisticUpdate } from '@/lib/query';
import { skillApi, type SkillLifecycleCommand, type SkillListView } from './api';
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
/** A skill's expected place after a lifecycle change: off the lists it leaves, with its detail showing the new state. */
function afterLifecycle(
  data: unknown,
  key: readonly unknown[],
  id: string,
  lifecycle: SkillLifecycleCommand['lifecycle'],
) {
  if (key[1] === 'detail')
    return lifecycle !== 'deleted' && data && typeof data === 'object' && 'lifecycle' in data
      ? { ...data, lifecycle }
      : data;
  const query = key[2];
  if (!query || typeof query !== 'object' || !('view' in query)) return data;
  if (lifecycle !== 'deleted' && (query.view === 'archived') !== (lifecycle === 'active')) return data;
  return editListedIn(data, 'workspace', id, () => null);
}
export function useSkillApi(workspaceId: string) {
  const changed = useSkillChanges();
  const accessChanged = useAgentAccessChanges();
  const optimistic = useOptimisticUpdate();
  return useMemo(() => {
    const api = skillApi(workspaceId);
    return {
      ...api,
      send: async (...args: Parameters<Api['send']>) => {
        const [id, command] = args;
        const undo =
          command.kind === 'lifecycle'
            ? await optimistic([skillKeys.lists, skillKeys.detail(id)], (data, key) =>
                afterLifecycle(data, key, id, command.lifecycle),
              )
            : () => {};
        let result: Awaited<ReturnType<Api['send']>>;
        try {
          result = await api.send(...args);
        } catch (error) {
          undo();
          void changed(id);
          throw error;
        }
        if (command.kind === 'enable' && !command.enabled) void accessChanged(affected(id));
        else void changed(id);
        return result;
      },
    };
  }, [workspaceId, changed, accessChanged, optimistic]);
}
