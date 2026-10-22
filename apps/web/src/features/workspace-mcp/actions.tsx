import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Label } from '@tulipfarm/sprout/label';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { useMcpActions } from './queries';
import type { McpApi } from './api';
import type { Action, Capabilities } from './contracts';
import { McpCommandFeedback, McpRead, useMcpCommand } from './state';

const labels: Record<Action['status'], string> = {
  'awaiting-approval': 'Awaiting exact approval',
  ready: 'Approved, waiting to dispatch',
  dispatched: 'Dispatched, awaiting receipt',
  succeeded: 'Provider receipt received',
  rejected: 'Rejected before dispatch',
  cancelled: 'Cancelled before dispatch',
  expired: 'Approval expired',
  invalidated: 'Review invalidated',
  'outcome-unknown': 'Outcome unknown',
};
export function McpActions({
  api,
  capabilities,
  kind,
  originId,
}: {
  api: McpApi;
  capabilities: Capabilities;
  kind: 'chat' | 'task' | 'integration';
  originId: string;
}) {
  const [cursor, setCursor] = useState('');
  const read = useMcpActions(api, kind, originId, cursor);
  if (
    kind === 'chat' &&
    !cursor &&
    (read.state.kind === 'loading' ||
      (read.state.kind === 'ready' && !read.state.error && !read.state.data.actions.length))
  )
    return null;
  return (
    <section aria-label="MCP actions and receipts" className="space-y-4">
      {read.state.kind === 'ready' && <h3 className="text-base font-medium">Connected-tool actions and receipts</h3>}
      <McpRead
        state={read.state}
        refresh={read.refresh}
        label="Connected-tool actions"
        errorDescription="The action list could not be checked. Retry this check to see current actions and receipts."
      >
        {(data, blocked) => (
          <>
            {data.actions.length ? (
              data.actions.map(action => (
                <ActionReview
                  key={`${action.id}/${action.digest}`}
                  api={api}
                  action={action}
                  dispatchEnabled={capabilities.dispatchEnabled}
                  blocked={blocked}
                  refresh={read.refresh}
                />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No MCP actions for this {kind}. No external call is authorized by this empty list.
              </p>
            )}
            {(cursor || data.nextCursor) && (
              <nav aria-label="MCP action pages" className="flex flex-wrap gap-2">
                {cursor && (
                  <Button variant="outline" onClick={() => setCursor('')}>
                    First action page
                  </Button>
                )}
                {data.nextCursor && (
                  <Button variant="outline" onClick={() => setCursor(data.nextCursor ?? '')}>
                    Next action page
                  </Button>
                )}
              </nav>
            )}
          </>
        )}
      </McpRead>
      {read.delayed && (
        <div className="space-y-2">
          <p role="status">
            Automatic checks stopped after a minute. Work continues on the server. Leaving this page does not cancel a
            dispatched call.
          </p>
          <Button variant="outline" onClick={() => void read.refresh()}>
            Check MCP action status
          </Button>
        </div>
      )}
    </section>
  );
}
function ActionReview({
  api,
  action,
  dispatchEnabled,
  blocked,
  refresh,
}: {
  api: McpApi;
  action: Action;
  dispatchEnabled: boolean;
  blocked: boolean;
  refresh: () => Promise<void>;
}) {
  const command = useMcpCommand();
  const [now, setNow] = useState(Date.now);
  const [outcome, setOutcome] = useState<'completed' | 'not-performed' | 'still-unknown'>('still-unknown');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    setNotes('');
    setOutcome('still-unknown');
    command.reset();
  }, [action.visibility]);
  const expires = Date.parse(action.expiresAt);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(expires - Date.now(), 0) + 20, 2147483647));
    return () => clearTimeout(timer);
  }, [expires]);
  const expired = now >= expires;
  const locked = blocked || command.blocked;
  const decide = (decision: 'approve' | 'reject') =>
    void command.run(
      () => api.decide(action.id, { requestId: crypto.randomUUID(), digest: action.digest, decision }),
      refresh,
    );
  return (
    <article aria-label={`MCP action ${action.id}`} className="min-w-0 space-y-4 rounded-xl border p-4">
      <header className="space-y-2">
        <h4 className="break-all font-medium">
          {action.visibility === 'full' ? action.exact.toolName : 'MCP action status'}
        </h4>
        <p className="break-all text-sm">{action.integrationName}</p>
        <Badge
          variant={
            action.status === 'outcome-unknown' ? 'warning' : action.status === 'succeeded' ? 'success' : 'secondary'
          }
        >
          {labels[action.status]}
        </Badge>
      </header>
      {action.visibility === 'full' ? (
        <>
          <dl className="grid min-w-0 gap-3 break-all sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">Destination endpoint</dt>
              <dd>{action.exact.endpoint}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">External account</dt>
              <dd>{action.exact.accountLabel ?? 'No verified account label'}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Tool revision</dt>
              <dd>{action.exact.toolRevision}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Authorization epoch</dt>
              <dd>{action.exact.authorizationEpoch}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Requester and origin</dt>
              <dd>
                {action.exact.requester} · {action.exact.origin.kind} {action.exact.origin.id}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Exact review expires</dt>
              <dd>
                <time dateTime={action.expiresAt}>{new Date(action.expiresAt).toLocaleString()}</time>
              </dd>
            </div>
          </dl>
          <section className="space-y-2">
            <h5 className="font-medium">Exact outbound arguments</h5>
            <pre
              aria-label="Exact MCP arguments"
              className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-sm"
            >
              {JSON.stringify(action.exact.arguments, null, 2)}
            </pre>
          </section>
          <section className="space-y-2">
            <h5 className="font-medium">Protected inputs in this action</h5>
            {action.exact.sourceLabels.length ? (
              <ul className="list-inside list-disc break-words">
                {action.exact.sourceLabels.map((source, index) => (
                  <li key={index}>{source}</li>
                ))}
              </ul>
            ) : (
              <p>No protected sources reported.</p>
            )}
            {action.exact.outboundConsentRequired && (
              <p>
                Approval also consents to sending these exact arguments to this destination. Private requester input and
                task instructions count as protected sources. Selection and standing exceptions do not grant disclosure
                consent.
              </p>
            )}
            {action.exact.standingExceptionApplied && (
              <p>
                A standing tool exception was evaluated. It does not bypass protected-input consent or current source
                access.
              </p>
            )}
          </section>
        </>
      ) : (
        <p>
          This view shows action status only. Arguments, results, and previous notes are concealed. You can record an
          observation from independent external evidence when the outcome is unknown.
        </p>
      )}
      {action.status === 'awaiting-approval' &&
        (expired ? (
          <Alert>
            <AlertDescription>
              This exact approval expired. Request a fresh proposal; this review cannot execute.
            </AlertDescription>
          </Alert>
        ) : action.canDecide && action.visibility === 'full' ? (
          <div className="space-y-3">
            <p>
              Approve only the immutable action shown here. Any change to arguments, destination, tool revision, account
              authority, or source access invalidates this review.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={locked || !dispatchEnabled} aria-busy={command.busy} onClick={() => decide('approve')}>
                Approve exact MCP action
              </Button>
              <Button variant="outline" disabled={locked} onClick={() => decide('reject')}>
                Reject MCP action
              </Button>
            </div>
          </div>
        ) : (
          <p>Only the current requester with source and integration access can decide this action.</p>
        ))}
      {['expired', 'invalidated'].includes(action.status) && (
        <p>This review cannot execute. Inspect a fresh proposal in the original chat or task.</p>
      )}
      {action.integrationPaused && (
        <Alert>
          <AlertDescription>
            The entire integration is paused for every user. Do not retry this action or propose a replacement while its
            outcome is unknown. Check the external service first. Reconnecting cannot remove the barrier.
          </AlertDescription>
        </Alert>
      )}
      {action.receipt && (
        <section aria-label="Provider execution receipt" className="space-y-2">
          <h5 className="font-medium">Provider execution receipt</h5>
          <p>
            {action.receipt.outcome === 'succeeded'
              ? 'A successful protocol response was recorded. It does not independently verify the business effect.'
              : action.receipt.outcome === 'unknown'
                ? 'Dispatch evidence exists, but the provider outcome is unknown.'
                : 'No dispatch was recorded.'}
          </p>
          <p className="text-sm">
            Dispatched {action.receipt.dispatchedAt ?? 'not recorded'} · Received{' '}
            {action.receipt.receivedAt ?? 'not recorded'}
          </p>
          {action.receipt.text !== null && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-sm">{action.receipt.text}</pre>
          )}
          {action.receipt.structured !== null && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-sm">
              {JSON.stringify(action.receipt.structured, null, 2)}
            </pre>
          )}
        </section>
      )}
      {action.reconciliation && (
        <section aria-label="Human reconciliation" className="space-y-2">
          <h5 className="font-medium">
            {action.reconciliation.administrative ? 'Administrative observation' : 'Human-reported observation'}
          </h5>
          <p>
            {action.reconciliation.outcome} · {action.reconciliation.observer} ·{' '}
            {new Date(action.reconciliation.observedAt).toLocaleString()}
          </p>
          <p className="whitespace-pre-wrap break-words">{action.reconciliation.notes}</p>
          <p>This observation does not rewrite the provider receipt or declare provider-confirmed success.</p>
        </section>
      )}
      {action.status === 'outcome-unknown' && action.canReconcile && (
        <form
          className="space-y-3"
          onSubmit={event => {
            event.preventDefault();
            if (locked || !notes.trim()) return;
            void command.run(
              () =>
                api.reconcile(action.id, {
                  requestId: crypto.randomUUID(),
                  digest: action.digest,
                  outcome,
                  notes: notes.trim(),
                }),
              refresh,
            );
          }}
        >
          <h5 className="font-medium">Record external observation</h5>
          <Label htmlFor={`outcome-${action.id}`}>Observed outcome</Label>
          <Select
            value={outcome}
            disabled={locked}
            onValueChange={value => {
              if (value === 'completed' || value === 'not-performed' || value === 'still-unknown') setOutcome(value);
            }}
          >
            <SelectTrigger id={`outcome-${action.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="still-unknown">Still unknown, keep integration paused</SelectItem>
              <SelectItem value="completed">Completed, observed externally</SelectItem>
              <SelectItem value="not-performed">Confirmed not performed</SelectItem>
            </SelectContent>
          </Select>
          <Label htmlFor={`notes-${action.id}`}>Evidence and notes</Label>
          <Textarea
            id={`notes-${action.id}`}
            disabled={locked}
            value={notes}
            maxLength={4000}
            onChange={event => setNotes(event.target.value)}
          />
          <p className="text-sm text-muted-foreground">
            Still unknown keeps the barrier. Confirmed not performed permits a newly reviewed action, never replay of
            this dispatch. Separate integrations to the same account are not covered by this barrier.
          </p>
          <Button type="submit" disabled={locked || !notes.trim()} aria-busy={command.busy}>
            Record reconciliation
          </Button>
        </form>
      )}
      <McpCommandFeedback
        command={command}
        check={async () => {
          await refresh();
          command.reset();
        }}
      />
    </article>
  );
}
