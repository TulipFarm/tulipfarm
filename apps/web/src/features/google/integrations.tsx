import { useEffect, useRef, useState } from 'react';
import { RefreshIcon } from '@tulipfarm/icons';
import type { GoogleGrantTarget } from '@tulipfarm/google-workspace/public-contracts';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Label } from '@tulipfarm/sprout/label';
import { RadioGroup, RadioGroupItem } from '@tulipfarm/sprout/radio-group';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { googleApi, googleError, type GoogleAccountSummary } from '@/lib/google-workspace';
import { GoogleReadFeedback } from './read';
import { useGoogleIntegration, useIntegrationChanges } from '@/features/integrations/queries';
import { usePeople } from '@/features/models/subscription-sharing';
import type { SecretGrant } from '@/features/secrets/contracts';
import { GrantsEditor, granteeKey, type RoleOptions } from '@/features/secrets/grants-editor';
import { GoogleProposals } from './proposals';
import { GoogleHeartbeat } from './heartbeat';

type Disconnect =
  | { phase: 'idle' }
  | { phase: 'confirm'; account: GoogleAccountSummary; useLegacyDisconnect: boolean }
  | { phase: 'pending'; integrationId: string }
  | { phase: 'uncertain' };

type Reach = 'private' | 'workspace' | 'specific';

const googleRoles = {
  use: { label: 'Can use', hint: 'Read, send, and run agents with this account' },
  manage: { label: 'Can use and manage', hint: 'Also change sharing or disconnect this account' },
} as const satisfies RoleOptions;

const askShareKey = (workspaceId: string) => `tulipfarm:ask-to-share:${workspaceId}:google`;

function toSecretGrant(grant: GoogleGrantTarget): SecretGrant {
  if (grant.kind === 'workspace') return { grantee: { kind: 'workspace' }, role: grant.role };
  if (grant.kind === 'team') return { grantee: { kind: 'team', teamId: grant.teamId }, role: grant.role };
  return { grantee: { kind: 'member', membershipId: grant.membershipId }, role: grant.role };
}

function toGoogleGrant(grant: SecretGrant): GoogleGrantTarget {
  if (grant.grantee.kind === 'workspace') return { kind: 'workspace', role: grant.role };
  if (grant.grantee.kind === 'team') return { kind: 'team', teamId: grant.grantee.teamId, role: grant.role };
  return { kind: 'member', membershipId: grant.grantee.membershipId, role: grant.role };
}

function visibleAccounts(data: NonNullable<ReturnType<typeof useGoogleIntegration>['data']>): {
  list: GoogleAccountSummary[];
  fromAccountsApi: boolean;
} {
  const active = data.accounts.filter(account => account.status !== 'disconnected');
  if (active.length > 0) return { list: active, fromAccountsApi: true };
  if (data.status.status === 'disconnected') return { list: [], fromAccountsApi: false };
  return {
    fromAccountsApi: false,
    list: [
      {
        integrationId: data.status.integrationId,
        ownership: 'personal',
        status: data.status.status,
        accountId: data.status.accountId,
        email: data.status.email,
        generation: data.status.generation,
        grantsVersion: 1,
        scopes: data.status.scopes,
        canUse: true,
        canManage: true,
      },
    ],
  };
}

