import type { ReadState } from '@/features/tables/request-state';
import {
  useAtlassianAccounts,
  useGitHubAccounts,
  useGoogleIntegration,
  useManagedIntegrations,
  useSlackIntegration,
} from './queries';
import { googleAppScopes } from '@tulipfarm/google-workspace/public-contracts';
import type { Integration } from './catalog';

export type Status =
  | { kind: 'loading' }
  | { kind: 'connected'; detail: string | null; granted?: readonly string[] }
  | { kind: 'installed' }
  | { kind: 'attention'; detail: string }
  | { kind: 'off'; canConnect: boolean; granted?: readonly string[] }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'error'; detail: string; accessLost: boolean };
export type Statuses = Record<'google' | 'slack' | 'github' | 'github-personal' | 'atlassian' | 'trello', Status>;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
function status<T>(state: ReadState<T>, present: (data: T) => Status): Status {
  if (state.kind === 'loading') return { kind: 'loading' };
  if (state.kind !== 'ready')
    return {
      kind: 'error',
      detail:
        state.kind === 'error'
          ? state.message
          : 'Status is unavailable to your current membership. Check your workspace access.',
      accessLost: state.kind === 'unavailable',
    };
  if (state.error) return { kind: 'error', detail: state.error, accessLost: false };
  return present(state.data);
}

export function useIntegrationStatus(workspaceId: string, provider?: keyof Statuses) {
  const google = useGoogleIntegration(workspaceId, !provider || provider === 'google');
  const slack = useSlackIntegration(workspaceId, !provider || provider === 'slack');
  const github = useManagedIntegrations(workspaceId, !provider || provider === 'github');
  const personal = useGitHubAccounts(workspaceId, !provider || provider === 'github-personal');
  const atlassian = useAtlassianAccounts(workspaceId, !provider || provider === 'atlassian' || provider === 'trello');
  const pickAtlassian = (trello: boolean) =>
    status(atlassian.state, ({ accounts, providers }) => {
      const mine = accounts.filter(account => account.protocol === (trello ? 'trello' : 'atlassian-mcp'));
      const active = mine.filter(account => account.state === 'active').length;
      if (active) return { kind: 'connected', detail: plural(active, 'account') };
      if (mine.some(account => account.state === 'reconnect-required'))
        return { kind: 'attention', detail: 'Access expired. Reconnect.' };
      if (mine.some(account => account.state === 'authorizing'))
        return { kind: 'attention', detail: 'Sign-in incomplete. Reconnect to continue.' };
      return providers.some(
        provider => provider.protocol === (trello ? 'trello' : 'atlassian-mcp') && provider.configured,
      )
        ? { kind: 'off', canConnect: true }
        : { kind: 'unavailable', detail: 'Not set up on this server' };
    });
  const statuses: Statuses = {
    google: status(google.state, ({ configured, status }) =>
      status.status === 'connected'
        ? { kind: 'connected', detail: status.email, granted: status.scopes }
        : status.status === 'reconnect-required'
          ? { kind: 'attention', detail: 'Access expired. Reconnect.' }
          : configured
            ? { kind: 'off', canConnect: true }
            : { kind: 'unavailable', detail: 'Not set up on this server' },
    ),
    slack: status(slack.state, value =>
      value === 'unavailable'
        ? { kind: 'unavailable', detail: 'Ask an integration manager for access' }
        : value.state === 'active'
          ? value.linked
            ? { kind: 'connected', detail: null }
            : { kind: 'installed' }
          : value.state === 'disconnected'
            ? { kind: 'off', canConnect: value.canManage }
            : {
                kind: 'attention',
                detail: value.canManage ? 'Reconnect the workspace.' : 'Ask an integration manager to reconnect.',
              },
    ),
    github: status(github.state, ({ integrations }) => {
      const enabled = integrations.filter(item => item.enabled).length;
      return enabled
        ? { kind: 'connected', detail: plural(enabled, 'integration') }
        : integrations.length
          ? { kind: 'attention', detail: 'All integrations are turned off.' }
          : { kind: 'off', canConnect: true };
    }),
    'github-personal': status(personal.state, ({ configured, accounts }) => {
      if (!configured) return { kind: 'unavailable', detail: 'Not set up on this server' };
      const active = accounts.filter(account => account.state === 'active').length;
      return active
        ? { kind: 'connected', detail: plural(active, 'private account') }
        : accounts.some(account => account.state !== 'disconnected')
          ? { kind: 'attention', detail: 'Complete fresh GitHub consent.' }
          : { kind: 'off', canConnect: true };
    }),
    atlassian: pickAtlassian(false),
    trello: pickAtlassian(true),
  };
  const byProvider = { google, slack, github, 'github-personal': personal, atlassian, trello: atlassian };
  const readers = provider ? [byProvider[provider]] : [google, slack, github, personal, atlassian];
  return {
    statuses,
    refreshing: readers.some(
      read => read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing),
    ),
    refresh: async () => {
      await Promise.all(readers.map(read => read.refresh()));
    },
  };
}

export function statusOf(statuses: Statuses, app: Integration): Status | null {
  if (app.provider === 'soon' || app.provider === 'workflow') return null;
  const status = statuses[app.provider];
  if (
    !app.googleApp ||
    status.kind !== 'connected' ||
    googleAppScopes[app.googleApp].every(scope => status.granted?.includes(scope))
  )
    return status;
  return { kind: 'off', canConnect: true, granted: status.granted ?? [] };
}
