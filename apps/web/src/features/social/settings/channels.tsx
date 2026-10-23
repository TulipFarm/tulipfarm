import { useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { Channel, ChannelGrants, DiscoveredChannel, SocialAccountMetadata } from '@tulipfarm/social/contracts';
import { platformNames } from '../presentation';
import { GrantsEditor, type GrantRole } from './grants';
import { accountName, channelKinds, channelStale, holds, settingsError, type Principal } from './labels';

type ChannelRole = 'publish' | 'analytics' | 'engagement' | 'manage';
export const channelRoles: readonly GrantRole<ChannelRole>[] = [
  { key: 'publish', label: 'Publish', verb: 'publish' },
  { key: 'analytics', label: 'Analytics', verb: 'read analytics' },
  { key: 'engagement', label: 'Engagement', verb: 'handle comments and messages' },
  { key: 'manage', label: 'Manage', verb: 'manage this channel' },
];

export type ChannelActions = {
  reachable: (accountId: string) => Promise<DiscoveredChannel[]>;
  add: (account: SocialAccountMetadata, platformChannelId: string) => Promise<Channel>;
  saveGrants: (channelId: string, grants: ChannelGrants) => Promise<Channel>;
  refresh: () => Promise<unknown>;
};

type Viewer = {
  membershipId: string;
  teamIds: readonly string[];
  members: readonly Principal[];
  teams: readonly Principal[];
};

/**
 * One connection's channels (PRODUCT 10–11). Reaching a channel grants nothing: adding it needs the connection's
 * manage grant and gives the adder only `manage`, and publishing is granted separately here.
 */
export function SocialChannels({
  accounts,
  selectedId,
  onSelect,
  channels,
  viewer,
  actions,
}: {
  accounts: readonly SocialAccountMetadata[];
  selectedId: string | null;
  onSelect: (accountId: string) => void;
  channels: readonly Channel[];
  viewer: Viewer;
  actions: ChannelActions;
}) {
  const usable = accounts.filter(account => account.state !== 'disconnected');
  const account = usable.find(item => item.id === selectedId) ?? usable[0];
  if (!account)
    return (
      <StatePanel
        kind="empty"
        title="No connections to show"
        description="Connect an account first, or ask its manager to grant you access."
      />
    );
  const added = channels.filter(channel => channel.accountId === account.id);
  return (
    <div className="space-y-8">
      <div className="max-w-md space-y-2">
        <Label htmlFor="social-channel-account">Connection</Label>
        <Select value={account.id} onValueChange={value => value && onSelect(value)}>
          <SelectTrigger id="social-channel-account" width="full">
            <SelectValue>{`${accountName(account)} · ${platformNames[account.platform]}`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {usable.map(item => (
              <SelectItem key={item.id} value={item.id}>
                {accountName(item)} · {platformNames[item.platform]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <section aria-labelledby="social-added-channels" className="space-y-3">
        <h2 id="social-added-channels" className="text-base font-semibold">
          Added channels
        </h2>
        {added.length === 0 ? (
          <StatePanel
            kind="empty"
            title="No channels you can see"
            description="Add a channel below, or ask a channel manager to grant you access."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {added.map(channel => (
              <ChannelRow
                key={`${channel.id}:${account.generation}`}
                channel={channel}
                account={account}
                viewer={viewer}
                actions={actions}
              />
            ))}
          </ul>
        )}
      </section>
      <Reachable key={account.id} account={account} added={added} actions={actions} />
    </div>
  );
}

/** A personal connection's channels can only be granted to its owner, who is the viewer when they can manage them. */
export function channelGrantPrincipals(account: SocialAccountMetadata, viewer: Viewer) {
  if (account.ownership.kind !== 'personal') return { members: viewer.members, teams: viewer.teams };
  const owner = viewer.members.find(member => member.id === viewer.membershipId) ?? {
    id: viewer.membershipId,
    name: 'You',
  };
  return { members: [owner], teams: [] };
}

function ChannelRow({
  channel,
  account,
  viewer,
  actions,
}: {
  channel: Channel;
  account: SocialAccountMetadata;
  viewer: Viewer;
  actions: ChannelActions;
}) {
  const [open, setOpen] = useState(false);
  const stale = channelStale(channel, account);
  const manage = holds(channel.grants.manage, viewer.membershipId, viewer.teamIds);
  const personal = account.ownership.kind === 'personal';
  const principals = channelGrantPrincipals(account, viewer);
  const state = stale
    ? { label: 'Add again', tone: 'warning' as const }
    : !channel.enabled
      ? { label: 'Turned off', tone: 'secondary' as const }
      : { label: 'Ready', tone: 'success' as const };
  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="truncate">{channel.displayName || channel.platformChannelId}</span>
            <Badge variant={state.tone}>{state.label}</Badge>
          </p>
          <p className="text-sm text-muted-foreground">
            {platformNames[channel.platform]} {channelKinds[channel.channelKind].toLowerCase()}
          </p>
          {stale && <p className="text-sm">The connection was reconnected. Add this channel again below to use it.</p>}
        </div>
        {manage && (
          <Button
            variant="outline"
            aria-expanded={open}
            aria-label={`Access to ${channel.displayName || channel.platformChannelId}`}
            onClick={() => setOpen(!open)}
          >
            Access
          </Button>
        )}
      </div>
      {!manage && <p className="text-sm text-muted-foreground">Ask a channel manager to change who can publish.</p>}
      {open && manage && (
        <GrantsEditor
          title="Channel access"
          note={
            personal
              ? 'This is a personal connection, so only its owner can hold grants on its channels.'
              : 'Each grant is separate, and people also need Use on the connection. Agents act through the grants of the person who runs them.'
          }
          roles={channelRoles}
          members={principals.members}
          teams={principals.teams}
          managerRole="manage"
          saved={{ version: channel.grantsVersion, value: channel.grants }}
          save={(value, expectedVersion) => actions.saveGrants(channel.id, { expectedVersion, ...value })}
          refresh={actions.refresh}
          conflictCodes={['channel-conflict']}
        />
      )}
    </li>
  );
}

function Reachable({
  account,
  added,
  actions,
}: {
  account: SocialAccountMetadata;
  added: readonly Channel[];
  actions: ChannelActions;
}) {
  const [found, setFound] = useState<DiscoveredChannel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const active = account.state === 'active' || account.state === 'refreshing';
  async function find() {
    setBusy('find');
    setMessage(null);
    try {
      setFound(await actions.reachable(account.id));
    } catch (failure) {
      setMessage({ text: settingsError(failure), ok: false });
    } finally {
      setBusy(null);
    }
  }
  async function add(item: DiscoveredChannel) {
    setBusy(item.platformChannelId);
    setMessage(null);
    try {
      await actions.add(account, item.platformChannelId);
      await actions.refresh().catch(() => {});
      setMessage({
        text: `${item.displayName || item.platformChannelId} added. You can manage it. Open Access to choose who can publish.`,
        ok: true,
      });
    } catch (failure) {
      setMessage({ text: settingsError(failure), ok: false });
    } finally {
      setBusy(null);
    }
  }
  return (
    <section aria-labelledby="social-reachable" className="space-y-3">
      <h2 id="social-reachable" className="text-base font-semibold">
        Channels this connection can reach
      </h2>
      <p className="text-sm text-muted-foreground">
        Reaching a channel gives no one access. Adding it makes you its manager; then grant publishing to the right
        people.
      </p>
      {!account.capabilities.manage ? (
        <p className="text-sm">Only managers of this connection can add its channels.</p>
      ) : !active ? (
        <p className="text-sm">Reconnect this connection before adding channels.</p>
      ) : (
        <>
          <Button variant="outline" disabled={busy !== null} aria-busy={busy === 'find'} onClick={() => void find()}>
            {found ? 'Refresh list' : 'Find channels'}
          </Button>
          {found && found.length === 0 && (
            <StatePanel kind="empty" title="No channels found" description="This account cannot reach any channels." />
          )}
          {found && found.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {found.map(item => {
                const existing = added.find(channel => channel.platformChannelId === item.platformChannelId);
                const current = existing && !channelStale(existing, account);
                const name = item.displayName || item.platformChannelId;
                return (
                  <li key={item.platformChannelId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="font-medium">{name}</p>
                      <p className="text-sm text-muted-foreground">
                        {channelKinds[item.channelKind]}
                        {item.handle ? ` · ${item.handle}` : ''}
                      </p>
                    </div>
                    {current ? (
                      <Badge variant="secondary">Added</Badge>
                    ) : (
                      <Button
                        disabled={busy !== null}
                        aria-busy={busy === item.platformChannelId}
                        aria-label={`${existing ? 'Add again' : 'Add'} ${name}`}
                        onClick={() => void add(item)}
                      >
                        {existing ? 'Add again' : 'Add channel'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {message && (
        <Alert variant={message.ok ? 'default' : 'destructive'}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
