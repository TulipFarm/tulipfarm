import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { apiOrigin, authClient } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { slackLinkRoute } from '@/router';
import { useSlackLink, slackLinkStatusSchema as statusSchema } from '@/features/integrations/queries';

type State =
  | { kind: 'loading' | 'starting' | 'error' | 'unavailable' }
  | { kind: 'loaded'; status: z.infer<typeof statusSchema> };

export function SlackLinkPage() {
  const session = authClient.useSession();
  if (session.data) return <SlackLinkStatus />;
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      {session.isPending ? (
        <StatePanel
          heading="h1"
          kind="loading"
          title="Checking your Slack link"
          description="Your original request stays saved while you connect your account."
        />
      ) : (
        <StatePanel
          heading="h1"
          kind="error"
          title="Could not check your session"
          description="Your original Slack request is still saved. Check your session and try again."
        >
          <Button onClick={() => void session.refetch()}>Check session again</Button>
          <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
            Back to TulipFarm
          </Button>
        </StatePanel>
      )}
    </main>
  );
}

function SlackLinkStatus() {
  const { workspaceId, eventId, recovery } = slackLinkRoute.useSearch();
  const read = useSlackLink(workspaceId, eventId);
  const [command, setState] = useState<State | null>(null);
  const state: State =
    command ?? (read.state.kind === 'ready' ? { kind: 'loaded', status: read.state.data } : { kind: read.state.kind });
  const check = () => {
    setState(null);
    void read.refresh();
  };
  async function start() {
    setState({ kind: 'starting' });
    try {
      const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/link`, {
        method: 'POST',
        body: { eventId },
        signal: requestSignal(),
      });
      if (!response.ok) {
        setState({ kind: [401, 403, 404].includes(response.status) ? 'unavailable' : 'error' });
        return;
      }
      const { url } = z.object({ url: z.url() }).parse(await readJson(response));
      const destination = new URL(url);
      if (destination.origin !== 'https://slack.com' || destination.pathname !== '/openid/connect/authorize')
        throw new Error('invalid-destination');
      window.location.assign(destination.href);
    } catch {
      setState({ kind: 'error' });
    }
  }
  const held = state.kind === 'loaded' && state.status.state === 'dispatch-held';
  const cancelled = state.kind === 'loaded' && state.status.state === 'cancelled';
  const reconnect = state.kind === 'loaded' && state.status.state === 'reconnect-required';
  const execution = state.kind === 'loaded' ? state.status.execution : 'disabled';
  const descriptions = {
    disabled:
      'Your Slack identity and access are connected. Your original request is saved. Requests that have not started resume with current permissions. Previous actions are not approved again by reconnecting.',
    pending:
      'Your original request is queued or running. You can return to Slack. Channel-safe answers appear in the original thread. Restricted answers arrive by direct message.',
    sending:
      'Your answer is being sent to Slack. Check the original thread or your direct messages before sending the request again.',
    retry: 'Slack asked us to wait. Your saved answer will be retried automatically without repeating the request.',
    sent: 'A reply was delivered in Slack. Channel-safe answers are in the original thread; restricted answers are in your direct messages.',
    unknown:
      'We could not confirm whether Slack received the answer. We will not resend it automatically. Check the original thread and your direct messages before taking further action.',
    blocked:
      'Current access or delivery settings prevent this answer from being sent. Review the request in TulipFarm before trying again.',
  };
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      {state.kind === 'loading' || state.kind === 'starting' ? (
        <StatePanel
          heading="h1"
          kind="loading"
          title={state.kind === 'loading' ? 'Checking your Slack link' : 'Opening Slack sign-in'}
          description="Your original request stays saved while you connect your account."
        />
      ) : state.kind === 'error' ? (
        <StatePanel
          heading="h1"
          kind="error"
          title="Could not check your Slack link"
          description="We could not confirm the current status. Check Slack and refresh this status before starting again."
        >
          <Button onClick={check}>Check status again</Button>
          <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
            Back to TulipFarm
          </Button>
        </StatePanel>
      ) : state.kind === 'unavailable' || cancelled ? (
        <StatePanel
          heading="h1"
          kind="unavailable"
          title="This Slack link is unavailable"
          description="You must already belong to this workspace. Removed or revoked links cannot resume an old request."
        >
          <Button nativeButton={false} render={<Link to="/" />}>
            Back to TulipFarm
          </Button>
        </StatePanel>
      ) : (
        <StatePanel
          heading="h1"
          kind={
            held
              ? ['blocked', 'unknown'].includes(execution)
                ? 'error'
                : 'success'
              : recovery || reconnect
                ? 'error'
                : 'empty'
          }
          title={
            held
              ? execution === 'sent'
                ? 'Reply delivered to Slack'
                : 'Slack connected'
              : reconnect
                ? 'Reconnect your Slack account'
                : recovery
                  ? 'Slack integration was not completed'
                  : 'Connect your Slack identity'
          }
          description={
            held
              ? descriptions[execution]
              : reconnect
                ? 'Slack access expired or its refresh could not be confirmed. Reconnect the same Slack account in this workspace. Previous approvals will not be reused. Check Slack before making a new request for an action with an unknown outcome.'
                : recovery
                  ? 'Consent was cancelled, expired, or could not be verified. Your original request is still held. Start a new attempt when you are ready.'
                  : 'Sign in as the Slack user who sent this request. Slack will then ask for the approved access. We never match accounts by email.'
          }
        >
          {!held && (
            <Button onClick={() => void start()}>
              {reconnect ? 'Reconnect Slack' : recovery ? 'Try Slack integration again' : 'Sign in with Slack'}
            </Button>
          )}
          {read.state.kind === 'ready' && read.state.error && (
            <p role="alert">Slack status could not refresh. Check status again.</p>
          )}
          {held && <Button onClick={check}>Check status again</Button>}
          <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
            Back to TulipFarm
          </Button>
        </StatePanel>
      )}
    </main>
  );
}
