import { useEffect, useRef, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { Badge } from '@tulipfarm/sprout/badge';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { googleActionRefused, googleApi, googleError, type GoogleProposal } from '@/lib/google-workspace';
import { GoogleReadFeedback } from './read';
import { useGoogleProposals, useGoogleProposal, useIntegrationChanges } from '@/features/integrations/queries';
import { Disclosure } from '@/components/disclosure';
import { GoogleUploadPreview, OperationSummary, reviewableOperation } from './operation-summary';
import {
  CalendarActionSummary,
  CalendarActionOutcome,
  CalendarCurrentEvent,
  calendarActionStatus,
  isCalendarAction,
} from './calendar-action';
import { useFlag } from '@/lib/feature-flags';
import { Refresh } from 'reicon-react/icons/Refresh';
import { CalendarActionVisual } from './calendar-action-canvas';
import {
  googleActionState,
  googleActionTitle,
  googleExecutionLabel,
  googleReceiptFile,
  type GoogleMutation,
} from './action-state';
import { useOptionalCanvas } from '@/features/chat/canvas-state';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { GoogleResultCard, GoogleProposalSummaryCard } from './result-card';

export function GoogleProposals({ workspaceId, available }: { workspaceId: string; available: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const read = useGoogleProposals(workspaceId, cursor);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section
      aria-labelledby="google-proposals-heading"
      className="flex min-w-0 flex-col gap-4 border-t border-border pt-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="google-proposals-heading" tabIndex={-1} className="text-lg font-medium">
          Google action approvals
        </h2>
        <Button variant="outline" disabled={read.busy} aria-busy={read.busy} onClick={() => void read.refresh()}>
          <span aria-hidden="true" className={read.busy ? 'animate-spin motion-reduce:animate-none' : undefined}>
            <Refresh size={16} />
          </span>
          Refresh Google proposals
        </Button>
      </header>
      <p className="max-w-prose text-muted-foreground">
        Actions proposed in your personal chats and agent runs appear here. Open an action to review its complete
        payload before approving or rejecting it. Consent alone never approves a write.
      </p>
      <GoogleReadFeedback busy={read.busy} error={read.error} hasData={!!read.data} title="Google proposals" />
      {read.data && (
        <>
          <p role="status">
            {
              read.data.proposals.filter(
                proposal =>
                  !proposal.decision && !proposal.receiptStatus && Date.parse(proposal.expiresAt) > Date.now(),
              ).length
            }{' '}
            awaiting your review on this page{read.data.nextCursor ? '. Older actions are available below.' : '.'}
          </p>
          {!read.data.proposals.length && (
            <StatePanel
              kind="empty"
              title="No Google proposals"
              description="Ask in personal chat for a Google action. Any proposed write will wait here for your review. Heartbeat only produces private answers and cannot propose writes."
            />
          )}
          <ul className="space-y-3">
            {read.data.proposals.map(proposal => (
              <li key={proposal.id}>
                <GoogleProposalSummaryCard
                  proposal={proposal}
                  action={{
                    label: 'View action',
                    disabled: read.busy || !!read.error,
                    onClick: () => setSelected(proposal.id),
                  }}
                />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3">
            {cursor && (
              <Button
                variant="outline"
                disabled={read.busy}
                onClick={() => {
                  setSelected(null);
                  setCursor(null);
                }}
              >
                Newest proposals
              </Button>
            )}
            {read.data.nextCursor && (
              <Button
                variant="outline"
                disabled={read.busy || !!read.error}
                onClick={() => {
                  setSelected(null);
                  setCursor(read.data?.nextCursor ?? null);
                }}
              >
                Older proposals
              </Button>
            )}
          </div>
        </>
      )}
      {selected && read.data && (
        <GoogleProposalReview
          key={selected}
          workspaceId={workspaceId}
          proposalId={selected}
          available={available && !read.error && !read.busy}
        />
      )}
    </section>
  );
}

export function GoogleProposalReview({
  workspaceId,
  proposalId,
  available,
  focusOnLoad = true,
  variant = 'page',
  onSettled,
}: {
  workspaceId: string;
  proposalId: string;
  available: boolean;
  focusOnLoad?: boolean;
  variant?: 'page' | 'canvas';
  onSettled?: () => void;
}) {
  const read = useGoogleProposal(workspaceId, proposalId);
  const changes = useIntegrationChanges();
  const [confirmed, setConfirmed] = useState(false);
  const canvas = useOptionalCanvas();
  const [localMutation, setLocalMutation] = useState<GoogleMutation>({ kind: 'idle' });
  const mutation = canvas?.googleMutations[proposalId] ?? localMutation;
  const setMutation = (value: GoogleMutation) => {
    if (canvas) canvas.setGoogleMutation(proposalId, value);
    else setLocalMutation(value);
  };
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showCurrent, setShowCurrent] = useState(false);
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const focused = useRef(false);
  const proposal = read.data;
  useEffect(() => {
    if (
      proposal?.receipt?.status === 'succeeded' ||
      proposal?.receipt?.status === 'failed' ||
      proposal?.decision === 'reject'
    )
      onSettled?.();
  }, [proposal?.receipt?.status, proposal?.decision, onSettled]);
  const calendarEnabled = useFlag('google-calendar-canvas');
  const calendarBlocked =
    !!proposal &&
    isCalendarAction(proposal.operation) &&
    proposal.operation.kind !== 'calendar.events.delete' &&
    !!proposal.operation.event.conferenceData &&
    !calendarEnabled;
  const result = proposal?.receipt?.status === 'succeeded' ? proposal.receipt.result.data : null;
  const resultEventId =
    result && typeof result === 'object' && !Array.isArray(result) && typeof result.id === 'string' ? result.id : null;
  const currentEventId =
    proposal && isCalendarAction(proposal.operation)
      ? proposal.receipt
        ? proposal.receipt.status === 'succeeded' &&
          proposal.operation.kind !== 'calendar.events.delete' &&
          (!('eventId' in proposal.operation) || resultEventId === proposal.operation.eventId)
          ? resultEventId
          : null
        : 'eventId' in proposal.operation
          ? proposal.operation.eventId
          : null
      : null;
  const visual = variant === 'canvas' && !!proposal && isCalendarAction(proposal.operation) ? proposal.operation : null;
  useEffect(() => {
    if (focusOnLoad && proposal && !focused.current) {
      heading.current?.focus();
      focused.current = true;
    }
  }, [proposal, focusOnLoad]);
  const refused = mutation.kind === 'refused';
  const blocked = calendarBlocked || refused || !available || read.busy || !!read.error || mutation.kind !== 'idle';
  const rejectBlocked =
    !available || read.busy || !!read.error || mutation.kind === 'pending' || mutation.kind === 'uncertain';
  async function mutate(action: 'approve' | 'reject' | 'execute', exact: GoogleProposal) {
    if (lock.current || (action === 'reject' ? rejectBlocked : blocked)) return;
    lock.current = true;
    setMutation({ kind: 'pending', action });
    setMessage(null);
    try {
      if (action === 'execute') {
        const receipt = await googleApi.execute(workspaceId, exact.id);
        if (!receipt) throw new Error('Execution not confirmed');
        setMessage('Execution status received. This action will not be sent again.');
      } else {
        await googleApi.decide(workspaceId, exact, action);
        setMessage(
          action === 'approve'
            ? 'Exact action approved. You can now execute it once.'
            : 'Action rejected. It cannot be executed.',
        );
      }
      await changes.content('google');
      const current = await read.refresh();
      if (!current || (action === 'execute' ? !current.receipt : !current.decision))
        throw new Error('Status not confirmed');
      setMutation({ kind: 'idle' });
      setConfirmed(false);
      requestAnimationFrame(() => heading.current?.focus());
    } catch (error) {
      if (action !== 'reject' && googleActionRefused(error)) setMutation({ kind: 'refused', action });
      else setMutation({ kind: 'uncertain', action });
      setMessage(googleError(error));
    } finally {
      lock.current = false;
    }
  }
  async function check() {
    if (lock.current) return;
    lock.current = true;
    setChecking(true);
    try {
      const current = await read.refresh();
      if (!current) return;
      if (mutation.kind === 'uncertain') {
        if (current.receipt || (mutation.action !== 'execute' && current.decision)) {
          await changes.content('google');
          setMutation({ kind: 'idle' });
          setMessage('Saved status recovered. No write was repeated.');
        } else setMessage('The previous request remains unconfirmed. Check status again; do not send a replacement.');
      }
    } catch {
      setMessage('Couldn’t confirm the latest status. Check again; no write was repeated.');
    } finally {
      lock.current = false;
      setChecking(false);
    }
  }
  const payload = proposal && (
    <>
      {visual && (
        <dl className="grid min-w-0 gap-2 text-sm">
          <dt className="font-medium">Calendar</dt>
          <dd className="break-all">{visual.calendarId}</dd>
          {'eventId' in visual && (
            <>
              <dt className="font-medium">Event ID</dt>
              <dd className="break-all font-mono">{visual.eventId}</dd>
            </>
          )}
        </dl>
      )}
      <pre
        aria-label="Complete Google action payload"
        tabIndex={0}
        className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-4 text-sm"
      >
        {JSON.stringify(reviewableOperation(proposal.operation), null, 2)}
      </pre>
      <dl className="grid min-w-0 gap-2 text-sm">
        <dt className="font-medium">Google account ID</dt>
        <dd className="break-all">{proposal.integration.accountId}</dd>
        <dt className="font-medium">Approval digest</dt>
        <dd className="break-all font-mono">{proposal.digest}</dd>
        <dt className="font-medium">Expires</dt>
        <dd>{new Date(proposal.expiresAt).toLocaleString()}</dd>
      </dl>
      {proposal.receipt && (
        <pre
          aria-label="Google action result"
          tabIndex={0}
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-4 text-sm"
        >
          {JSON.stringify(proposal.receipt, null, 2)}
        </pre>
      )}
    </>
  );
  const state = proposal ? googleActionState(proposal, mutation) : null;
  const receiptFile = proposal ? googleReceiptFile(proposal) : null;
  if (proposal && !isCalendarAction(proposal.operation) && state)
    return (
      <section aria-label="Exact Google action review" className="flex min-w-0 flex-col gap-4">
        {variant === 'page' && <GoogleResultCard proposal={proposal} mutation={mutation} />}
        <header className="flex items-center justify-between gap-3">
          <h4 ref={heading} tabIndex={-1} className="sr-only">
            Exact action review
          </h4>
          <Badge variant={state.tone}>{state.label}</Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Check Google action status"
            aria-label="Check Google action status"
            disabled={read.busy || checking || mutation.kind === 'pending'}
            aria-busy={read.busy || checking}
            onClick={() => void check()}
          >
            <Refresh size={16} />
          </Button>
        </header>
        {read.error && (
          <Alert variant="destructive">
            <AlertDescription>
              Couldn’t refresh this action. The last loaded review is still shown; check status before continuing.
            </AlertDescription>
          </Alert>
        )}
        {state.kind === 'unknown' && (
          <Alert variant="destructive">
            <AlertDescription>
              Google may have completed this action. Check status; do not send a replacement.
            </AlertDescription>
          </Alert>
        )}
        {state.kind === 'saving' && (
          <Alert>
            <AlertDescription>
              This action is still in progress. Check status before taking another action.
            </AlertDescription>
          </Alert>
        )}
        {state.kind === 'failed' && (
          <Alert variant="destructive">
            <AlertDescription>
              {refused
                ? 'This action is blocked. Review Details before asking for a new proposal.'
                : 'Google rejected this request. Review Details before asking for a new proposal.'}
            </AlertDescription>
          </Alert>
        )}
        {state.kind === 'expired' && (
          <p className="text-sm text-muted-foreground">
            This review expired. Check status before asking for a new proposal.
          </p>
        )}
        {state.kind === 'rejected' && <p className="text-sm text-muted-foreground">This action cannot run.</p>}
        {state.kind === 'succeeded' ? (
          <div className="space-y-3">
            <h3 className="break-words text-xl font-medium">
              {receiptFile?.title ?? googleActionTitle(proposal.operation)}
            </h3>
            {receiptFile?.url && (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                role="link"
                render={<a href={receiptFile.url} target="_blank" rel="noopener noreferrer" />}
              >
                Open in {receiptFile.destination}
              </Button>
            )}
            {proposal.operation.kind === 'drive.files.upload' && (
              <GoogleUploadPreview operation={proposal.operation} submitted />
            )}
          </div>
        ) : (
          <OperationSummary operation={proposal.operation} />
        )}
        <Disclosure title="Details">
          {payload}
          {message && mutation.kind !== 'idle' && <p className="text-sm">{message}</p>}
        </Disclosure>
        {refused && (
          <StatePanel
            kind="error"
            title="This action cannot run"
            description="Google blocked this action before any write was sent. Ask for a new proposal, or reject this one to clear it."
          >
            <Button
              variant="outline"
              disabled={rejectBlocked || checking}
              onClick={() => void mutate('reject', proposal)}
            >
              Reject Google action
            </Button>
          </StatePanel>
        )}
        {(state.kind === 'approved' || (mutation.kind === 'pending' && mutation.action === 'execute')) && (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button
              disabled={blocked || checking}
              aria-busy={mutation.kind === 'pending'}
              onClick={() => void mutate('execute', proposal)}
            >
              {googleExecutionLabel(proposal.operation, mutation.kind === 'pending')}
            </Button>
            <span className="text-xs text-muted-foreground">Runs once · Can’t be undone here</span>
          </div>
        )}
        {(state.kind === 'review' || (mutation.kind === 'pending' && mutation.action !== 'execute')) && (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <Label>
              <Checkbox checked={confirmed} onCheckedChange={setConfirmed} disabled={blocked || checking} />
              {proposal.operation.kind === 'drive.files.upload'
                ? 'I reviewed the file and Details and authorize this exact change'
                : 'I reviewed Details and authorize this exact change'}
            </Label>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={blocked || checking || !confirmed}
                aria-busy={mutation.kind === 'pending' && mutation.action === 'approve'}
                onClick={() => void mutate('approve', proposal)}
              >
                {mutation.kind === 'pending' && mutation.action === 'approve'
                  ? 'Approving exact Google action…'
                  : 'Approve exact Google action'}
              </Button>
              <Button
                variant="outline"
                disabled={rejectBlocked || checking}
                aria-busy={mutation.kind === 'pending' && mutation.action === 'reject'}
                onClick={() => void mutate('reject', proposal)}
              >
                {mutation.kind === 'pending' && mutation.action === 'reject'
                  ? 'Rejecting Google action…'
                  : 'Reject Google action'}
              </Button>
            </div>
          </div>
        )}
      </section>
    );
  const statusTone = !proposal
    ? 'secondary'
    : proposal.receipt
      ? (
          {
            succeeded: 'success',
            failed: 'destructive',
            executing: 'warning',
            'outcome-unknown': 'destructive',
          } as const
        )[proposal.receipt.status]
      : proposal.decision === 'reject' || Date.parse(proposal.expiresAt) <= Date.now()
        ? 'secondary'
        : proposal.decision === 'approve'
          ? 'info'
          : 'warning';
  if (visual && proposal)
    return (
      <section aria-label="Exact Google action review" className="flex min-w-0 flex-col gap-4">
        <header className="flex items-center justify-between gap-3">
          <h4 ref={heading} tabIndex={-1} className="sr-only">
            Exact action review
          </h4>
          <Badge variant={mutation.kind !== 'idle' && state ? state.tone : statusTone}>
            {mutation.kind !== 'idle' ? state?.label : calendarActionStatus(proposal)}
          </Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Check Google action status"
            aria-label="Check Google action status"
            disabled={read.busy || mutation.kind === 'pending'}
            aria-busy={read.busy}
            onClick={() => void check()}
          >
            <Refresh size={16} />
          </Button>
        </header>
        {read.error && <GoogleReadFeedback busy={false} error={read.error} hasData title="Google action" />}
        {proposal.receipt?.status === 'succeeded' ? (
          calendarEnabled && currentEventId && showCurrent ? (
            <CalendarCurrentEvent
              key={currentEventId}
              workspaceId={workspaceId}
              proposal={proposal}
              eventId={currentEventId}
              compact
            />
          ) : (
            <CalendarActionOutcome proposal={proposal} />
          )
        ) : (
          <CalendarActionVisual
            workspaceId={workspaceId}
            proposal={proposal}
            operation={visual}
            compareEventId={calendarEnabled && !proposal.receipt ? currentEventId : null}
          />
        )}
        {proposal.receipt?.status === 'succeeded' && (
          <p role="status" className="sr-only">
            Google confirmed this action succeeded.
          </p>
        )}
        {proposal.receipt?.status === 'succeeded' && calendarEnabled && currentEventId && !showCurrent && (
          <div>
            <Button variant="outline" size="sm" onClick={() => setShowCurrent(true)}>
              <Refresh size={14} />
              Check event and Meet link
            </Button>
          </div>
        )}
        {proposal.receipt?.status === 'executing' && (
          <Alert>
            <AlertDescription>
              Execution may still be running. Check status before trying anything else.
            </AlertDescription>
          </Alert>
        )}
        {proposal.receipt?.status === 'outcome-unknown' && (
          <Alert variant="destructive">
            <AlertDescription>
              Google may have completed this action. Its outcome is unknown. Verify in Google before asking again.
            </AlertDescription>
          </Alert>
        )}
        {proposal.receipt?.status === 'failed' && (
          <Alert variant="destructive">
            <AlertDescription>Google rejected this request. It will not be retried.</AlertDescription>
          </Alert>
        )}
        {calendarBlocked && (
          <Alert>
            <AlertDescription>
              This calendar feature is not enabled for this workspace. You can review its saved status, but cannot
              approve or execute it here.
            </AlertDescription>
          </Alert>
        )}
        <Disclosure title="Details">{payload}</Disclosure>
        {!proposal.receipt &&
          mutation.kind !== 'uncertain' &&
          (proposal.decision === 'reject' ? (
            <p role="status" className="text-sm text-muted-foreground">
              Rejected. This action cannot run.
            </p>
          ) : Date.parse(proposal.expiresAt) <= Date.now() ? (
            <p className="text-sm text-muted-foreground">Expired. Ask in chat for a new proposal.</p>
          ) : proposal.decision === 'approve' ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button
                disabled={blocked}
                aria-busy={mutation.kind === 'pending'}
                onClick={() => void mutate('execute', proposal)}
              >
                Execute approved Google action
              </Button>
              <span className="text-xs text-muted-foreground">Runs once · Can't be undone here</span>
            </div>
          ) : (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <Label>
                <Checkbox checked={confirmed} onCheckedChange={setConfirmed} disabled={blocked} />I authorize this exact
                change
              </Label>
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={blocked || !confirmed}
                  aria-busy={mutation.kind === 'pending' && mutation.action === 'approve'}
                  onClick={() => void mutate('approve', proposal)}
                >
                  Approve exact Google action
                </Button>
                <Button
                  variant="outline"
                  disabled={rejectBlocked}
                  aria-busy={mutation.kind === 'pending' && mutation.action === 'reject'}
                  onClick={() => void mutate('reject', proposal)}
                >
                  Reject Google action
                </Button>
              </div>
            </div>
          ))}
        {message && (
          <Alert variant={mutation.kind === 'uncertain' || mutation.kind === 'refused' ? 'destructive' : 'default'}>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {refused && (
          <StatePanel
            kind="error"
            title="This action cannot run"
            description="Google refused this saved action before any write was dispatched. Ask for a new proposal, or reject this one to clear it."
          >
            <Button variant="outline" disabled={rejectBlocked} onClick={() => void mutate('reject', proposal)}>
              Reject Google action
            </Button>
          </StatePanel>
        )}
      </section>
    );
  return (
    <section
      aria-label="Exact Google action review"
      className="flex min-w-0 flex-col gap-4 border-t border-border pt-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h4 ref={heading} tabIndex={-1} className="font-medium">
          Exact action review
        </h4>
        <Button
          variant="outline"
          disabled={read.busy || mutation.kind === 'pending'}
          aria-busy={read.busy}
          onClick={() => void check()}
        >
          <span aria-hidden="true" className={read.busy ? 'animate-spin motion-reduce:animate-none' : undefined}>
            <Refresh size={16} />
          </span>
          Check Google action status
        </Button>
      </header>
      {!proposal && read.busy ? (
        <div role="status" aria-label="Loading Google action" className="space-y-3">
          <Skeleton shape="title" />
          <Skeleton />
          <Skeleton shape="panel" />
        </div>
      ) : read.state.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          title="Google action unavailable"
          description="This action is missing or you no longer have access. Use Check Google action status to check again."
        />
      ) : (
        <GoogleReadFeedback busy={read.busy} error={read.error} hasData={!!proposal} title="Google action" />
      )}
      {proposal && (
        <>
          <GoogleResultCard proposal={proposal} mutation={mutation} />
          {isCalendarAction(proposal.operation) ? (
            proposal.receipt?.status === 'succeeded' ? (
              <Disclosure title="Approved event details">
                <CalendarActionSummary operation={proposal.operation} />
              </Disclosure>
            ) : (
              <CalendarActionSummary operation={proposal.operation} />
            )
          ) : (
            <OperationSummary operation={proposal.operation} />
          )}
          {calendarEnabled && currentEventId && !proposal.receipt && (
            <CalendarCurrentEvent
              key={currentEventId}
              workspaceId={workspaceId}
              proposal={proposal}
              eventId={currentEventId}
            />
          )}
          {calendarBlocked && (
            <Alert>
              <AlertDescription>
                This calendar feature is not enabled for this workspace. You can review its saved status, but cannot
                approve or execute it here.
              </AlertDescription>
            </Alert>
          )}
          <Disclosure title="Exact payload and approval reference">{payload}</Disclosure>
          {proposal.receipt ? (
            <>
              <Badge variant={proposal.receipt.status === 'succeeded' ? 'success' : 'warning'}>
                {isCalendarAction(proposal.operation) ? calendarActionStatus(proposal) : proposal.receipt.status}
              </Badge>
              {proposal.receipt.status === 'executing' && (
                <Alert>
                  <AlertDescription>
                    An execution attempt is recorded. It may still be running or may have stopped. Check status. Never
                    resend or create a replacement until you have verified the outcome in Google.
                  </AlertDescription>
                </Alert>
              )}
              {proposal.receipt.status === 'outcome-unknown' && (
                <Alert variant="destructive">
                  <AlertDescription>
                    Google may have completed this action. Its outcome is unknown. Inspect Google or use a read-only
                    check. Never replay this action or approve a replacement without verifying the original outcome.
                  </AlertDescription>
                </Alert>
              )}
              {proposal.receipt.status === 'failed' && (
                <Alert variant="destructive">
                  <AlertDescription>
                    Google rejected this request. Inspect the request and its targets before asking for a new proposal.
                    This action will not be retried.
                  </AlertDescription>
                </Alert>
              )}
              {proposal.receipt.status === 'succeeded' && (
                <>
                  <p role="status">Google confirmed this action succeeded.</p>
                  {calendarEnabled && currentEventId && showCurrent ? (
                    <CalendarCurrentEvent
                      key={currentEventId}
                      workspaceId={workspaceId}
                      proposal={proposal}
                      eventId={currentEventId}
                    />
                  ) : (
                    <CalendarActionOutcome proposal={proposal} />
                  )}
                  {calendarEnabled && currentEventId && !showCurrent && (
                    <div>
                      <Button variant="outline" size="sm" onClick={() => setShowCurrent(true)}>
                        Check event and Meet link
                      </Button>
                    </div>
                  )}
                  {isCalendarAction(proposal.operation) ? (
                    <Disclosure title="Exact Google response">
                      <pre
                        aria-label="Google action result"
                        tabIndex={0}
                        className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-4 text-sm"
                      >
                        {JSON.stringify(proposal.receipt.result.data, null, 2)}
                      </pre>
                    </Disclosure>
                  ) : (
                    <pre
                      aria-label="Google action result"
                      tabIndex={0}
                      className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-4 text-sm"
                    >
                      {JSON.stringify(proposal.receipt.result.data, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </>
          ) : proposal.decision === 'reject' ? (
            <p role="status">Rejected. This action cannot run.</p>
          ) : Date.parse(proposal.expiresAt) <= Date.now() ? (
            <p>This proposal expired. Check its status before asking for a new proposal.</p>
          ) : proposal.decision === 'approve' ? (
            <div className="flex flex-col items-start gap-3">
              <p>
                Approved for this exact account, payload, and digest. Execution can change Google data and cannot be
                undone here.
              </p>
              <Button
                disabled={blocked}
                aria-busy={mutation.kind === 'pending'}
                onClick={() => void mutate('execute', proposal)}
              >
                Execute approved Google action
              </Button>
            </div>
          ) : (
            <>
              <Label>
                <Checkbox checked={confirmed} onCheckedChange={setConfirmed} disabled={blocked} />I reviewed the
                complete payload and authorize this exact Google action
              </Label>
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={blocked || !confirmed}
                  aria-busy={mutation.kind === 'pending' && mutation.action === 'approve'}
                  onClick={() => void mutate('approve', proposal)}
                >
                  Approve exact Google action
                </Button>
                <Button
                  variant="outline"
                  disabled={rejectBlocked}
                  aria-busy={mutation.kind === 'pending' && mutation.action === 'reject'}
                  onClick={() => void mutate('reject', proposal)}
                >
                  Reject Google action
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {message && (
        <Alert variant={mutation.kind === 'uncertain' || mutation.kind === 'refused' ? 'destructive' : 'default'}>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {refused && (
        <StatePanel
          kind="error"
          title="This action cannot run"
          description="Google refused this saved action before any write was dispatched. Ask for a new proposal based on the current Google file state, or reject this proposal to clear it."
        >
          <Button
            variant="outline"
            disabled={rejectBlocked}
            onClick={() => proposal && void mutate('reject', proposal)}
          >
            Reject Google action
          </Button>
        </StatePanel>
      )}
    </section>
  );
}
