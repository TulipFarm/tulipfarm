import { useFeatureChanges } from '@/lib/query';
import {
  teamUpdateSchema,
  type GovernanceSnapshot,
  type OwnMembership,
} from '@tulipfarm/workspaces/governance-contracts';
import { useFeatureContext } from '@/lib/query/provider';
import { featureKey } from '@/lib/query';
import { useWorkspaceChanges } from '@/features/workspaces/changes';
import { governanceDependents, governanceKeys, governanceTableDependents } from './queries';

export function useGovernanceChanges() {
  const { runtime, scope } = useFeatureContext();
  const { change } = useFeatureChanges();
  const workspaces = useWorkspaceChanges();
  return {
    saved: async (path: string, method: string, body?: unknown) => {
      if (method === 'PUT' && /^\/teams\/[^/]+\/name$/.test(path)) {
        const { name, description } = teamUpdateSchema.parse(body);
        const key = featureKey(scope, governanceKeys.administration);
        await runtime.client.cancelQueries({ queryKey: key });
        if (runtime.isCurrent(scope)) {
          runtime.client.setQueryData<GovernanceSnapshot>(
            key,
            previous =>
              previous && {
                ...previous,
                teams: previous.teams.map(team =>
                  path === `/teams/${team.id}/name` ? { ...team, name, description } : team,
                ),
              },
          );
          runtime.client.setQueryData<OwnMembership>(
            featureKey(scope, governanceKeys.membership),
            previous =>
              previous && {
                ...previous,
                teams: previous.teams.map(team => (path === `/teams/${team.id}/name` ? { ...team, name } : team)),
              },
          );
        }
      }
      if (path === '/grants' || path.endsWith('/owner')) {
        // Table grants can narrow protected reads, but the admin snapshot stays visible while it refreshes.
        await Promise.all([
          change({ kind: 'conceal', keys: [governanceKeys.tableAuthority, ...governanceTableDependents] }),
          change({ kind: 'change', keys: [governanceKeys.administration] }),
        ]);
        return;
      }
      const authority =
        path === '/leave' ||
        path.endsWith('/role') ||
        path.includes('/members/') ||
        path.endsWith('/leave') ||
        method === 'DELETE';
      await Promise.all([
        authority ? workspaces.changed() : Promise.resolve(),
        change({
          kind: authority ? 'conceal' : 'change',
          keys: authority
            ? [governanceKeys.all, ...governanceDependents]
            : [
                governanceKeys.membership,
                governanceKeys.administration,
                ['settings'],
                ['tables', 'authoring-context'],
                ['agents'],
              ],
        }),
      ]);
    },
    accessLost: () => {
      return change({ kind: 'conceal', keys: [governanceKeys.all, ...governanceDependents] });
    },
    removed: workspaces.removed,
  };
}
