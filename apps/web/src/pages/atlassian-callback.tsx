import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { atlassianCallbackRoute } from '@/router';
import { useIntegrationWorkspace, useIntegrationCallbackChanges } from '@/features/integrations/queries';
import { authClient } from '@/lib/auth';

export function AtlassianCallbackPage() {
  const session = authClient.useSession();
  if (session.isPending)
    return (
      <StatePanel
        kind="loading"
        title="Checking your session"
        description="Loading your Atlassian integration result."
      />
    );
  if (!session.data)
    return (
      <StatePanel
        kind="unavailable"
        title="Sign in to check your integration"
        description="Sign in to TulipFarm, then return to Integrations."
      >
        <Button nativeButton={false} render={<Link to="/login" />}>
          Sign in to TulipFarm
        </Button>
      </StatePanel>
    );
  return <AtlassianCallbackResult />;
}

function AtlassianCallbackResult() {
  const result = atlassianCallbackRoute.useSearch();
  const navigation = useIntegrationWorkspace(result.workspaceId);
  const changed = useIntegrationCallbackChanges();
  useEffect(() => {
    if (result.workspaceId && result.outcome === 'connected')
      void changed(result.workspaceId, 'atlassian').catch(() => {});
  }, [changed, result.workspaceId, result.outcome]);
  const connected = result.outcome === 'connected' && !!result.workspaceId;
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
      <StatePanel
        heading="h1"
        kind={connected ? 'success' : 'error'}
        title={
          connected
            ? 'Atlassian account connected'
            : result.outcome === 'denied'
              ? 'Atlassian sign-in was cancelled'
              : 'Could not confirm your integration'
        }
        description={
          connected
            ? 'Return to Integrations to choose a site or board and check which tools are available.'
            : 'Return to Integrations and reconnect the unfinished account to try signing in again.'
        }
      >
        {navigation.data && (
          <Button
            role="link"
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug/integrations"
                params={{ workspaceSlug: navigation.data.slug }}
                hash={result.protocol === 'trello' ? 'trello-accounts' : 'atlassian-heading'}
              />
            }
          >
            Return to Integrations
          </Button>
        )}
        {!result.workspaceId && (
          <Button role="link" nativeButton={false} render={<Link to="/" />}>
            Open my workspace
          </Button>
        )}
        {result.workspaceId && navigation.busy && <p role="status">Finding your workspace…</p>}
        {navigation.error && (
          <Button variant="outline" disabled={navigation.busy} onClick={() => void navigation.refresh()}>
            Retry workspace navigation
          </Button>
        )}
      </StatePanel>
    </main>
  );
}
