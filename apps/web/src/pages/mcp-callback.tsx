import { useEffect, useState } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { mcpCallbackRoute } from '@/router';
import { useIntegrationWorkspace } from '@/features/integrations/queries';
import { markMcpConnected, takeMcpSignInReturn } from '@/features/workspace-mcp/sign-in';

const failures = {
  'sign-in-required': ['Sign in to TulipFarm to finish connecting', 'Then try connecting again.'],
  denied: ['Connection cancelled', 'Nothing was connected. You can try again whenever you like.'],
  expired: ['That sign-in link expired', 'Try connecting again from the same page.'],
  failed: ['Could not finish connecting', 'Try connecting again in a moment.'],
} as const;

/** Where an MCP provider's sign-in lands. It goes straight back to the page that started sign-in. */
export function McpCallbackPage() {
  const result = mcpCallbackRoute.useSearch();
  const router = useRouter();
  const [back] = useState(takeMcpSignInReturn);
  const read = useIntegrationWorkspace(back ? undefined : result.workspaceId);
  const slug = read.data?.slug;
  const connected = result.outcome === 'connected';
  useEffect(() => {
    if (!connected) return;
    if (result.integrationId) markMcpConnected(result.integrationId);
    const to = back ?? (slug ? `/${slug}/integrations` : read.busy ? null : '/');
    if (to) router.history.replace(to);
  }, [connected, back, slug, read.busy, result.integrationId, router]);
  if (result.outcome === 'connected')
    return <StatePanel kind="loading" title="Connected" description="Taking you back…" />;
  const [title, description] = failures[result.outcome];
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
      <StatePanel heading="h1" kind="unavailable" title={title} description={description}>
        {result.outcome === 'sign-in-required' ? (
          <Button role="link" nativeButton={false} render={<Link to="/login" />}>
            Sign in
          </Button>
        ) : back ? (
          <Button onClick={() => router.history.replace(back)}>Go back</Button>
        ) : (
          <Button role="link" nativeButton={false} render={<Link to="/" />}>
            Open TulipFarm
          </Button>
        )}
      </StatePanel>
    </main>
  );
}
