import { useMemo, useState, type ReactNode } from 'react';
import { cn } from 'cn';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Switch } from '@tulipfarm/sprout/switch';
import { MoreH } from 'reicon-react/icons/MoreH';
import { useFeatureChanges } from '@/lib/query';
import { TableRequestError } from '@/features/tables/request-state';
import { modelKeys } from './queries';
import {
  PlanModels,
  ShareDialog,
  audience,
  ownPlans,
  providerLabels,
  useAskToShare,
  usePeople,
  subscriptionsKey,
  useSubscriptions,
  type Subscription,
} from './subscription-sharing';

/** Matches the server's limit of plan accounts per member and provider. */
export const maxPlanAccounts = 5;

export type PlanProvider = Subscription['provider'];

/** One of the member's own accounts of a provider, as its sign-in hook knows it. */
export type PlanAccount = {
  connectionId: string;
  state: 'connected' | 'plan-disabled' | 'reconnect-required';
  /** Email or login; null when the provider doesn't say. */
  account: string | null;
  /** Why the account needs attention, shown under it. */
  note?: string;
  /** The label of the action that renews this account's sign-in. */
  reconnectLabel?: string;
};

/**
 * Everything a provider panel needs from one provider's sign-in: its accounts, the one-click start, the steps of a
 * sign-in that's under way, and the account actions. Each provider's hook owns its own sign-in details.
 */
export type PlanConnector = {
  provider: PlanProvider;
  /** False when this server doesn't offer the provider's plans. */
  offered: boolean;
  read: { kind: 'loading' } | { kind: 'error'; message: string; retry: () => void } | { kind: 'ready'; stale: boolean };
  accounts: PlanAccount[];
  message: { tone: 'error' | 'success' | 'warning'; text: string } | null;
  /** A start, finish or disconnect is running. */
  busy: boolean;
  /** A sign-in is waiting on the member, such as for a pasted code. */
  signingIn: boolean;
  /** Starts connecting another account. Call it from the click, so a new tab isn't blocked. */
  start: () => void;
  startLabel: string;
  /** What to know before connecting, shown above the Connect button. */
  before?: ReactNode;
  /** The steps of the sign-in under way. */
  flow: ReactNode;
  /** Other ways to connect, such as a pasted token. */
  others?: ReactNode;
  reconnect: (account: PlanAccount) => void;
  disconnect: (account: PlanAccount) => Promise<void>;
  disconnectDescription: (account: PlanAccount) => string;
  usageUrl: string;
  /** Shown over the panel, such as a welcome. While it shows, the share question waits. */
  overlay?: ReactNode;
};

const states = {
  connected: { label: 'Connected', variant: 'success' },
  'reconnect-required': { label: 'Needs sign-in again', variant: 'warning' },
  'plan-disabled': { label: 'Plan usage off', variant: 'secondary' },
} as const;

export const accountLabel = (provider: PlanProvider, account: string | null) =>
  account ? `${provider === 'copilot' ? '@' : ''}${account}` : `${providerLabels[provider]} account`;

/**
 * Lays out an account list as columns: the account, one switch per use, then its actions. Narrow screens stack them,
 * so each switch carries its own label there.
 */
const columnLayouts = {
  plan: 'sm:grid-cols-[minmax(0,1fr)_5rem_5rem_8rem]',
  github: 'sm:grid-cols-[minmax(0,1fr)_5rem_5rem_5rem_12rem]',
} as const;

export type AccountColumns = keyof typeof columnLayouts;

export const accountColumns = (layout: AccountColumns) =>
  cn('sm:grid sm:items-center sm:gap-x-2', columnLayouts[layout]);

/** The column names over an account list. Screen readers get each switch's own name instead. */
export function AccountColumnHeads({ uses, layout }: { uses: string[]; layout: AccountColumns }) {
  return (
    <div
      aria-hidden="true"
      className={cn('hidden px-4 text-xs font-medium text-muted-foreground', accountColumns(layout))}
    >
      <span>Account</span>
      {uses.map(use => (
        <span key={use} className="text-center">
          {use}
        </span>
      ))}
      <span />
    </div>
  );
}

/** Turns one use of one account on or off. */
export function UseSwitch({
  use,
  account,
  checked,
  disabled,
  busy,
  onChange,
}: {
  use: string;
  account: string;
  checked: boolean;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  onChange: (on: boolean) => void;
}) {
  return (
    <span className="flex items-center gap-2 sm:justify-center">
      <Switch
        size="sm"
        aria-label={`Use ${account} for ${use.toLowerCase()}`}
        checked={checked}
        disabled={disabled}
        aria-busy={busy}
        onCheckedChange={on => onChange(on === true)}
      />
      <span aria-hidden="true" className="text-sm text-muted-foreground sm:hidden">
        {use}
      </span>
    </span>
  );
}

const useNames = { chat: 'Chat', coding: 'Coding' } as const;

/** The member's own connections of a provider, from the shared subscriptions list. */
export function useOwnPlans(workspaceId: string, provider: PlanProvider, enabled = true) {
  const { read } = useSubscriptions(workspaceId, enabled);
  const data = read.state.kind === 'ready' ? read.state.data : null;
  return useMemo(() => ownPlans(data, provider), [data, provider]);
}

/**
 * The member's own accounts of one provider: plan, state and who it's shared with, a switch for each use, with Share
 * up front and the rest (models, usage, reconnect, disconnect) in a menu. Chats and coding runs pick among the
 * accounts whose use is on.
 */
