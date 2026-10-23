import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type {
  Ownership,
  Platform,
  PlatformAppMetadata,
  PlatformAvailability,
  SocialAccountMetadata,
} from '@tulipfarm/social/contracts';
import type { SocialDisconnect } from '@/lib/social';
import { platformNames } from '../presentation';
import { accountName, accountStates, appSources, offered, settingsError, signInUrl, type Principal } from './labels';

export type ConnectionActions = {
  begin: (input: { platform: Platform; ownership: Ownership; platformAppId?: string }) => Promise<string>;
  reconnect: (accountId: string) => Promise<string>;
  disconnect: (accountId: string) => Promise<SocialDisconnect>;
  /** Leaves for the platform's sign-in page. */
  navigate: (url: string) => void;
};

/**
 * Connect, reconnect and disconnect social accounts (PRODUCT 3–9). Every member sees which platforms this workspace
 * can connect; only a connection's managers can reconnect or disconnect it.
 */
export function SocialConnections({
  availability,
  apps,
  accounts,
  ownTeams,
  admin,
  actions,
  onChannels,
  access,
}: {
  availability: readonly PlatformAvailability[];
  apps: readonly PlatformAppMetadata[];
  accounts: readonly SocialAccountMetadata[];
  ownTeams: readonly Principal[];
  admin: boolean;
  actions: ConnectionActions;
  onChannels: (accountId: string) => void;
  access: (account: SocialAccountMetadata) => ReactNode;
}) {
  const [connecting, setConnecting] = useState<Platform | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const shown = accounts.filter(account => account.state !== 'disconnected');
  return (
    <div className="space-y-8">
      <section aria-labelledby="social-connections" className="space-y-3">
        <h2 id="social-connections" className="text-base font-semibold">
          Connections
        </h2>
        <p role="status" className="text-sm empty:hidden">
          {notice}
        </p>
        {shown.length === 0 ? (
          <StatePanel
            kind="empty"
            title="No connections yet"
            description="Connect an account below. Then add its channels and choose who can publish."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {shown.map(account => (
              <ConnectionRow
                key={account.id}
                account={account}
                apps={apps}
                ownTeams={ownTeams}
                actions={actions}
                onChannels={onChannels}
                onNotice={setNotice}
                access={access}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="social-platforms" className="space-y-3">
        <h2 id="social-platforms" className="text-base font-semibold">
          Connect an account
        </h2>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {availability.map(item => (
            <li key={item.platform} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{platformNames[item.platform]}</p>
                  <p className="text-sm text-muted-foreground">
                    {item.available && item.appSource
                      ? `Uses the ${appSources[item.appSource].toLowerCase()}. ${offered(item)}`
                      : item.reason === 'workspace-app-required'
                        ? `Needs a workspace app. ${admin ? 'Add one under Platform apps.' : 'Ask a workspace admin to add one.'}`
                        : 'Not available in this workspace.'}
                  </p>
                </div>
                {item.available && (
                  <Button
                    variant="outline"
                    aria-expanded={connecting === item.platform}
                    onClick={() => setConnecting(connecting === item.platform ? null : item.platform)}
                  >
                    Connect {platformNames[item.platform]}
                  </Button>
                )}
              </div>
              {connecting === item.platform && (
                <ConnectForm
                  availability={item}
                  apps={apps.filter(app => app.platform === item.platform)}
                  ownTeams={ownTeams}
                  actions={actions}
                  onCancel={() => setConnecting(null)}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ConnectForm({
  availability,
  apps,
  ownTeams,
  actions,
  onCancel,
}: {
  availability: PlatformAvailability;
  apps: readonly PlatformAppMetadata[];
  ownTeams: readonly Principal[];
  actions: ConnectionActions;
  onCancel: () => void;
}) {
  const name = platformNames[availability.platform];
  const latest = apps.at(-1)?.id ?? '';
  // Without a TulipFarm or server app, the workspace's own app is the only way in.
  const [appId, setAppId] = useState(availability.appSource === 'workspace' ? latest : '');
  const [owner, setOwner] = useState('personal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = ownTeams.find(item => item.id === owner);
  const defaultApp = availability.appSource ? appSources[availability.appSource] : 'Default app';
  const appLabel = (id: string) =>
    id ? `${apps.find(app => app.id === id)?.name ?? 'Workspace app'} (workspace app)` : defaultApp;
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const url = await actions.begin({
        platform: availability.platform,
        ownership: team ? { kind: 'business', owningTeamId: team.id } : { kind: 'personal' },
        ...(appId ? { platformAppId: appId } : {}),
      });
      actions.navigate(signInUrl(url));
    } catch (failure) {
      setError(settingsError(failure));
      setBusy(false);
    }
  }
  return (
    <form
      className="space-y-4 rounded-md bg-muted/40 p-4"
      aria-label={`Connect ${name}`}
      onSubmit={event => {
        event.preventDefault();
        void start();
      }}
    >
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`social-owner-${availability.platform}`}>Who owns it</Label>
          <Select value={owner} onValueChange={value => setOwner(value ?? 'personal')}>
            <SelectTrigger id={`social-owner-${availability.platform}`} width="full">
              <SelectValue>{team ? `Shared with ${team.name}` : 'Just me (personal)'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="personal">Just me (personal)</SelectItem>
              {ownTeams.map(item => (
                <SelectItem key={item.id} value={item.id}>
                  Shared with {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {team
              ? `A brand or company account. You manage it and choose who in ${team.name} can use it.`
              : 'Your own profile. Only you can see it, use it or publish to its channels.'}
          </p>
        </div>
        {apps.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor={`social-app-${availability.platform}`}>Platform app</Label>
            <Select value={appId} onValueChange={value => setAppId(value ?? '')}>
              <SelectTrigger id={`social-app-${availability.platform}`} width="full">
                <SelectValue>{appLabel(appId)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {availability.appSource !== 'workspace' && <SelectItem value="">{defaultApp}</SelectItem>}
                {apps.map(app => (
                  <SelectItem key={app.id} value={app.id}>
                    {app.name} (workspace app)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </fieldset>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Continue to {name}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const stateNotes: Partial<Record<SocialAccountMetadata['state'], string>> = {
  authorizing: 'Sign-in was not finished. Reconnect to try again.',
  'reconnect-required':
    'Sign in again to resume. Then add its channels again. Scheduled posts on it need a new approval.',
  disabled: 'This connection is turned off. Reconnect to use it again.',
};

function ConnectionRow({
  account,
  apps,
  ownTeams,
  actions,
  onChannels,
  onNotice,
  access,
}: {
  account: SocialAccountMetadata;
  apps: readonly PlatformAppMetadata[];
  ownTeams: readonly Principal[];
  actions: ConnectionActions;
  onChannels: (accountId: string) => void;
  onNotice: (text: string) => void;
  access: (account: SocialAccountMetadata) => ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = accountName(account);
  const platform = platformNames[account.platform];
  const state = accountStates[account.state];
  const { ownership } = account;
  const owner =
    ownership.kind === 'personal'
      ? 'Personal'
      : `Shared with ${ownTeams.find(team => team.id === ownership.owningTeamId)?.name ?? 'a team'}`;
  const app =
    account.appSource === 'workspace'
      ? `${apps.find(item => item.id === account.platformAppId)?.name ?? 'Workspace app'} (workspace app)`
      : appSources[account.appSource];
  const reconnectable = ['authorizing', 'reconnect-required', 'disabled'].includes(account.state);
  const manage = account.capabilities.manage;
  async function reconnect() {
    setBusy(true);
    setError(null);
    try {
      actions.navigate(signInUrl(await actions.reconnect(account.id)));
    } catch (failure) {
      setError(settingsError(failure));
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const result = await actions.disconnect(account.id);
      setConfirming(false);
      onNotice(
        result.providerRevocation === 'revoked'
          ? `${name} is disconnected and ${platform} access is removed.`
          : result.providerRevocation === 'manual-required'
            ? `${name} is disconnected in TulipFarm. ${platform} does not let TulipFarm remove its access, so remove it in your ${platform} settings.`
            : `${name} is disconnected in TulipFarm. ${platform} did not confirm its access was removed, so remove it in your ${platform} settings.`,
      );
    } catch (failure) {
      setConfirming(false);
      setError(settingsError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="truncate">{name}</span>
            <Badge variant={state.tone}>{state.label}</Badge>
          </p>
          <p className="text-sm text-muted-foreground">
            {platform}
            {account.identity?.handle && account.identity.handle !== name ? ` · ${account.identity.handle}` : ''} ·{' '}
            {owner} · {app}
          </p>
          {stateNotes[account.state] && <p className="text-sm">{stateNotes[account.state]}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" aria-label={`Channels for ${name}`} onClick={() => onChannels(account.id)}>
            Channels
          </Button>
          {manage && account.ownership.kind === 'business' && (
            <Button
              variant="outline"
              aria-expanded={showAccess}
              aria-label={`Who can use ${name}`}
              onClick={() => setShowAccess(!showAccess)}
            >
              Access
            </Button>
          )}
          {manage && reconnectable && (
            <Button disabled={busy} aria-label={`Reconnect ${name}`} onClick={() => void reconnect()}>
              Reconnect
            </Button>
          )}
          {manage && (
            <Button
              variant="ghost"
              disabled={busy}
              aria-label={`Disconnect ${name}`}
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </Button>
          )}
        </div>
      </div>
      {!manage && <p className="text-sm text-muted-foreground">Only its managers can reconnect or disconnect it.</p>}
      {showAccess && manage && access(account)}
      <AlertDialog open={confirming} onOpenChange={open => !busy && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Scheduled posts on its channels that have not started are cancelled, and its saved analytics are deleted.
            Posts already sending keep their status. Its channels stop working until it is connected again.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep connection</AlertDialogCancel>
            <Button variant="destructive" disabled={busy} aria-busy={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}
