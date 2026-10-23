import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import type { SocialAccountMetadata } from '@tulipfarm/social/contracts';
import { socialSettingsRoute, workspaceRoute } from '@/router';
import { apiOrigin } from '@/lib/auth';
import { useKnownFlag } from '@/lib/feature-flags';
import { useFeatureRead } from '@/lib/query';
import type { ReadState } from '@/features/tables/request-state';
import { socialApi, socialSettingsApi } from '@/lib/social';
import { useOwnMembership } from '@/features/governance/queries';
import { useIntegrationAdministration } from '@/features/integrations/queries';
import { SocialConnections, type ConnectionActions } from '@/features/social/settings/connections';
import { SocialChannels, type ChannelActions } from '@/features/social/settings/channels';
import { PlatformApps, type PlatformAppActions } from '@/features/social/settings/platform-apps';
import { GrantsEditor, type GrantRole } from '@/features/social/settings/grants';
import { accountName, type Principal } from '@/features/social/settings/labels';

const keys = {
  availability: ['social', 'availability'],
  apps: ['social', 'platform-apps'],
  accounts: ['social', 'accounts'],
  channels: ['social', 'channels'],
  grants: (accountId: string) => ['social', 'account-grants', accountId],
};
export type SocialSettingsTab = 'connections' | 'channels' | 'apps';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>{children}</PageContent>
    </div>
  );
}

export function SocialSettingsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  // Nothing is requested until the workspace's flag is known to be on.
  const enabled = useKnownFlag('social-publishing', workspace.slug);
  return (
    <SocialSettingsGate enabled={enabled}>
      <SocialSettings />
    </SocialSettingsGate>
  );
}

export function SocialSettingsGate({ enabled, children }: { enabled: boolean | undefined; children: React.ReactNode }) {
  if (enabled === undefined)
    return (
      <Frame>
        <StatePanel kind="loading" title="Loading social settings" description="Checking this workspace." />
      </Frame>
    );
  if (!enabled)
    return (
      <Frame>
        <StatePanel kind="unavailable" title="Page not found" description="This page is not available." />
      </Frame>
    );
  return children;
}

function combine<A, B, C, D>(
  a: ReadState<A>,
  b: ReadState<B>,
  c: ReadState<C>,
  d: ReadState<D>,
): ReadState<[A, B, C, D]> {
  for (const state of [a, b, c, d]) if (state.kind === 'unavailable' || state.kind === 'error') return state;
  if (a.kind !== 'ready' || b.kind !== 'ready' || c.kind !== 'ready' || d.kind !== 'ready') return { kind: 'loading' };
  return {
    kind: 'ready',
    data: [a.data, b.data, c.data, d.data],
    refreshing: a.refreshing || b.refreshing || c.refreshing || d.refreshing,
    error: a.error ?? b.error ?? c.error ?? d.error,
  };
}

