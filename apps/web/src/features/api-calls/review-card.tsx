import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Globe } from 'reicon-react/icons/Globe';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { TableRequestError } from '@/features/tables/request-state';
import { placementPhrase, placementSchema } from '@/features/secrets/contracts';
import { apiCallErrorMessage, type ApiCallView } from './api';
import { useApiCall, useApiCallsApi, useTaskApiCalls } from './queries';

type Secret = ApiCallView['secrets'][number];

function target(call: ApiCallView) {
  try {
    const url = new URL(call.url);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return call.host;
  }
}

function secretPhrase(secret: Secret) {
  const placement = placementSchema.safeParse(secret.placement);
  return placement.success ? `${secret.name} ${placementPhrase(placement.data)}` : secret.name;
}

/** Headers a secret adds, with its name in place of the value. */
function secretHeader(secret: Secret): [string, string] | null {
  const placement = placementSchema.safeParse(secret.placement);
  if (!placement.success) return null;
  const value = `‹${secret.name}›`;
  switch (placement.data.kind) {
    case 'bearer':
      return ['Authorization', `Bearer ${value}`];
    case 'basic':
      return ['Authorization', `Basic ${value}`];
    case 'header':
      return [placement.data.name ?? 'Header', value];
    case 'cookie':
      return ['Cookie', `${placement.data.name ?? 'cookie'}=${value}`];
    default:
      return null;
  }
}

const failures: Record<string, string> = {
  timeout: 'The service did not answer in time.',
  'network-failed': 'The connection failed.',
  'dns-failed': 'The address could not be found.',
  'address-denied': 'This address is not allowed.',
  'secret-unavailable': 'A secret could not be used.',
  disabled: 'Secrets are not available here.',
};

function settled(call: ApiCallView): { title: string; detail?: string } | null {
  switch (call.status) {
    case 'awaiting-approval':
      return null;
    case 'sending':
      return { title: 'Sending…' };
    case 'sent':
      return { title: call.responseStatus === null ? 'Sent' : `Sent · ${call.responseStatus}` };
    case 'rejected':
      return { title: 'Not sent', detail: 'You chose not to send it.' };
    case 'expired':
      return { title: 'Expired', detail: 'Nobody approved it within 24 hours. Nothing was sent.' };
    case 'conflict':
      return { title: 'Not sent', detail: 'The request or a secret changed after it was proposed.' };
    case 'outcome-unknown':
      return { title: 'Outcome unknown', detail: 'The service may have received it. Check there before trying again.' };
    case 'failed':
      return {
        title: 'Failed',
        detail: (call.errorCode && failures[call.errorCode]) ?? 'It could not be sent.',
      };
  }
}

function StatusLine({ call, title, children }: { call: ApiCallView; title: string; children?: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl border border-border bg-card px-3 py-2 text-sm text-card-foreground"
    >
      <span className="text-muted-foreground">
        <Globe size={14} aria-hidden="true" />
      </span>
      <h4 id={`${id}-title`} className="min-w-0 font-medium break-all">
        {call.method} {target(call)}
      </h4>
      <p role="status" className="min-w-0 text-muted-foreground">
        {title}
        {children && <> · {children}</>}
      </p>
    </section>
  );
}

/** A change waiting in a chat, read by its call ID. Only the member who asked can see it. */
export function ApiCallReviewCard({
  workspaceId,
  callId,
  onSettled,
}: {
  workspaceId: string;
  callId: string;
  onSettled?: () => Promise<void> | void;
}) {
  const read = useApiCall(workspaceId, callId);
  const status = read.state.kind === 'ready' ? read.state.data.status : null;
  const latest = useRef(onSettled);
  latest.current = onSettled;
  useEffect(() => {
    if (status && status !== 'awaiting-approval' && status !== 'sending') void latest.current?.();
  }, [status]);
  if (read.state.kind === 'unavailable')
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Waiting for approval from the person who asked.
      </p>
    );
  if (read.state.kind === 'error')
    return (
      <section className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-3 py-2 text-sm text-card-foreground">
        <span className="font-medium">Could not load this request</span>
        <Button variant="link" size="sm" onClick={() => void read.refresh()}>
          Try again
        </Button>
      </section>
    );
  if (read.state.kind !== 'ready')
    return (
      <div role="status" aria-label="Loading request" className="space-y-2">
        <Skeleton />
        <span className="sr-only">Loading request…</span>
      </div>
    );
  return <ApiCallReview workspaceId={workspaceId} call={read.state.data} refresh={read.refresh} />;
}

