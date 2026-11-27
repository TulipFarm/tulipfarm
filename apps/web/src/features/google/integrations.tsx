import { useRef, useState } from 'react';
import { RefreshIcon } from '@tulipfarm/icons';
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
import { googleApi, googleError, type GoogleAccountSummary } from '@/lib/google-workspace';
import { GoogleReadFeedback } from './read';
import { useGoogleIntegration, useIntegrationChanges } from '@/features/integrations/queries';
import { GoogleProposals } from './proposals';
import { GoogleHeartbeat } from './heartbeat';

type Disconnect =
  | { phase: 'idle' }
  | { phase: 'confirm'; account: GoogleAccountSummary; useLegacyDisconnect: boolean }
  | { phase: 'pending'; integrationId: string }
  | { phase: 'uncertain' };

type Connecting = 'personal' | 'shared' | null;

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

export function GoogleAccount({ workspaceId }: { workspaceId: string }) {
  const read = useGoogleIntegration(workspaceId);
  const changes = useIntegrationChanges();
  const [state, setState] = useState<Disconnect>({ phase: 'idle' });
  const [connecting, setConnecting] = useState<Connecting>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const data = read.data;
  const blocked =
    read.busy || !!read.error || state.phase === 'pending' || state.phase === 'uncertain' || connecting !== null;

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

  async function connectAccount(ownership: 'personal' | 'shared') {
    if (lock.current) return;
    lock.current = true;
    setMessage(null);
    setConnecting(ownership);
    try {
      const { authorizationUrl } = await googleApi.begin(workspaceId, undefined, { ownership, newAccount: true });
      const url = new URL(authorizationUrl);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth')
        throw new Error('Unexpected consent destination');
      window.location.assign(url.href);
    } catch (error) {
      setMessage(googleError(error));
      setConnecting(null);
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

  const { list: accounts, fromAccountsApi } = visibleAccounts(data);

  if (accounts.length === 0)
    return (
      <section aria-label="Google accounts" className="space-y-3">
        {data.configured && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={blocked}
              aria-busy={connecting === 'shared'}
              onClick={() => void connectAccount('shared')}
            >
              {connecting === 'shared' ? 'Connecting…' : 'Connect shared Google account'}
            </Button>
          </div>
        )}
        {message && (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
      </section>
    );

  const confirmAccount = state.phase === 'confirm' ? state.account : null;

  return (
    <section aria-label="Google account" className="space-y-3">
      <div className="space-y-2">
        {accounts.map((account, index) => {
          const isPending = state.phase === 'pending' && state.integrationId === account.integrationId;
          return (
            <div
              key={account.integrationId}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate font-medium">{account.email ?? 'Google account'}</p>
                  <Badge variant={account.ownership === 'shared' ? 'secondary' : 'outline'}>
                    {account.ownership === 'shared' ? 'Shared' : 'Personal'}
                  </Badge>
                  {account.status === 'reconnect-required' && <Badge variant="warning">Reconnect required</Badge>}
                </div>
                {account.label && <p className="truncate text-xs text-muted-foreground">{account.label}</p>}
              </div>
              <div className="flex items-center gap-2">
                {index === 0 && (
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
                )}
                {account.canManage && (
                  <Button
                    variant="outline"
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
            </div>
          );
        })}
      </div>
      {data.configured && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={blocked}
            aria-busy={connecting === 'personal'}
            onClick={() => void connectAccount('personal')}
          >
            {connecting === 'personal' ? 'Connecting…' : 'Connect another personal account'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={blocked}
            aria-busy={connecting === 'shared'}
            onClick={() => void connectAccount('shared')}
          >
            {connecting === 'shared' ? 'Connecting…' : 'Connect shared workspace account'}
          </Button>
        </div>
      )}
      <GoogleReadFeedback busy={read.busy} error={read.error} hasData title="Google integration" />
      {message && (
        <Alert variant={state.phase === 'uncertain' ? 'destructive' : 'default'}>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {state.phase === 'uncertain' && (
        <p role="status">No mutation will be retried automatically. Check Google status to recover.</p>
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
  const binding =
    data.status.status === 'connected'
      ? `${data.status.integrationId}:${data.status.accountId}:${data.status.generation}`
      : null;
  return (
    <div id="google-workspace" className="space-y-6">
      {binding && <GoogleHeartbeat key={binding} workspaceId={workspaceId} available={available} />}
      <GoogleProposals workspaceId={workspaceId} available={available} />
    </div>
  );
}
