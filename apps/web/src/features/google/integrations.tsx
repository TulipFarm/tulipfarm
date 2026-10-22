import { useRef, useState } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { googleApi, googleError } from '@/lib/google-workspace';
import { GoogleReadFeedback } from './read';
import { useGoogleIntegration, useIntegrationChanges } from '@/features/integrations/queries';
import { GoogleProposals } from './proposals';
import { GoogleHeartbeat } from './heartbeat';

type Disconnect = 'idle' | 'confirm' | 'pending' | 'uncertain';

export function GoogleAccount({ workspaceId }: { workspaceId: string }) {
  const read = useGoogleIntegration(workspaceId);
  const changes = useIntegrationChanges();
  const [state, setState] = useState<Disconnect>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const data = read.data;
  const blocked = read.busy || !!read.error || state === 'pending' || state === 'uncertain';
  async function disconnect() {
    if (lock.current) return;
    lock.current = true;
    setMessage(null);
    setState('pending');
    try {
      const result = await googleApi.disconnect(workspaceId);
      await changes.authority('google');
      setState('idle');
      if (!result.revoked) setMessage('Disconnected here. Also remove TulipFarm in your Google Account permissions.');
    } catch (error) {
      setMessage(googleError(error));
      setState('uncertain');
    } finally {
      lock.current = false;
    }
  }
  async function check() {
    const result = await read.refresh();
    if (result && state === 'uncertain') {
      setState('idle');
      if (result.status.status === 'disconnected') setMessage(null);
    }
  }
  if (!data || data.status.status === 'disconnected')
    return (
      message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )
    );
  return (
    <section aria-label="Google account" className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <p className="min-w-0 flex-1 truncate font-medium">{data.status.email}</p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Check Google status"
          aria-busy={read.busy}
          onClick={() => {
            if (!read.busy) void check();
          }}
        >
          <RefreshCwIcon aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={blocked}
          aria-busy={state === 'pending'}
          onClick={() => setState('confirm')}
        >
          {state === 'pending' ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </div>
      <GoogleReadFeedback busy={read.busy} error={read.error} hasData title="Google integration" />
      {message && (
        <Alert variant={state === 'uncertain' ? 'destructive' : 'default'}>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {state === 'uncertain' && (
        <p role="status">No mutation will be retried automatically. Check Google status to recover.</p>
      )}
      <AlertDialog
        open={state === 'confirm'}
        onOpenChange={open => {
          if (!open) setState('idle');
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Disconnect Google?</AlertDialogTitle>
          <AlertDialogDescription>
            Agents lose access to {data.status.email}. Gmail heartbeat stops.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void disconnect()}>
              Disconnect Google
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function GoogleApprovals({ workspaceId }: { workspaceId: string }) {
  const read = useGoogleIntegration(workspaceId);
  const data = read.data;
  if (!data) return null;
  const available = !read.busy && !read.error;
  const binding =
    data.status.status === 'connected'
      ? `${data.status.integrationId}:${data.status.accountId}:${data.status.generation}`
      : null;
  return (
    <div id="google-workspace" className="space-y-6">
      {binding && <GoogleHeartbeat key={binding} workspaceId={workspaceId} available={available} />}
      <GoogleProposals workspaceId={workspaceId} available={available} />
    </div>
  );
}
