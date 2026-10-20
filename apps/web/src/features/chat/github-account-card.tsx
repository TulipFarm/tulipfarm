import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { githubApi } from '@/lib/github';
import { useGitHubAccounts, useGitHubSelection, useIntegrationChanges } from '@/features/integrations/queries';
import { useFeatureContext } from '@/lib/query/provider';

export function GitHubAccountCard({
  workspaceId,
  chatId,
  slug,
  disabled,
  picked,
  task = false,
}: {
  workspaceId: string;
  chatId: string;
  slug: string;
  disabled: boolean;
  picked: (login: string) => void;
  task?: boolean;
}) {
  const accountsRead = useGitHubAccounts(workspaceId);
  const selectionRead = useGitHubSelection(workspaceId, chatId, task);
  const changes = useIntegrationChanges();
  const { runtime, scope, current } = useFeatureContext();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = () => Promise.all([accountsRead.refresh(), selectionRead.refresh()]);
  const accountsState = accountsRead.state;
  const selectionState = selectionRead.state;
  const stale =
    (accountsState.kind === 'ready' && !!accountsState.error) ||
    (selectionState.kind === 'ready' && !!selectionState.error);
  async function select(accountId: string, login: string) {
    if (busy.current || accountsState.kind !== 'ready' || selectionState.kind !== 'ready' || stale || disabled) return;
    const admitted = runtime.fence(scope, current);
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await (task ? githubApi.selectTask : githubApi.select)(
        workspaceId,
        chatId,
        accountId,
        selectionState.data.version,
      );
      const notify = mounted.current && admitted();
      await changes.selection(chatId, task);
      if (notify && admitted()) picked(login);
    } catch {
      if (mounted.current && admitted()) {
        setError(
          task
            ? 'The account selection is unconfirmed. Pause task work and check accounts before trying again.'
            : 'The account could not be confirmed. Finish or cancel any pending reply, then try again.',
        );
        await load();
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  if (accountsState.kind === 'unavailable' || selectionState.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        title="GitHub account access unavailable"
        description="Your session or account access changed."
      >
        <Button variant="outline" onClick={() => void load()}>
          Retry loading accounts
        </Button>
      </StatePanel>
    );
  if (accountsState.kind === 'error' || selectionState.kind === 'error')
    return (
      <StatePanel kind="error" title="Could not load GitHub accounts" description="The account list is unknown.">
        <Button variant="outline" onClick={() => void load()}>
          Retry loading accounts
        </Button>
      </StatePanel>
    );
  if (accountsState.kind !== 'ready' || selectionState.kind !== 'ready')
    return (
      <div role="status" aria-label="Loading GitHub accounts">
        <Skeleton />
        <span className="sr-only">Loading GitHub accounts…</span>
      </div>
    );
  const accounts = accountsState.data;
  const selection = selectionState.data;
  const usable = accounts.accounts.filter(account => account.state === 'active' && account.identity);
  const hidden = accounts.accounts.length - usable.length;
  return (
    <section aria-label="Choose a GitHub account" className="space-y-3 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Choose a GitHub account</h3>
        <p className="text-sm text-muted-foreground">
          {task
            ? 'Delegate this personal account only to this task. The saved agent receives no account credentials. Select an account while the task is paused or asking for your answer, then continue.'
            : 'TulipFarm uses this account for GitHub in this chat. Changing to another account starts fresh context.'}
        </p>
      </div>
      {stale && (
        <div className="space-y-2">
          <p role="alert">GitHub accounts could not be refreshed.</p>
          <Button variant="outline" onClick={() => void load()}>
            Check accounts again
          </Button>
        </div>
      )}
      {!accounts.configured ? (
        <p className="text-sm">Personal GitHub is not configured on this server.</p>
      ) : usable.length === 0 ? (
        <p className="text-sm">
          {hidden
            ? 'No connected GitHub account is ready. Reconnect or connect an account in Integrations.'
            : 'No personal GitHub accounts connected.'}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="GitHub accounts">
          {usable.map(account => (
            <li key={account.id}>
              <Button
                variant={account.id === selection.accountId ? 'secondary' : 'outline'}
                disabled={
                  saving ||
                  disabled ||
                  stale ||
                  (account.id === selection.accountId && account.generation === selection.generation)
                }
                aria-pressed={account.id === selection.accountId}
                onClick={() => {
                  if (account.identity) void select(account.id, account.identity.login);
                }}
              >
                {account.identity?.login}
                {account.id === selection.accountId && account.generation === selection.generation ? ' · Selected' : ''}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {accounts.configured && usable.length > 0 && hidden > 0 && (
        <p className="text-sm text-muted-foreground">
          {hidden === 1 ? '1 account needs attention' : `${hidden} accounts need attention`} in Integrations.
        </p>
      )}
      {disabled && (
        <p role="status" className="text-sm text-muted-foreground">
          {task
            ? 'Account selection is locked while task work is active.'
            : 'Finish or cancel the pending reply before choosing an account.'}
        </p>
      )}
      {saving && (
        <p role="status" className="text-sm text-muted-foreground">
          Saving GitHub account…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        variant="link"
        nativeButton={false}
        render={
          <Link
            to="/$workspaceSlug/integrations"
            params={{ workspaceSlug: slug }}
            search={task ? {} : { returnChat: chatId }}
            hash="github-accounts"
            target="_blank"
            rel="noopener noreferrer"
          />
        }
      >
        Manage GitHub integrations
      </Button>
    </section>
  );
}