export function PlanAccounts({ workspaceId, connector }: { workspaceId: string; connector: PlanConnector }) {
  const { provider, accounts } = connector;
  const owns = useOwnPlans(workspaceId, provider);
  const { api } = useSubscriptions(workspaceId);
  const { change } = useFeatureChanges();
  const [turning, setTurning] = useState<Record<string, boolean>>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function turn(connectionId: string, use: keyof typeof useNames, on: boolean) {
    const key = `${connectionId}:${use}`;
    setTurning(current => ({ ...current, [key]: on }));
    setFailure(null);
    try {
      await api.setUses(connectionId, { [use]: on }, AbortSignal.timeout(30_000));
      await change({ keys: [subscriptionsKey, modelKeys.catalog()] });
    } catch (error) {
      setFailure(error instanceof TableRequestError ? error.message : 'Couldn’t save that change. Try again.');
    } finally {
      setTurning(({ [key]: _done, ...rest }) => rest);
    }
  }
  const people = usePeople(workspaceId);
  const [asking, stopAsking] = useAskToShare(workspaceId, provider, owns, !connector.overlay);
  const [sharing, setSharing] = useState<Subscription | null>(null);
  const [models, setModels] = useState<Subscription | null>(null);
  const [confirming, setConfirming] = useState<PlanAccount | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const locked = connector.busy || connector.signingIn || saving !== null;

  async function remove(account: PlanAccount) {
    setSaving(account.connectionId);
    try {
      await connector.disconnect(account);
    } finally {
      setSaving(null);
    }
  }

  const shown = sharing ?? asking;
  return (
    <>
      <AccountColumnHeads uses={[useNames.chat, useNames.coding]} layout="plan" />
      <ul
        className="divide-y divide-border rounded-xl border border-border"
        aria-label={`Your ${providerLabels[provider]} accounts`}
      >
        {accounts.map(account => {
          const own = owns.find(item => item.connectionId === account.connectionId);
          const state = states[account.state];
          const label = accountLabel(provider, account.account);
          return (
            <li
              key={account.connectionId}
              className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3', accountColumns('plan'))}
            >
              <div className="grid min-w-0 basis-full gap-0.5 sm:basis-auto">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="truncate">{label}</span>
                  {own?.plan && <Badge variant="outline">{own.plan}</Badge>}
                  {account.state !== 'connected' && <Badge variant={state.variant}>{state.label}</Badge>}
                </p>
                <p className="text-sm text-muted-foreground">
                  {account.note ??
                    (saving === account.connectionId
                      ? 'Disconnecting…'
                      : own?.grants?.length
                        ? `Shared with ${audience(own.grants, people)}`
                        : 'Only you can use it')}
                </p>
              </div>
              {(['chat', 'coding'] as const).map(use => {
                const pending = turning[`${account.connectionId}:${use}`];
                return (
                  <UseSwitch
                    key={use}
                    use={useNames[use]}
                    account={label}
                    checked={pending ?? (use === 'chat' ? own?.useForChat : own?.useForCoding) ?? false}
                    disabled={!own || pending !== undefined || connector.busy}
                    busy={pending !== undefined}
                    onChange={on => void turn(account.connectionId, use, on)}
                  />
                );
              })}
              <div className="ml-auto flex items-center justify-end gap-1">
                {account.state !== 'connected' && (
                  <Button size="sm" disabled={locked} onClick={() => connector.reconnect(account)}>
                    {account.reconnectLabel ?? 'Reconnect'}
                  </Button>
                )}
                {own?.canShare && account.state === 'connected' && (
                  <Button size="sm" variant="ghost" disabled={locked} onClick={() => setSharing(own)}>
                    Share
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon-sm" disabled={locked} aria-label={`More for ${label}`} />
                    }
                  >
                    <MoreH size={16} aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      {own && <DropdownMenuItem onClick={() => setModels(own)}>Models</DropdownMenuItem>}
                      {account.state === 'connected' && (
                        <DropdownMenuItem
                          onClick={() => window.open(connector.usageUrl, '_blank', 'noopener,noreferrer')}
                        >
                          Manage usage
                        </DropdownMenuItem>
                      )}
                      {account.state === 'connected' && (
                        <DropdownMenuItem onClick={() => connector.reconnect(account)}>
                          {account.reconnectLabel ?? 'Reconnect'}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirming(account)}>
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          );
        })}
      </ul>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {models && (
        <Dialog open onOpenChange={value => !value && setModels(null)}>
          <DialogContent size="form">
            <DialogHeader>
              <DialogTitle>{accountLabel(provider, models.account)}</DialogTitle>
              <DialogDescription>{providerLabels[provider]} plan models you can pick in chats.</DialogDescription>
            </DialogHeader>
            <PlanModels
              workspaceId={workspaceId}
              subscription={owns.find(item => item.connectionId === models.connectionId) ?? models}
              people={people}
            />
          </DialogContent>
        </Dialog>
      )}
      {confirming && (
        <Dialog open onOpenChange={value => !value && setConfirming(null)}>
          <DialogContent size="form">
            <DialogHeader>
              <DialogTitle>Disconnect {accountLabel(provider, confirming.account)}?</DialogTitle>
              <DialogDescription>{connector.disconnectDescription(confirming)}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const account = confirming;
                  setConfirming(null);
                  void remove(account);
                }}
              >
                Disconnect
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {shown && (
        <ShareDialog
          workspaceId={workspaceId}
          subscription={shown}
          people={people}
          asking={!sharing}
          close={() => {
            setSharing(null);
            stopAsking();
          }}
        />
      )}
    </>
  );
}
