import { useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { GoogleCallbackResult } from '@tulipfarm/google-workspace/public-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { googleCallbackRoute } from '@/router';
import { GoogleReadFeedback } from '@/features/google/read';
import { useIntegrationWorkspace, useIntegrationCallbackChanges } from '@/features/integrations/queries';
import { authClient } from '@/lib/auth';

const outcomes = {
  connected: [
    'Google connected',
    'Return to Integrations to check the current account, review actions, or configure Gmail heartbeat.',
  ],
  'sign-in-required': [
    'Sign in to recover Google consent',
    'Sign in to TulipFarm, return to Integrations, and start a new consent attempt.',
  ],
  'invalid-request': [
    'Google callback was invalid',
    'Return to Integrations and start a new consent attempt. Do not reuse this callback.',
  ],
  'invalid-state': [
    'Google consent link expired or was already used',
    'Return to Integrations and start a new consent attempt in the same signed-in session.',
  ],
  'consent-denied': [
    'Google consent was not granted',
    'If you cancelled consent, you can try again. Return to Integrations to check status and start a new attempt. Signing in with Google is separate.',
  ],
  'not-configured': [
    'Google is not configured',
    'Ask your operator to configure Google Workspace OAuth. Then return to Integrations and check status.',
  ],
  'reconnect-required': [
    'Google needs reconnecting',
    'Return to Integrations and reconnect Google. Then save heartbeat settings for the current account.',
  ],
  'insufficient-scope': [
    'Required Google permissions were not granted',
    'Return to Integrations and reconnect with all requested permissions.',
  ],
  'stale-integration': [
    'The Google integration changed',
    'Another consent attempt or account change superseded this one. Check status in Integrations.',
  ],
  'provider-unavailable': [
    'Google could not complete consent',
    'Check status in Integrations. Start a new consent attempt if the account is not connected.',
  ],
  'credential-unavailable': [
    'Google credentials could not be saved',
    'Ask your operator to check integration encryption configuration, then start a new consent attempt.',
  ],
  'integration-not-found': [
    'This integration is unavailable',
    'Your workspace membership may have changed. Return to a workspace you can access.',
  ],
  'integrations-unavailable': [
    'Google integration storage is unavailable',
    'Return to Integrations and check status after the service recovers.',
  ],
  'integration-operation-failed': [
    'Google consent could not be confirmed',
    'Check status in Integrations before starting a new consent attempt.',
  ],
} satisfies Record<GoogleCallbackResult['outcome'], [string, string]>;

export function GoogleCallbackPage() {
  const session = authClient.useSession();
  const result = googleCallbackRoute.useSearch();
  if (session.isPending)
    return (
      <StatePanel kind="loading" title="Checking your session" description="Your Google consent result is saved." />
    );
  if (!session.data)
    return (
      <StatePanel kind="unavailable" title={outcomes[result.outcome][0]} description={outcomes[result.outcome][1]}>
        <Button nativeButton={false} render={<Link to="/login" />}>
          Sign in to TulipFarm
        </Button>
      </StatePanel>
    );
  return <GoogleCallbackResult />;
}
function GoogleCallbackResult() {
  const result = googleCallbackRoute.useSearch();
  const read = useIntegrationWorkspace(result.workspaceId);
  const changed = useIntegrationCallbackChanges();
  useEffect(() => {
    if (result.workspaceId && result.outcome === 'connected')
      void changed(result.workspaceId, 'google').catch(() => {});
  }, [changed, result.workspaceId, result.outcome]);
  const [title, description] = outcomes[result.outcome];
  const navigate = useNavigate();
  const slug = read.data?.slug;
  useEffect(() => {
    if (slug && result.outcome === 'connected')
      void navigate({
        to: '/$workspaceSlug/integrations',
        params: { workspaceSlug: slug },
        hash: 'gmail',
        replace: true,
      });
  }, [slug, result.outcome, navigate]);
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">
      <StatePanel
        heading="h1"
        kind={result.outcome === 'connected' ? 'success' : 'unavailable'}
        title={title}
        description={description}
      >
        {read.data && (
          <Button
            role="link"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: read.data.slug }} hash="gmail" />}
          >
            Return to Integrations
          </Button>
        )}
        {result.outcome === 'sign-in-required' ? (
          <Button role="link" nativeButton={false} render={<Link to="/login" />}>
            Sign in to TulipFarm
          </Button>
        ) : (
          <Button role="link" variant="outline" nativeButton={false} render={<Link to="/" />}>
            Open my workspace
          </Button>
        )}
      </StatePanel>
      {result.workspaceId && (
        <>
          <GoogleReadFeedback busy={read.busy} error={read.error} hasData={!!read.data} title="workspace navigation" />
          {read.error && (
            <Button variant="outline" disabled={read.busy} onClick={() => void read.refresh()}>
              Retry workspace navigation
            </Button>
          )}
        </>
      )}
    </main>
  );
}
