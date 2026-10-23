import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { platformNames } from '@/features/social/presentation';
import { useIntegrationWorkspace } from '@/features/integrations/queries';
import { authClient } from '@/lib/auth';
import { setFlagWorkspace, useKnownFlag } from '@/lib/feature-flags';
import { socialCallbackRoute } from '@/router';

export function SocialCallbackPage() {
  const session = authClient.useSession();
  const result = socialCallbackRoute.useSearch();
  if (session.isPending)
    return (
      <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
        <StatePanel kind="loading" title="Checking your session" description="Loading the sign-in result." />
      </main>
    );
  if (!session.data || result.outcome === 'sign-in-required')
    return (
      <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
        <StatePanel
          heading="h1"
          kind="unavailable"
          title="Sign in to finish connecting"
          description="Sign in to TulipFarm, then connect the account again."
        >
          <Button nativeButton={false} render={<Link to="/login" />}>
            Sign in to TulipFarm
          </Button>
        </StatePanel>
      </main>
    );
  // Without a workspace there is no flag to check, so the failure names no feature.
  if (!result.workspaceId)
    return (
      <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
        <StatePanel
          heading="h1"
          kind="error"
          title="Could not connect the account"
          description="Nothing was connected. Start again from your workspace."
        >
          <Button role="link" nativeButton={false} render={<Link to="/" />}>
            Open my workspace
          </Button>
        </StatePanel>
      </main>
    );
  return <SocialCallbackResult workspaceId={result.workspaceId} />;
}

function SocialCallbackResult({ workspaceId }: { workspaceId: string }) {
  const result = socialCallbackRoute.useSearch();
  const navigation = useIntegrationWorkspace(workspaceId);
  const slug = navigation.data?.slug;
  useEffect(() => {
    if (slug) setFlagWorkspace(slug);
  }, [slug]);
  const enabled = useKnownFlag('social-publishing', slug ?? '');
  if (navigation.error)
    return (
      <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
        <StatePanel heading="h1" kind="error" title="Could not find your workspace" description="Try again.">
          <Button variant="outline" disabled={navigation.busy} onClick={() => void navigation.refresh()}>
            Try again
          </Button>
        </StatePanel>
      </main>
    );
  if (navigation.data === null) return <CallbackNotFound />;
  if (!slug || enabled === undefined)
    return (
      <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
        <StatePanel kind="loading" title="Finding your workspace" description="Loading the sign-in result." />
      </main>
    );
  if (!enabled) return <CallbackNotFound />;
  const platform = result.platform ? platformNames[result.platform] : 'Social';
  const copy = {
    connected: {
      title: `${platform} account connected`,
      description: 'Add its channels and grants, then publish from chat.',
    },
    denied: {
      title: 'Sign-in was cancelled',
      description: 'Nothing was connected. Connect again when you are ready.',
    },
    'reconnect-required': {
      title: 'Some permissions were not granted',
      description: 'Connect again and allow every permission TulipFarm asks for.',
    },
    expired: {
      title: 'This sign-in link expired',
      description: 'It expired or was already used. Start connecting again.',
    },
    error: {
      title: 'Could not connect the account',
      description: 'Nothing was connected. Start connecting again.',
    },
  }[result.outcome === 'sign-in-required' ? 'error' : result.outcome];
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
      <StatePanel
        heading="h1"
        kind={result.outcome === 'connected' ? 'success' : 'error'}
        title={copy.title}
        description={copy.description}
      >
        <Button
          role="link"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/social/schedule" params={{ workspaceSlug: slug }} />}
        >
          Open the social schedule
        </Button>
      </StatePanel>
    </main>
  );
}

function CallbackNotFound() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
      <StatePanel
        heading="h1"
        kind="unavailable"
        title="Page not found"
        description="Check the URL or return to a workspace you can access."
      >
        <Button nativeButton={false} render={<Link to="/" />}>
          Back to TulipFarm
        </Button>
      </StatePanel>
    </main>
  );
}