/** The changes a task proposed, for its owner. */
export function TaskApiCalls({
  workspaceId,
  taskId,
  revision,
}: {
  workspaceId: string;
  taskId: string;
  revision: string;
}) {
  const read = useTaskApiCalls(workspaceId, taskId, revision);
  if (read.state.kind !== 'ready' || read.state.data.length === 0) return null;
  return (
    <div className="space-y-2">
      {read.state.data.map(call => (
        <ApiCallReview key={call.id} workspaceId={workspaceId} call={call} refresh={read.refresh} />
      ))}
    </div>
  );
}

export function ApiCallReview({
  workspaceId,
  call,
  refresh,
}: {
  workspaceId: string;
  call: ApiCallView;
  refresh: () => Promise<void>;
}) {
  const id = useId();
  const api = useApiCallsApi(workspaceId);
  const [sending, setSending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept across retries of the same choice, so a lost response replays instead of conflicting.
  const command = useRef<{ decision: 'approve' | 'reject'; id: string } | null>(null);
  const done = settled(call);
  if (done)
    return (
      <StatusLine call={call} title={done.title}>
        {done.detail}
      </StatusLine>
    );

  async function decide(decision: 'approve' | 'reject') {
    if (sending || !call.digest) return;
    if (command.current?.decision !== decision) command.current = { decision, id: crypto.randomUUID() };
    setSending(decision);
    setError(null);
    try {
      await api.decide(call.id, { commandId: command.current.id, digest: call.digest, decision });
      await refresh();
    } catch (failure) {
      if (failure instanceof TableRequestError && failure.status < 500) command.current = null;
      setError(apiCallErrorMessage(failure));
      if (failure instanceof TableRequestError && [404, 409].includes(failure.status)) await refresh();
    } finally {
      setSending(null);
    }
  }

  const headers = [
    ...Object.entries(call.headers),
    ...call.secrets.flatMap(secret => {
      const header = secretHeader(secret);
      return header ? [header] : [];
    }),
  ];
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-3 rounded-xl border border-border bg-card px-3 py-3 text-card-foreground"
    >
      <div className="space-y-0.5">
        <h4 id={`${id}-title`} className="flex items-center gap-2 text-sm font-medium">
          <Globe size={16} aria-hidden="true" />
          <span className="min-w-0 break-all">
            {call.method} {target(call)}
          </span>
        </h4>
        {call.purpose && (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{call.purpose}</p>
        )}
        {call.secrets.length > 0 && (
          <p className="break-words text-xs text-muted-foreground">Uses {call.secrets.map(secretPhrase).join(', ')}</p>
        )}
      </div>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Details</CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="mt-2 space-y-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Address</dt>
              <dd className="break-all font-mono">{call.url}</dd>
            </div>
            {headers.length > 0 && (
              <div>
                <dt className="text-muted-foreground">Headers</dt>
                <dd>
                  <ul className="font-mono">
                    {headers.map(([name, value], index) => (
                      <li key={`${name}-${index}`} className="break-all">
                        {name}: {value}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            {call.body && (
              <div>
                <dt className="text-muted-foreground">Body · {call.body.contentType}</dt>
                <dd>
                  <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap break-all">
                    {call.body.preview}
                    {call.body.truncated && '\n…'}
                  </pre>
                </dd>
              </div>
            )}
          </dl>
        </CollapsibleContent>
      </Collapsible>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">Nothing is sent until you choose.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={sending !== null}
            aria-busy={sending === 'reject'}
            onClick={() => void decide('reject')}
          >
            Don’t send
          </Button>
          <Button
            size="sm"
            disabled={sending !== null}
            aria-busy={sending === 'approve'}
            onClick={() => void decide('approve')}
          >
            {sending === 'approve' ? 'Sending…' : 'Send request'}
          </Button>
        </div>
      </div>
    </section>
  );
}
