import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { callbackSchema } from '@tulipfarm/github/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { githubApi, githubError } from '@/lib/github';
import { useIntegrationWorkspace, useIntegrationCallbackChanges } from '@/features/integrations/queries';
import { authClient } from '@/lib/auth';

type Outcome =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; login: string; workspaceId: string };
export function GitHubCallbackPage() {
  const session = authClient.useSession();
  if (session.isPending)
    return (
      <StatePanel kind="loading" title="Checking your session" description="Checking the account for GitHub consent." />
    );
  if (!session.data)
    return (
      <StatePanel
        kind="unavailable"
        title="Sign in to recover GitHub consent"
        description="Return to Integrations after signing in and start fresh consent."
      >
        <Button nativeButton={false} render={<Link to="/login" />}>
          Sign in to TulipFarm
        </Button>
      </StatePanel>
    );
  return <GitHubCallbackResult />;
}
function GitHubCallbackResult() {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'loading' });
  const navigation = useIntegrationWorkspace(outcome.kind === 'success' ? outcome.workspaceId : undefined);
  const changed = useIntegrationCallbackChanges();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const duplicated = [...params.keys()].some(key => params.getAll(key).length !== 1);
    const input = callbackSchema.safeParse(Object.fromEntries(params));
    window.history.replaceState(null, '', '/github/callback');
    if (duplicated || !input.success) {
      setOutcome({
        kind: 'error',
        message: 'Invalid or already used callback. Return to Integrations and start fresh consent.',
      });
      return;
    }
    void githubApi
      .complete(input.data)
      .then(async result => {
        await changed(result.workspaceId, 'github-personal').catch(() => {});
        setOutcome({
          kind: 'success',
          login: result.account.identity?.login ?? 'GitHub',
          workspaceId: result.workspaceId,
        });
      })
      .catch(error => setOutcome({ kind: 'error', message: githubError(error) }));
  }, [changed]);
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
      <StatePanel
        heading="h1"
        kind={outcome.kind === 'loading' ? 'loading' : outcome.kind === 'success' ? 'success' : 'error'}
        title={
          outcome.kind === 'loading'
            ? 'Connecting GitHub…'
            : outcome.kind === 'success'
              ? `Connected @${outcome.login}`
              : 'GitHub consent could not be confirmed'
        }
        description={
          outcome.kind === 'loading'
            ? 'Checking consent for your current session.'
            : outcome.kind === 'error'
              ? outcome.message
              : 'Your account is private to you. Return to Integrations to check its status.'
        }
      >
        {outcome.kind === 'success' && navigation.data && (
          <Button
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug/integrations"
                params={{ workspaceSlug: navigation.data.slug }}
                hash="github-accounts"
              />
            }
          >
            Return to GitHub accounts
          </Button>
        )}
        {navigation.error && (
          <Button variant="outline" onClick={() => void navigation.refresh()}>
            Retry workspace navigation
          </Button>
        )}
        {outcome.kind !== 'loading' && (
          <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
            Open my workspace
          </Button>
        )}
      </StatePanel>
    </main>
  );
}
