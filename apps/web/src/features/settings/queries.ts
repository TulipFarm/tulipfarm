import { featureKey, useFeatureRead, useFeatureChanges } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { useOwnMembership } from '@/features/governance/queries';
import { useWorkspaceChanges } from '@/features/workspaces/changes';
import type { ReadState } from '@/features/tables/request-state';
import { settingsApi, type Settings } from './api';
import type { OwnMembership } from '@tulipfarm/workspaces/governance-contracts';

export const settingsKeys = { all: ['settings'] as const, general: ['settings', 'general'] as const };
export function useWorkspaceSettings(workspaceId: string) {
  const { runtime, scope } = useFeatureContext();
  const settings = useFeatureRead({ key: settingsKeys.general, load: settingsApi(workspaceId).read });
  const membership = useOwnMembership(workspaceId);
  const state: ReadState<{ settings: Settings; membership: OwnMembership }> =
    settings.state.kind === 'unavailable'
      ? settings.state
      : membership.state.kind === 'unavailable'
        ? membership.state
        : settings.state.kind !== 'ready'
          ? settings.state
          : membership.state.kind !== 'ready'
            ? membership.state
            : {
                kind: 'ready',
                data: { settings: settings.state.data, membership: membership.state.data },
                refreshing: settings.state.refreshing || membership.state.refreshing,
                error: settings.state.error ?? membership.state.error,
              };
  return {
    state,
    refresh: async () => {
      await Promise.all([settings.refresh(), membership.refresh()]);
    },
    reloadSettings: async () => {
      await settings.refresh();
      const result = runtime.client.getQueryState<Settings>(featureKey(scope, settingsKeys.general));
      return result?.status === 'success' ? result.data : undefined;
    },
  };
}
export function useSettingsChanges() {
  const { change } = useFeatureChanges();
  const workspace = useWorkspaceChanges();
  return {
    saved: () => Promise.all([change({ keys: [settingsKeys.all] }), workspace.changed()]),
    removed: workspace.removed,
  };
}
