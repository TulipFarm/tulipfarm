import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Card, CardContent } from '@tulipfarm/sprout/card';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { githubApi, githubConsent, githubError } from '@/lib/github';
import { useGitHubAccounts, useIntegrationChanges } from './queries';
import { GitHubKnowledgeSources } from './github-knowledge';
import { githubMockEnabled } from './github-mock-api';

export function GitHubAccounts({
  workspaceId,
  onChanged,
  footerTarget = null,
}: {
  workspaceId: string;
  onChanged: () => void;
  footerTarget?: HTMLElement | null;
}) {
  const { state, refresh } = useGitHubAccounts(workspaceId);
  const changes = useIntegrationChanges();
  const pending = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
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
            ? 'Disconnected from TulipFarm. To revoke the OAuth grant at GitHub, open GitHub Settings, Applications, Authorized OAuth Apps. Revoking the grant can affect other workspaces using the same GitHub account.'
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
  const retry = (
    <Button
      variant="outline"
      disabled={state.kind === 'ready' && state.refreshing}
      onClick={() => {
        void refresh();
        onChanged();
      }}
    >
      Check GitHub accounts
    </Button>
  );
  return (
    <section aria-label="Personal GitHub accounts" className="space-y-5">
      <Card surface="raised">
        <CardContent>
          <div className="space-y-4">
            {state.kind === 'loading' && (
              <div role="status" className="space-y-2">
                <p>Loading GitHub accounts…</p>
                <Skeleton />
                <Skeleton />
              </div>
            )}
            {state.kind === 'error' && (
              <StatePanel kind="error" title="Could not load GitHub accounts" description={state.message}>
                {retry}
              </StatePanel>
            )}
            {state.kind === 'unavailable' && (
              <StatePanel
                kind="unavailable"
                title="GitHub account access unavailable"
                description="Your session or workspace access changed. Sign in again or return to a workspace you can access."
              >
                {retry}
              </StatePanel>
            )}
            {failure && (
              <Alert variant="destructive">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            )}
            {(failure || (state.kind === 'ready' && state.error)) && retry}
            {notice && (
              <Alert>
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}
            {state.kind === 'ready' && (
              <>
                {state.error && (
                  <Alert variant="destructive">
                    <AlertDescription>Account status may be stale. {githubError(state.error)}</AlertDescription>
                  </Alert>
                )}
                {!state.data.configured && (
                  <StatePanel
                    kind="unavailable"
                    title="GitHub OAuth is not configured"
                    description="Ask your operator to configure the GitHub OAuth App. Existing accounts can still be disconnected."
                  />
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="sr-only">GitHub accounts</h3>
                  {!visibleAccounts.length && (
                    <StatePanel
                      kind="empty"
                      title="No personal GitHub accounts"
                      description="Connect your GitHub login to use the personal and organization repositories you can access."
                    >
                      {state.data.configured && (
                        <Button
                          disabled={!!busy || !!state.error}
                          aria-busy={busy === 'new'}
                          onClick={() => void run('connect')}
                        >
                          {busy === 'new' ? 'Opening GitHub…' : 'Connect GitHub account'}
                        </Button>
                      )}
                    </StatePanel>
                  )}
                  {visibleAccounts.length > 0 && (
                    <ul aria-label="GitHub accounts" className="min-w-40 flex-1 divide-y divide-foreground/10">
                      {visibleAccounts.map(account => (
                        <li key={account.id} className="space-y-2 py-2 first:pt-0 last:pb-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <BrandIcon brand="github" size="sm" />
                            <p className="min-w-0 break-all text-sm font-medium text-foreground">
                              {account.identity ? `@${account.identity.login}` : 'Unfinished integration'}
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
                          {account.state !== 'active' && (
                            <div className="space-y-2">
                              <p className="text-sm text-muted-foreground">
                                {account.identity
                                  ? 'Reconnect with this same GitHub login to restore access.'
                                  : 'GitHub sign-in was not completed. Finish connecting or dismiss this attempt.'}
                              </p>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  variant="outline"
                                  disabled={!!busy || !state.data.configured || !!state.error}
                                  aria-busy={busy === account.id}
                                  onClick={() => void run('reconnect', account.id)}
                                >
                                  {account.identity ? `Reconnect @${account.identity.login}` : 'Finish connecting'}
                                </Button>
                                {!account.identity && (
                                  <Button
                                    variant="ghost"
                                    disabled={!!busy || !!state.error}
                                    onClick={() => void run('disconnect', account.id)}
                                  >
                                    Dismiss attempt
                                  </Button>
                                )}
                              </div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {visibleAccounts.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={managing}
                      aria-controls="github-account-management"
                      onClick={() => setManaging(value => !value)}
                    >
                      {managing ? 'Hide account settings' : 'Manage accounts'}
                    </Button>
                  )}
                </div>
                {managing && visibleAccounts.length > 0 && (
                  <section
                    id="github-account-management"
                    aria-label="Account settings"
                    className="space-y-4 rounded-lg bg-muted p-4"
                  >
                    <p className="text-sm text-muted-foreground">
                      Need a different login? Connect another account. Reconnecting keeps the same identity and asks for
                      fresh approval of future changes.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {state.data.configured && (
                        <Button
                          variant="outline"
                          disabled={!!busy || !!state.error}
                          aria-busy={busy === 'new'}
                          onClick={() => void run('connect')}
                        >
                          {busy === 'new' ? 'Opening GitHub…' : 'Connect another GitHub account'}
                        </Button>
                      )}
                      {!failure && !state.error && retry}
                    </div>
                    {state.data.accounts
                      .filter(account => account.identity)
                      .map(account => (
                        <div
                          key={account.id}
                          className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
                        >
                          <p className="min-w-0 break-all text-sm font-medium">@{account.identity?.login}</p>
                          <div className="flex flex-wrap gap-2">
                            {account.state === 'active' && (
                              <Button
                                variant="outline"
                                disabled={!!busy || !state.data.configured || !!state.error}
                                aria-busy={busy === account.id}
                                onClick={() => void run('reconnect', account.id)}
                              >
                                Reconnect @{account.identity?.login}
                              </Button>
                            )}
                            <Button
                              variant="destructive"
                              disabled={!!busy || account.state === 'disconnected' || !!state.error}
                              onClick={() => void run('disconnect', account.id)}
                            >
                              Disconnect @{account.identity?.login}
                            </Button>
                          </div>
                        </div>
                      ))}
                    <p className="text-xs text-muted-foreground">
                      Disconnecting stops new TulipFarm calls. Your GitHub repositories are not changed.
                    </p>
                  </section>
                )}
              </>
            )}
            {githubMockEnabled && (
              <p className="text-xs text-muted-foreground">Local demo · Mock GitHub data · No real GitHub changes</p>
            )}
          </div>
        </CardContent>
      </Card>
      {state.kind === 'ready' && state.data.configured && (
        <GitHubKnowledgeSources
          workspaceId={workspaceId}
          onReconnect={id => void run('reconnect', id)}
          accountBusy={!!busy}
          footerTarget={footerTarget}
        />
      )}
    </section>
  );
}
