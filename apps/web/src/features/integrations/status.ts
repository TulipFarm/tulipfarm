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
import { accountConnectionState, slackConnectionState } from './connection-state';
import { useChatGptConnection, useTokenConnection } from '@/features/models/plan-connections';
import { useFlag } from '@/lib/feature-flags';

export type Status =
  | { kind: 'loading' }
  | { kind: 'connected'; detail: string | null; granted?: readonly string[] }
  | { kind: 'installed' }
  | { kind: 'attention'; detail: string }
  | { kind: 'off'; canConnect: boolean; granted?: readonly string[] }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'error'; detail: string; accessLost: boolean };
/** The provider has no app credentials on this server, so nobody in any workspace can connect it. */
export const notSetUp = 'Not set up on this server';
/** A provider that is still rolling out and isn't on for this member yet. */
export const notYet = 'Not available to you yet';
export type Statuses = Record<
  'google' | 'slack' | 'github' | 'github-personal' | 'atlassian' | 'trello' | 'chatgpt' | 'claude',
  Status
>;
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

/** All statuses, or just `provider`'s. AI plans load only when named or with `plans`, since chats never mention them. */
export function useIntegrationStatus(workspaceId: string, provider?: keyof Statuses, plans = false) {
  const google = useGoogleIntegration(workspaceId, !provider || provider === 'google');
  const slack = useSlackIntegration(workspaceId, !provider || provider === 'slack');
  const github = useManagedIntegrations(workspaceId, !provider || provider === 'github');
  const personal = useGitHubAccounts(workspaceId, !provider || provider === 'github-personal');
  const atlassian = useAtlassianAccounts(workspaceId, !provider || provider === 'atlassian' || provider === 'trello');
  const chatgptOn = useFlag('chatgpt-plan');
  const claudeOn = useFlag('claude-plan');
  const readChatgpt = chatgptOn && (provider ? provider === 'chatgpt' : plans);
  const readClaude = claudeOn && (provider ? provider === 'claude' : plans);
  const chatgpt = useChatGptConnection(workspaceId, readChatgpt);
  const claude = useTokenConnection(workspaceId, 'claude', readClaude);
  const off: Status = { kind: 'unavailable', detail: notYet };
  // A plan app is connected while any of the member's accounts is, and needs attention when only stale ones are left.
  const plan = (connections: readonly { state: string }[] | undefined): Status => {
    if (!connections) return { kind: 'unavailable', detail: notSetUp };
    const active = connections.filter(connection => connection.state === 'connected').length;
    const lapsed = connections.filter(
      connection => connection.state === 'reconnect-required' || connection.state === 'plan-disabled',
    ).length;
    // One lapsed account is enough to need attention: it may be the one coding or chats rely on.
    if (lapsed)
      return {
        kind: 'attention',
        detail: active
          ? `${plural(lapsed, 'account')} ${lapsed === 1 ? 'needs' : 'need'} sign-in again`
          : 'Plan sign-in needed',
      };
    if (active) return { kind: 'connected', detail: plural(active, 'account') };
    return { kind: 'off', canConnect: true };
  };
  const pickAtlassian = (trello: boolean) =>
    status(atlassian.state, ({ accounts, providers }) => {
      const mine = accounts.filter(account => account.protocol === (trello ? 'trello' : 'atlassian-mcp'));
      const active = mine.filter(account => accountConnectionState(account) === 'connected').length;
      if (active) return { kind: 'connected', detail: plural(active, 'account') };
      if (mine.some(account => accountConnectionState(account) === 'attention'))
        return { kind: 'attention', detail: 'Access expired' };
      return providers.some(
        provider => provider.protocol === (trello ? 'trello' : 'atlassian-mcp') && provider.configured,
      )
        ? { kind: 'off', canConnect: true }
        : { kind: 'unavailable', detail: notSetUp };
    });
  const statuses: Statuses = {
    google: status(google.state, ({ configured, status }) =>
      status.status === 'connected'
        ? { kind: 'connected', detail: status.email, granted: status.scopes }
        : status.status === 'reconnect-required'
          ? { kind: 'attention', detail: 'Access expired' }
          : configured
            ? { kind: 'off', canConnect: true }
            : { kind: 'unavailable', detail: notSetUp },
    ),
    slack: status(slack.state, value =>
      value === 'unavailable'
        ? { kind: 'unavailable', detail: 'Ask an integration manager to share Slack with you' }
        : value.state === 'active'
          ? value.linked
            ? { kind: 'connected', detail: null }
            : { kind: 'installed' }
          : slackConnectionState(value) !== 'attention'
            ? { kind: 'off', canConnect: value.canManage }
            : {
                kind: 'attention',
                detail: value.canManage ? 'Slack access expired' : 'Ask an integration manager to reconnect.',
              },
    ),
    github: status(github.state, ({ integrations }) => {
      const enabled = integrations.filter(item => item.enabled).length;
      return enabled
        ? { kind: 'connected', detail: plural(enabled, 'connection') }
        : integrations.length
          ? { kind: 'attention', detail: 'All connections turned off' }
          : { kind: 'off', canConnect: true };
    }),
    'github-personal': status(personal.state, ({ configured, accounts }) => {
      if (!configured) return { kind: 'unavailable', detail: notSetUp };
      const active = accounts.filter(account => accountConnectionState(account) === 'connected').length;
      return active
        ? { kind: 'connected', detail: plural(active, 'private account') }
        : accounts.some(account => accountConnectionState(account) === 'attention')
          ? { kind: 'attention', detail: 'New GitHub approval needed' }
          : { kind: 'off', canConnect: true };
    }),
    atlassian: pickAtlassian(false),
    trello: pickAtlassian(true),
    chatgpt: chatgptOn ? status(chatgpt.state, data => plan(data?.connections)) : off,
    claude: claudeOn ? status(claude.state, data => plan(data?.connections)) : off,
  };
  const byProvider = {
    google,
    slack,
    github,
    'github-personal': personal,
    atlassian,
    trello: atlassian,
    chatgpt,
    claude,
  };
  const readers = provider
    ? [byProvider[provider]]
    : [google, slack, github, personal, atlassian, ...(readChatgpt ? [chatgpt] : []), ...(readClaude ? [claude] : [])];
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
