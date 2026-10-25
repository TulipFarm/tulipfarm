import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { githubApi, githubConsent, githubError } from '@/lib/github';
import { useGitHubAccounts, useIntegrationChanges } from './queries';
import { GitHubKnowledgeSources } from './github-knowledge';
import { githubMockEnabled } from './github-mock-api';

export function GitHubAccounts({ workspaceId, onChanged }: { workspaceId: string; onChanged: () => void }) {
  const { state, refresh } = useGitHubAccounts(workspaceId);
  const changes = useIntegrationChanges();
  const pending = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const visibleAccounts =
    state.kind === 'ready'
      ? state.data.accounts.filter(account => account.identity || account.state !== 'disconnected')
      : [];
  const run = async (action: 'connect' | 'reconnect' | 'disconnect', id?: string) => {
    if (pending.current) return;
    if (githubMockEnabled && action !== 'disconnect') {
      setNotice(
        'GitHub sign-in is disabled in this local demo. Use the multiple-account demo to try switching logins.',
      );
      return;
    }
    pending.current = true;
    setBusy(id ?? 'new');
    setFailure(null);
    setNotice(null);
    try {
      if (action === 'disconnect' && id) {
        await githubApi.disconnect(workspaceId, id);
        await changes.authority('github-personal');
        setNotice(
          visibleAccounts.find(account => account.id === id)?.identity
            ? 'Disconnected from TulipFarm. To revoke the grant at GitHub, open GitHub Settings, Applications, Authorized GitHub Apps. Revoking the grant can affect other workspaces using the same GitHub account.'
            : 'Unfinished integration dismissed.',
        );
      } else {
        const result = id ? await githubApi.reconnect(workspaceId, id) : await githubApi.begin(workspaceId);
        await changes.authority('github-personal');
        githubConsent(result.url);
      }
    } catch (error) {
      setFailure(githubError(error));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  const checking = state.kind === 'ready' && state.refreshing;
  const check = (variant: 'outline' | 'ghost') => (
    <Button
      variant={variant}
      disabled={checking}
      aria-busy={checking}
      onClick={() => {
        void refresh();
        onChanged();
      }}
    >
      {checking ? 'Checking…' : 'Check again'}
    </Button>
  );
  const ready = state.kind === 'ready' ? state : null;
  const locked = !!busy || !!ready?.error;
  return (
    <section aria-labelledby="github-accounts-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="github-accounts-title" className="text-base font-semibold text-foreground">
            GitHub logins
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Agents act with the access of these logins. Connect another login to reach repositories it can see.
          </p>
        </div>
        {ready && visibleAccounts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {!failure && !ready.error && check('ghost')}
            {ready.data.configured && (
              <Button
                variant="outline"
                disabled={locked}
                aria-busy={busy === 'new'}
                onClick={() => void run('connect')}
              >
                {busy === 'new' ? 'Opening GitHub…' : 'Connect another login'}
              </Button>
            )}
          </div>
        )}
      </div>
      {state.kind === 'loading' && (
        <div role="status" className="space-y-2 rounded-lg border p-4">
          <p className="sr-only">Loading GitHub accounts…</p>
          <Skeleton />
          <Skeleton />
        </div>
      )}
      {state.kind === 'error' && (
        <StatePanel kind="error" title="Could not load GitHub accounts" description={state.message}>
          {check('outline')}
        </StatePanel>
      )}
      {state.kind === 'unavailable' && (
        <StatePanel
          kind="unavailable"
          title="GitHub account access unavailable"
          description="Your session or workspace access changed. Sign in again or return to a workspace you can access."
        >
          {check('outline')}
        </StatePanel>
      )}
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {ready?.error && (
        <Alert variant="destructive">
          <AlertDescription>Account status may be stale. {githubError(ready.error)}</AlertDescription>
        </Alert>
      )}
      {(failure || ready?.error) && check('outline')}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {ready && !ready.data.configured && (
        <StatePanel
          kind="unavailable"
          title="GitHub is not configured"
          description="Ask your operator to configure the GitHub App. Existing accounts can still be disconnected."
        />
      )}
      {ready && !visibleAccounts.length && (
        <StatePanel
          kind="empty"
          title="No personal GitHub accounts"
          description="Connect your GitHub login to use the personal and organization repositories you can access."
        >
          {ready.data.configured && (
            <Button disabled={locked} aria-busy={busy === 'new'} onClick={() => void run('connect')}>
              {busy === 'new' ? 'Opening GitHub…' : 'Connect GitHub account'}
            </Button>
          )}
        </StatePanel>
      )}
      {ready && visibleAccounts.length > 0 && (
        <ul aria-label="GitHub accounts" className="divide-y rounded-lg border">
          {visibleAccounts.map(account => {
            const login = account.identity ? `@${account.identity.login}` : null;
            return (
              <li key={account.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <BrandIcon brand="github" size="sm" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 break-all text-sm font-medium text-foreground">
                      {login ?? 'Unfinished integration'}
                    </p>
                    <Badge
                      variant={
                        account.state === 'active'
                          ? 'success'
                          : account.state === 'disconnected'
                            ? 'secondary'
                            : 'warning'
                      }
                    >
                      {account.state === 'active'
                        ? 'Connected'
                        : !account.identity
                          ? 'Not connected'
                          : account.state === 'authorizing'
                            ? 'Waiting for GitHub'
                            : account.state === 'disconnected'
                              ? 'Disconnected'
                              : 'Reconnect required'}
                    </Badge>
                  </div>
                  {account.state !== 'active' && account.state !== 'disconnected' && (
                    <p className="text-sm text-muted-foreground">
                      {account.identity
                        ? 'Reconnect with this same GitHub login to restore access.'
                        : 'GitHub sign-in was not completed. Finish connecting or dismiss this attempt.'}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {account.state !== 'disconnected' && (
                    <Button
                      variant={account.state === 'active' ? 'ghost' : 'outline'}
                      size="sm"
                      disabled={locked || !ready.data.configured}
                      aria-busy={busy === account.id}
                      aria-label={login ? `Reconnect ${login}` : undefined}
                      onClick={() => void run('reconnect', account.id)}
                    >
                      {login ? 'Reconnect' : 'Finish connecting'}
                    </Button>
                  )}
                  {(account.identity ? account.state !== 'disconnected' : true) && (
                    <Button
                      variant="ghost-destructive"
                      size="sm"
                      disabled={locked}
                      aria-label={login ? `Disconnect ${login}` : undefined}
                      onClick={() => void run('disconnect', account.id)}
                    >
                      {login ? 'Disconnect' : 'Dismiss attempt'}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {ready && visibleAccounts.some(account => account.identity) && (
        <p className="text-xs text-muted-foreground">
          Reconnecting keeps the same login and asks GitHub for fresh approval. Disconnecting stops new TulipFarm calls;
          your repositories are not changed.
        </p>
      )}
      {githubMockEnabled && (
        <p className="text-xs text-muted-foreground">Local demo · Mock GitHub data · No real GitHub changes</p>
      )}
    </section>
  );
}

/** Repositories in Knowledge, with reconnect for a login whose access expired. */
export function GitHubKnowledge({ workspaceId }: { workspaceId: string }) {
  const { state } = useGitHubAccounts(workspaceId);
  const changes = useIntegrationChanges();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (state.kind !== 'ready' || !state.data.configured) return null;
  const reconnect = async (id: string) => {
    if (pending.current || githubMockEnabled) return;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await githubApi.reconnect(workspaceId, id);
      await changes.authority('github-personal');
      githubConsent(result.url);
    } catch (error) {
      setFailure(githubError(error));
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <GitHubKnowledgeSources
        workspaceId={workspaceId}
        onReconnect={id => void reconnect(id)}
        accountBusy={busy}
        footerTarget={null}
      />
    </div>
  );
}