function SocialSettings() {
  const { workspace } = workspaceRoute.useRouteContext();
  const search = socialSettingsRoute.useSearch();
  const navigate = useNavigate({ from: socialSettingsRoute.fullPath });
  const availability = useFeatureRead({
    key: keys.availability,
    load: signal => socialSettingsApi.availability(workspace.id, signal),
  });
  const apps = useFeatureRead({ key: keys.apps, load: signal => socialSettingsApi.apps(workspace.id, signal) });
  const accounts = useFeatureRead({
    key: keys.accounts,
    load: signal => socialSettingsApi.accounts(workspace.id, signal),
  });
  const channels = useFeatureRead({ key: keys.channels, load: signal => socialApi.channels(workspace.id, signal) });
  const membership = useOwnMembership(workspace.id);
  const people = useIntegrationAdministration(workspace.id);
  const state = combine(availability.state, apps.state, accounts.state, channels.state);
  const admin = membership.state.kind === 'ready' && membership.state.data.role === 'admin';
  const tab: SocialSettingsTab = search.tab === 'apps' && !admin ? 'connections' : (search.tab ?? 'connections');
  const ownTeams: Principal[] =
    membership.state.kind === 'ready' ? membership.state.data.teams.map(({ id, name }) => ({ id, name })) : [];
  const members: Principal[] = people.state.kind === 'ready' ? people.state.data.members : [];
  const teams: Principal[] = people.state.kind === 'ready' ? people.state.data.teams : ownTeams;
  const membershipId = membership.state.kind === 'ready' ? membership.state.data.membershipId : '';
  const refreshAll = async () => {
    await Promise.all([availability.refresh(), apps.refresh(), accounts.refresh(), channels.refresh()]);
  };
  const connectionActions = useMemo<ConnectionActions>(
    () => ({
      begin: async input => (await socialSettingsApi.begin(workspace.id, input)).authorizationUrl,
      reconnect: async accountId => (await socialSettingsApi.reconnect(workspace.id, accountId)).authorizationUrl,
      disconnect: async accountId => {
        try {
          return await socialSettingsApi.disconnect(workspace.id, accountId);
        } finally {
          await Promise.all([accounts.refresh(), channels.refresh()]);
        }
      },
      navigate: url => window.location.assign(url),
    }),
    [workspace.id, accounts.refresh, channels.refresh],
  );
  const appActions = useMemo<PlatformAppActions>(
    () => ({
      create: async input => {
        try {
          return await socialSettingsApi.createApp(workspace.id, input);
        } finally {
          await Promise.all([apps.refresh(), availability.refresh()]);
        }
      },
      replaceSecret: async (appId, secret) => {
        try {
          return await socialSettingsApi.replaceSecret(workspace.id, appId, secret);
        } finally {
          await Promise.all([apps.refresh(), accounts.refresh()]);
        }
      },
    }),
    [workspace.id, apps.refresh, availability.refresh, accounts.refresh],
  );
  const channelActions = useMemo<ChannelActions>(
    () => ({
      reachable: accountId => socialSettingsApi.reachable(workspace.id, accountId),
      add: (account, platformChannelId) =>
        socialSettingsApi.addChannel(workspace.id, {
          accountId: account.id,
          expectedAccountGeneration: account.generation,
          platformChannelId,
        }),
      saveGrants: (channelId, grants) => socialSettingsApi.saveChannelGrants(workspace.id, channelId, grants),
      refresh: () => Promise.all([channels.refresh(), accounts.refresh()]),
    }),
    [workspace.id, channels.refresh, accounts.refresh],
  );
  const go = (next: { tab?: SocialSettingsTab; account?: string }) =>
    void navigate({ search: previous => ({ ...previous, ...next }), replace: true });
  return (
    <Frame>
      <PageHeader
        title="Social"
        description="Connect social accounts, add their channels and choose who can publish. Prepare posts in chat."
      />
      {(state.kind === 'loading' || membership.state.kind === 'loading') && (
        <StatePanel kind="loading" title="Loading social settings" description="Checking your connections." />
      )}
      {state.kind === 'unavailable' && (
        <StatePanel kind="unavailable" title="Page not found" description="This page is not available." />
      )}
      {state.kind === 'error' && (
        <StatePanel kind="error" title="Social settings could not load" description={state.message}>
          <Button variant="outline" onClick={() => void refreshAll()}>
            Try again
          </Button>
        </StatePanel>
      )}
      {state.kind === 'ready' && membership.state.kind !== 'loading' && (
        <>
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>Social settings could not refresh. They show the last loaded state.</AlertDescription>
            </Alert>
          )}
          <Tabs value={tab} onValueChange={value => go({ tab: value as SocialSettingsTab })}>
            <TabsList variant="line" aria-label="Social settings sections">
              <TabsTrigger value="connections">Connections</TabsTrigger>
              <TabsTrigger value="channels">Channels</TabsTrigger>
              {admin && <TabsTrigger value="apps">Platform apps</TabsTrigger>}
            </TabsList>
            <TabsContent value="connections">
              <div className="pt-6">
                <SocialConnections
                  availability={state.data[0]}
                  apps={state.data[1]}
                  accounts={state.data[2]}
                  ownTeams={ownTeams}
                  admin={admin}
                  actions={connectionActions}
                  onChannels={account => go({ tab: 'channels', account })}
                  access={account => (
                    <AccountAccess
                      workspaceId={workspace.id}
                      account={account}
                      members={members}
                      teams={teams}
                      refreshAccounts={accounts.refresh}
                    />
                  )}
                />
              </div>
            </TabsContent>
            <TabsContent value="channels">
              <div className="pt-6">
                <SocialChannels
                  accounts={state.data[2]}
                  selectedId={search.account ?? null}
                  onSelect={account => go({ account })}
                  channels={state.data[3]}
                  viewer={{ membershipId, teamIds: ownTeams.map(team => team.id), members, teams }}
                  actions={channelActions}
                />
              </div>
            </TabsContent>
            {admin && (
              <TabsContent value="apps">
                <div className="pt-6">
                  <PlatformApps
                    availability={state.data[0]}
                    apps={state.data[1]}
                    redirectUri={new URL('/v1/social/oauth/callback', apiOrigin).href}
                    actions={appActions}
                  />
                </div>
              </TabsContent>
            )}
          </Tabs>
        </>
      )}
    </Frame>
  );
}

type AccountRole = 'use' | 'manage';
const accountRoles: readonly GrantRole<AccountRole>[] = [
  { key: 'use', label: 'Use', verb: 'use this connection' },
  { key: 'manage', label: 'Manage', verb: 'manage and share this connection' },
];

/** Who may use and manage a shared connection (PRODUCT 9). Its channels keep their own grants. */
function AccountAccess({
  workspaceId,
  account,
  members,
  teams,
  refreshAccounts,
}: {
  workspaceId: string;
  account: SocialAccountMetadata;
  members: Principal[];
  teams: Principal[];
  refreshAccounts: () => Promise<void>;
}) {
  const read = useFeatureRead({
    key: keys.grants(account.id),
    load: signal => socialSettingsApi.accountGrants(workspaceId, account.id, signal),
  });
  const state = read.state;
  if (state.kind === 'loading') return <p role="status">Loading access…</p>;
  if (state.kind !== 'ready')
    return (
      <StatePanel
        kind="error"
        title="Could not load access"
        description={state.kind === 'error' ? state.message : 'You no longer manage this connection.'}
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Try again
        </Button>
      </StatePanel>
    );
  const grants = state.data;
  return (
    <GrantsEditor
      title={`Access to ${accountName(account)}`}
      note="To publish, a person needs Use here and a grant on the channel. Channel grants are set under Channels."
      roles={accountRoles}
      members={members}
      teams={teams}
      managerRole="manage"
      saved={{
        version: grants.expectedVersion,
        value: {
          use: { memberIds: grants.memberIds, teamIds: grants.teamIds },
          manage: grants.managers ?? { memberIds: [], teamIds: [] },
        },
      }}
      save={(value, expectedVersion) =>
        socialSettingsApi.saveAccountGrants(workspaceId, account.id, {
          expectedVersion,
          memberIds: value.use.memberIds,
          teamIds: value.use.teamIds,
          managers: value.manage,
        })
      }
      refresh={() => Promise.all([read.refresh(), refreshAccounts()])}
      conflictCodes={['account-conflict']}
    />
  );
}
