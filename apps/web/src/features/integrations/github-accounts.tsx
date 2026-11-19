import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { RadioGroup, RadioGroupItem } from '@tulipfarm/sprout/radio-group';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { githubApi, githubConsent, githubError } from '@/lib/github';
import { useGitHubAccounts, useIntegrationChanges } from './queries';
import { GitHubKnowledgeSources } from './github-knowledge';
import { githubMockEnabled } from './github-mock-api';
import { GitHubBotGrants } from './github-bot-grants';
import { accountConnectionState } from './connection-state';
import { cn } from 'cn';
import { AccountColumnHeads, UseSwitch, accountColumns } from '@/features/models/plan-accounts';

export function GitHubAccounts({
  workspaceId,
  workspaceSlug,
  onChanged,
}: {
  workspaceId: string;
  workspaceSlug: string;
  onChanged: () => void;
}) {
  const { state, refresh } = useGitHubAccounts(workspaceId);
  const changes = useIntegrationChanges();
  const pending = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [turning, setTurning] = useState<Record<string, boolean>>({});
  const turn = async (id: string, uses: { chat?: boolean; coding?: boolean; primaryForKnowledge?: true }) => {
    const [use, on] = Object.entries(uses)[0] ?? [];
    if (!use) return;
    const key = `${id}:${use}`;
    setTurning(current => ({ ...current, [key]: on === true }));
    setFailure(null);
    try {
      await githubApi.setUses(workspaceId, id, uses);
      await changes.authority('github-personal');
    } catch (error) {
      setFailure(githubError(error));
    } finally {
      setTurning(({ [key]: _done, ...rest }) => rest);
    }
  };
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
  const turningPrimary = Object.keys(turning)
    .find(key => key.endsWith(':primaryForKnowledge'))
    ?.split(':')[0];
  return (
    <section aria-labelledby="github-accounts-title" className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="github-accounts-title" className="text-base font-semibold text-foreground">
            Accounts
          </h2>
          {ready && visibleAccounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {ready.data.configured && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked}
                  aria-busy={busy === 'new'}
                  onClick={() => void run('connect')}
                >
                  {busy === 'new' ? 'Opening GitHub…' : 'Add another account'}
                </Button>
              )}
            </div>
          )}
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          Agents work with the access of these GitHub logins. Turn on Chat or Coding for each login, and pick one login
          for Knowledge imports.
        </p>
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
        <div className="space-y-2">
          <AccountColumnHeads uses={['Chat', 'Coding', 'Knowledge']} layout="github" />
          <RadioGroup
            aria-label="Login for Knowledge imports"
            value={turningPrimary ?? visibleAccounts.find(account => account.primaryForKnowledge)?.id ?? ''}
            disabled={locked || turningPrimary !== undefined}
            onValueChange={value => {
              if (typeof value === 'string' && value) void turn(value, { primaryForKnowledge: true });
            }}
          >
            <ul aria-label="GitHub accounts" className="divide-y rounded-lg border">
              {visibleAccounts.map(account => {
                const login = account.identity ? `@${account.identity.login}` : null;
                const usable = !!login && account.state !== 'disconnected';
                return (
                  <li
                    key={account.id}
                    className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3', accountColumns('github'))}
                  >
                    <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-auto">
                      <BrandIcon brand="github" size="sm" />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="min-w-0 break-all text-sm font-medium text-foreground">
                            {login ?? 'Unfinished integration'}
                          </p>
                          <Badge
                            variant={
                              accountConnectionState(account) === 'connected'
                                ? 'success'
                                : accountConnectionState(account) === 'attention'
                                  ? 'warning'
                                  : 'secondary'
                            }
                          >
                            {account.state === 'active'
                              ? 'Connected'
                              : !account.identity
                                ? 'Not connected'
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
                    </div>
                    {usable ? (
                      <>
                        {(['chat', 'coding'] as const).map(use => {
                          const pendingUse = turning[`${account.id}:${use}`];
                          return (
                            <UseSwitch
                              key={use}
                              use={use === 'chat' ? 'Chat' : 'Coding'}
                              account={login}
                              checked={pendingUse ?? (use === 'chat' ? account.useForChat : account.useForCoding)}
                              disabled={locked || pendingUse !== undefined}
                              busy={pendingUse !== undefined}
                              onChange={on => void turn(account.id, { [use]: on })}
                            />
                          );
                        })}
                        <span className="flex items-center gap-2 sm:justify-center">
                          <RadioGroupItem value={account.id} aria-label={`Use ${login} for Knowledge imports`} />
                          <span aria-hidden="true" className="text-sm text-muted-foreground sm:hidden">
                            Knowledge
                          </span>
                        </span>
                      </>
                    ) : (
                      <span className="hidden sm:col-span-3 sm:block" />
                    )}
                    <div className="ml-auto flex flex-wrap justify-end gap-1">
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
          </RadioGroup>
        </div>
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
      <GitHubBotGrants workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
    </section>
  );
}

/** The GitHub sign-in someone started but never finished, while no login is connected yet. */
export function useUnfinishedGitHubSignIn(workspaceId: string, enabled: boolean) {
  const { state } = useGitHubAccounts(workspaceId, enabled);
  if (!enabled || state.kind !== 'ready') return null;
  return state.data.accounts.find(account => !account.identity && account.state !== 'disconnected') ?? null;
}

export function UnfinishedGitHubSignIn({
  workspaceId,
  accountId,
  disabled,
}: {
  workspaceId: string;
  accountId: string;
  disabled: boolean;
}) {
  const changes = useIntegrationChanges();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dismiss = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await githubApi.disconnect(workspaceId, accountId);
      await changes.authority('github-personal');
    } catch (error) {
      setFailure(githubError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <span>Sign-in not finished.</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || busy}
        aria-busy={busy}
        aria-label="Dismiss unfinished GitHub sign-in"
        onClick={() => void dismiss()}
      >
        {busy ? 'Dismissing…' : 'Dismiss'}
      </Button>
      {failure && (
        <span role="alert" className="basis-full text-destructive">
          {failure}
        </span>
      )}
    </div>
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