function GoogleShareDialog({
  workspaceId,
  account,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  account: GoogleAccountSummary;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const people = usePeople(workspaceId);
  const [loading, setLoading] = useState(true);
  const [grantsVersion, setGrantsVersion] = useState(account.grantsVersion);
  const [reach, setReach] = useState<Reach>(account.ownership === 'shared' ? 'workspace' : 'private');
  const [chosen, setChosen] = useState<SecretGrant[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    googleApi
      .grants(workspaceId, account.integrationId, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        setGrantsVersion(response.grantsVersion);
        const others = response.grants
          .map(toSecretGrant)
          .filter(grant => !(grant.grantee.kind === 'member' && grant.grantee.membershipId === people.you));
        if (others.length === 0) {
          setReach('private');
          setChosen([]);
        } else if (others.some(grant => grant.grantee.kind === 'workspace')) {
          setReach('workspace');
          setChosen(others.filter(grant => grant.grantee.kind !== 'workspace'));
        } else {
          setReach('specific');
          setChosen(others);
        }
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(googleError(failure));
        setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, account.integrationId, people.you]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const nextGrants: GoogleGrantTarget[] =
        reach === 'private'
          ? []
          : reach === 'workspace'
            ? [
                ...(people.you ? [{ kind: 'member' as const, membershipId: people.you, role: 'manage' as const }] : []),
                { kind: 'workspace' as const, role: 'use' as const },
                ...chosen.filter(grant => grant.role === 'manage').map(toGoogleGrant),
              ]
            : [
                ...(people.you ? [{ kind: 'member' as const, membershipId: people.you, role: 'manage' as const }] : []),
                ...chosen.map(toGoogleGrant),
              ];
      const deduped = new Map<string, GoogleGrantTarget>();
      for (const grant of nextGrants) {
        const key = granteeKey(toSecretGrant(grant));
        if (!deduped.has(key)) deduped.set(key, grant);
      }
      await googleApi.setGrants(workspaceId, account.integrationId, {
        expectedGrantsVersion: grantsVersion,
        grants: [...deduped.values()],
      });
      await onSaved();
      onClose();
    } catch (failure) {
      setError(googleError(failure));
    } finally {
      setSaving(false);
    }
  }

  const options: { value: Reach; label: string }[] = [
    { value: 'private', label: 'Only you' },
    { value: 'workspace', label: 'Everyone in the workspace' },
    { value: 'specific', label: 'Specific people or teams' },
  ];
  const emptySpecific = reach === 'specific' && chosen.length === 0;

  return (
    <Dialog open onOpenChange={open => !open && !saving && onClose()}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Share {account.email ?? 'Google account'}</DialogTitle>
          <DialogDescription>
            Choose who can use this Google account for email, calendar, and agents in this workspace.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="space-y-3 py-2">
            <Skeleton />
            <Skeleton />
          </div>
        ) : (
          <div className="grid gap-4">
            <RadioGroup
              aria-label="Who can use this Google account"
              value={reach}
              disabled={saving}
              onValueChange={value => {
                setError(null);
                setReach(value as Reach);
              }}
            >
              <div className="grid gap-3">
                {options.map(option => (
                  <div key={option.value} className="flex items-center gap-3">
                    <RadioGroupItem id={`google-share-${account.integrationId}-${option.value}`} value={option.value} />
                    <Label htmlFor={`google-share-${account.integrationId}-${option.value}`}>{option.label}</Label>
                  </div>
                ))}
              </div>
            </RadioGroup>
            {reach === 'specific' && (
              <div className="grid gap-2 pl-7">
                <GrantsEditor
                  value={chosen}
                  owner={people.you}
                  people={people}
                  disabled={saving}
                  onChange={next => {
                    setError(null);
                    setChosen(next);
                  }}
                  description="People and teams you add can read and send mail or use calendar with this account."
                  roles={googleRoles}
                  everyone={false}
                  showOwner
                  addLabel="Add people or teams"
                />
              </div>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={loading || saving || emptySpecific} aria-busy={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save sharing'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GoogleConfigureDialog({
  workspaceId,
  account,
  available,
  onClose,
}: {
  workspaceId: string;
  account: GoogleAccountSummary;
  available: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Configure {account.email ?? 'Google account'}</DialogTitle>
          <DialogDescription>Manage Gmail heartbeat and account settings.</DialogDescription>
        </DialogHeader>
        <div className="max-h-96 overflow-y-auto pr-1">
          <GoogleHeartbeat workspaceId={workspaceId} available={available} embedded />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GoogleAccount({ workspaceId }: { workspaceId: string }) {
  const read = useGoogleIntegration(workspaceId);
  const changes = useIntegrationChanges();
  const [state, setState] = useState<Disconnect>({ phase: 'idle' });
  const [connecting, setConnecting] = useState(false);
  const [shareAccount, setShareAccount] = useState<GoogleAccountSummary | null>(null);
  const [configureAccount, setConfigureAccount] = useState<GoogleAccountSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const data = read.data;
  const blocked = read.busy || !!read.error || state.phase === 'pending' || state.phase === 'uncertain' || connecting;

  const visible = data ? visibleAccounts(data) : { list: [] as GoogleAccountSummary[], fromAccountsApi: false };

  useEffect(() => {
    if (!data || visible.list.length === 0) return;
    const key = askShareKey(workspaceId);
    let known: unknown;
    try {
      const stored = sessionStorage.getItem(key);
      if (!stored) return;
      known = JSON.parse(stored);
    } catch {
      return;
    }
    const before = new Set(Array.isArray(known) ? known : []);
    const added = visible.list.find(
      account => account.status === 'connected' && account.canManage && !before.has(account.integrationId),
    );
    if (!added) return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      return;
    }
    setShareAccount(added);
  }, [workspaceId, data, visible.list]);

  async function disconnect(account: GoogleAccountSummary, useLegacyDisconnect: boolean) {
    if (lock.current) return;
    lock.current = true;
    setMessage(null);
    setState({ phase: 'pending', integrationId: account.integrationId });
    try {
      const result = useLegacyDisconnect
        ? await googleApi.disconnect(workspaceId)
        : await googleApi.disconnectAccount(workspaceId, account.integrationId);
      await changes.authority('google');
      setState({ phase: 'idle' });
      if (!result.revoked) setMessage('Disconnected here. Also remove TulipFarm in your Google Account permissions.');
    } catch (error) {
      setMessage(googleError(error));
      setState({ phase: 'uncertain' });
    } finally {
      lock.current = false;
    }
  }

  async function connectAccount() {
    if (lock.current) return;
    lock.current = true;
    setMessage(null);
    setConnecting(true);
    try {
      try {
        sessionStorage.setItem(
          askShareKey(workspaceId),
          JSON.stringify(visible.list.filter(a => a.status === 'connected').map(a => a.integrationId)),
        );
      } catch {
        // Without storage the member can still share from the Share button.
      }
      const { authorizationUrl } = await googleApi.begin(workspaceId, undefined, {
        ownership: 'personal',
        newAccount: true,
      });
      const url = new URL(authorizationUrl);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth')
        throw new Error('Unexpected consent destination');
      window.location.assign(url.href);
    } catch (error) {
      setMessage(googleError(error));
      setConnecting(false);
      lock.current = false;
    }
  }

  async function check() {
    const result = await read.refresh();
    if (result && state.phase === 'uncertain') {
      setState({ phase: 'idle' });
      if (result.status.status === 'disconnected' && result.accounts.every(a => a.status === 'disconnected'))
        setMessage(null);
    }
  }

  if (!data)
    return (
      message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )
    );

  const { list: accounts, fromAccountsApi } = visible;

  if (accounts.length === 0)
    return (
      <section aria-label="Google accounts" className="space-y-3">
        {message && (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
      </section>
    );

  const confirmAccount = state.phase === 'confirm' ? state.account : null;

  return (
    <section aria-label="Google accounts" className="space-y-3">
      <ul aria-label="Connected Google accounts" className="divide-y divide-border rounded-lg border border-border">
        {accounts.map(account => {
          const isPending = state.phase === 'pending' && state.integrationId === account.integrationId;
          return (
            <li key={account.integrationId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <EntityAvatar seed={account.integrationId} name={account.email ?? 'Google'} size="sm" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium text-foreground">
                      {account.email ?? 'Google account'}
                    </p>
                    <Badge variant={account.ownership === 'shared' ? 'secondary' : 'outline'}>
                      {account.ownership === 'shared' ? 'Shared' : 'Personal'}
                    </Badge>
                    {account.status === 'reconnect-required' && <Badge variant="warning">Reconnect required</Badge>}
                  </div>
                  {account.label && <p className="truncate text-xs text-muted-foreground">{account.label}</p>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {account.canManage && (
                  <Button variant="outline" size="sm" disabled={blocked} onClick={() => setShareAccount(account)}>
                    Share
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={blocked} onClick={() => setConfigureAccount(account)}>
                  Configure
                </Button>
                {account.canManage && (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={blocked}
                    aria-busy={isPending}
                    onClick={() =>
                      setState({
                        phase: 'confirm',
                        account,
                        useLegacyDisconnect: !fromAccountsApi,
                      })
                    }
                  >
                    {isPending ? 'Disconnecting…' : 'Disconnect'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {data.configured && (
          <Button
            variant="default"
            size="sm"
            disabled={blocked}
            aria-busy={connecting}
            onClick={() => void connectAccount()}
          >
            {connecting ? 'Connecting…' : 'Add another account'}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Check Google status"
          aria-busy={read.busy}
          onClick={() => {
            if (!read.busy) void check();
          }}
        >
          <RefreshIcon aria-hidden="true" />
        </Button>
      </div>
      <GoogleReadFeedback busy={read.busy} error={read.error} hasData title="Google integration" />
      {message && (
        <Alert variant={state.phase === 'uncertain' ? 'destructive' : 'default'}>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {state.phase === 'uncertain' && (
        <p role="status">No mutation will be retried automatically. Check Google status to recover.</p>
      )}
      {shareAccount && (
        <GoogleShareDialog
          workspaceId={workspaceId}
          account={shareAccount}
          onClose={() => setShareAccount(null)}
          onSaved={async () => {
            await changes.authority('google');
          }}
        />
      )}
      {configureAccount && (
        <GoogleConfigureDialog
          workspaceId={workspaceId}
          account={configureAccount}
          available={!read.busy && !read.error}
          onClose={() => setConfigureAccount(null)}
        />
      )}
      <AlertDialog
        open={state.phase === 'confirm'}
        onOpenChange={open => {
          if (!open) setState({ phase: 'idle' });
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Disconnect Google?</AlertDialogTitle>
          <AlertDialogDescription>
            Agents lose access to {confirmAccount?.email ?? 'this Google account'}.
            {confirmAccount?.ownership === 'personal' ? ' Gmail heartbeat stops.' : ''}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (state.phase === 'confirm') void disconnect(state.account, state.useLegacyDisconnect);
              }}
            >
              Disconnect Google
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function GoogleApprovals({ workspaceId }: { workspaceId: string }) {
  const read = useGoogleIntegration(workspaceId);
  const data = read.data;
  if (!data) return null;
  const available = !read.busy && !read.error;
  return (
    <div id="google-workspace" className="space-y-6">
      <GoogleProposals workspaceId={workspaceId} available={available} />
    </div>
  );
}
