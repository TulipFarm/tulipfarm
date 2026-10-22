import { useRef, useState } from 'react';
import { Refresh } from 'reicon-react/icons/Refresh';
import { heartbeatSettingsSchema, type HeartbeatSettings } from '@tulipfarm/google-workspace/public-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@tulipfarm/sprout/collapsible';
import { Badge } from '@tulipfarm/sprout/badge';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  googleApi,
  googleError,
  googleAccessLost,
  GoogleRequestError,
  type HeartbeatCommand,
  type HeartbeatView,
  type HeartbeatRetry,
} from '@/lib/google-workspace';
import { GoogleReadFeedback } from './read';
import { useGoogleHeartbeat, useGoogleResults, useIntegrationChanges } from '@/features/integrations/queries';

export function GoogleHeartbeat({ workspaceId, available }: { workspaceId: string; available: boolean }) {
  const read = useGoogleHeartbeat(workspaceId);
  return (
    <section aria-labelledby="heartbeat-heading" className="flex min-w-0 flex-col gap-4 border-t border-border pt-5">
      <h3 id="heartbeat-heading" className="font-medium">
        Gmail heartbeat
      </h3>
      <p className="max-w-prose text-muted-foreground">
        Periodically process new matching mail into private answers. Heartbeat cannot send mail or take Google actions.
        Processing continues when you leave this page and uses workspace credits.
      </p>
      <GoogleReadFeedback busy={read.busy} error={read.error} hasData={!!read.data} title="heartbeat settings" />
      {!read.data && (
        <Button variant="outline" disabled={read.busy} onClick={() => void read.refresh()}>
          Retry heartbeat settings
        </Button>
      )}
      {read.data && <HeartbeatForm workspaceId={workspaceId} initial={read.data} available={available} />}
    </section>
  );
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; command: HeartbeatCommand }
  | { kind: 'uncertain'; command: HeartbeatCommand };
function settings(view: HeartbeatView): HeartbeatSettings {
  return {
    enabled: view.enabled,
    cadenceMinutes: view.cadenceMinutes,
    query: view.query,
    labelId: view.labelId,
    instructions: view.instructions,
  };
}
function HeartbeatForm({
  workspaceId,
  initial,
  available,
}: {
  workspaceId: string;
  initial: HeartbeatView;
  available: boolean;
}) {
  const read = useGoogleHeartbeat(workspaceId);
  const changes = useIntegrationChanges();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<HeartbeatSettings>(() => settings(initial));
  const [cadence, setCadence] = useState(String(initial.cadenceMinutes));
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const [checking, setChecking] = useState(false);
  const [readError, setReadError] = useState(false);
  const [denied, setDenied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const lock = useRef(false);
  const disabled = !available || state.kind !== 'idle' || checking || readError;
  async function save(command?: HeartbeatCommand) {
    if (lock.current || !available || checking) return;
    const parsed = heartbeatSettingsSchema.safeParse({ ...draft, cadenceMinutes: Number(cadence) });
    if (!parsed.success) {
      setFieldError(
        'Use a whole-number cadence from 1 to 1440 and a label ID containing only letters, numbers, underscores, or hyphens.',
      );
      return;
    }
    const pending = command ?? { ...parsed.data, revision: saved.revision, commandId: crypto.randomUUID() };
    lock.current = true;
    setState({ kind: 'saving', command: pending });
    setMessage(null);
    setFieldError(null);
    try {
      const result = await googleApi.saveHeartbeat(workspaceId, pending);
      await changes.content('google');
      setSaved(result);
      setDraft(settings(result));
      setCadence(String(result.cadenceMinutes));
      setState({ kind: 'idle' });
      setReadError(false);
      setMessage('Heartbeat settings saved.');
    } catch (error) {
      setState({ kind: 'uncertain', command: pending });
      setDenied(googleAccessLost(error));
      setMessage(googleError(error));
    } finally {
      lock.current = false;
    }
  }
  async function check(replace: boolean) {
    if (lock.current) return;
    lock.current = true;
    setChecking(true);
    setMessage(null);
    try {
      const result = await read.refresh();
      if (!result) throw new Error('Heartbeat status unavailable');
      setReadError(false);
      setDenied(false);
      if (replace) {
        setSaved(result);
        setDraft(settings(result));
        setCadence(String(result.cadenceMinutes));
        setState({ kind: 'idle' });
        setMessage('Saved settings loaded. Unsaved edits were replaced.');
      } else {
        setMessage(
          `Saved revision ${result.revision} is ${result.enabled ? 'enabled' : 'disabled'}. Your draft is retained. Recover the saved request with its original command ID, or load saved settings to replace your draft.`,
        );
      }
    } catch (error) {
      setReadError(true);
      setDenied(googleAccessLost(error));
      setMessage(googleError(error));
    } finally {
      lock.current = false;
      setChecking(false);
    }
  }
  if (denied)
    return (
      <StatePanel
        kind="unavailable"
        title="Heartbeat settings unavailable"
        description={message ?? 'Check your current membership and reconnect Google.'}
      >
        <Button variant="outline" disabled={checking} onClick={() => void check(true)}>
          Check saved settings again
        </Button>
      </StatePanel>
    );
  return (
    <>
      <form
        aria-label="Gmail heartbeat settings"
        onSubmit={event => {
          event.preventDefault();
          if (!disabled) void save();
        }}
        className="flex min-w-0 flex-col gap-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={saved.state === 'ready' ? 'success' : 'secondary'}>{saved.state}</Badge>
          <p className="text-sm text-muted-foreground">Saved revision {saved.revision}</p>
        </div>
        {saved.state === 'reconnect-required' && (
          <Alert>
            <AlertDescription>
              Reconnect Google and save these settings again to bind future processing to the current account.
            </AlertDescription>
          </Alert>
        )}
        {saved.gapNotice && (
          <Alert>
            <AlertDescription>
              Google history expired. Available matching mail is being recovered. Permanently deleted mail cannot be
              recovered.
            </AlertDescription>
          </Alert>
        )}
        {saved.lastError && (
          <Alert variant="destructive">
            <AlertDescription>
              Polling is unavailable. Check Google status, narrow your filter, or save updated settings. Diagnostic
              code: {saved.lastError}
            </AlertDescription>
          </Alert>
        )}
        <Label>
          <Checkbox
            checked={draft.enabled}
            disabled={disabled}
            onCheckedChange={enabled => setDraft({ ...draft, enabled })}
          />
          Enable Gmail heartbeat
        </Label>
        <p className="text-sm text-muted-foreground">
          Enabling starts with new mail, not your existing inbox. Reenabling takes a new baseline. Saving changes
          cancels unfinished items but preserves completed results for this integration.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="heartbeat-cadence">Check every, in minutes</Label>
            <Input
              id="heartbeat-cadence"
              type="number"
              min={1}
              max={1440}
              step={1}
              required
              value={cadence}
              disabled={disabled}
              aria-describedby="heartbeat-validation"
              aria-invalid={!!fieldError}
              onChange={event => setCadence(event.target.value)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="heartbeat-label">Gmail label ID, optional</Label>
            <Input
              id="heartbeat-label"
              value={draft.labelId ?? ''}
              maxLength={128}
              disabled={disabled}
              aria-describedby="heartbeat-label-help heartbeat-validation"
              aria-invalid={!!fieldError}
              onChange={event => setDraft({ ...draft, labelId: event.target.value || null })}
            />
          </div>
        </div>
        <p id="heartbeat-label-help" className="text-sm text-muted-foreground">
          Use a Gmail API label ID such as INBOX, or leave it blank. For a named custom label, use label:your-label in
          the Gmail query instead.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="heartbeat-query">Gmail query</Label>
          <Input
            id="heartbeat-query"
            value={draft.query}
            maxLength={1024}
            disabled={disabled}
            aria-describedby="heartbeat-query-help"
            onChange={event => setDraft({ ...draft, query: event.target.value })}
          />
        </div>
        <p id="heartbeat-query-help" className="text-sm text-muted-foreground">
          Use Gmail search syntax, for example from:billing@example.com. A blank query matches all new mail, subject to
          the optional label.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="heartbeat-instructions">Processing instructions</Label>
          <Textarea
            id="heartbeat-instructions"
            value={draft.instructions}
            maxLength={8000}
            disabled={disabled}
            onChange={event => setDraft({ ...draft, instructions: event.target.value })}
          />
        </div>
        <p id="heartbeat-validation" role={fieldError ? 'alert' : undefined} className="text-destructive">
          {fieldError}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={disabled} aria-busy={state.kind === 'saving'}>
            Save heartbeat settings
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={checking || state.kind === 'saving'}
            aria-busy={checking}
            onClick={() => void check(false)}
          >
            Check heartbeat status
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={checking || state.kind === 'saving'}
            onClick={() => void check(true)}
          >
            Load saved settings
          </Button>
        </div>
        {state.kind === 'uncertain' && (
          <>
            <Alert variant="destructive">
              <AlertDescription>
                The save response was not confirmed. Your exact request and command ID are retained in this tab. Check
                status before making changes. Recovery resubmits only this same idempotent request, never a new command.
              </AlertDescription>
            </Alert>
            <Button
              type="button"
              variant="outline"
              disabled={!available || checking}
              onClick={() => void save(state.command)}
            >
              Recover saved heartbeat request
            </Button>
          </>
        )}
        {message && (
          <Alert variant={readError ? 'destructive' : 'default'}>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        <p className="text-sm text-muted-foreground">
          Unsaved edits and unconfirmed command recovery are kept only in this tab. Loading saved settings replaces
          them.
        </p>
      </form>
      <HeartbeatResults workspaceId={workspaceId} available={!disabled} revision={saved.revision} />
    </>
  );
}

type RetryState =
  | { kind: 'idle' }
  | { kind: 'pending' | 'uncertain' | 'accepted'; command: HeartbeatRetry }
  | { kind: 'rejected'; command: HeartbeatRetry; message: string };

function queuedExplanation(error: string | null) {
  switch (error) {
    case 'model-configuration':
      return 'Waiting for model setup. Ask your operator to check the processing model configuration.';
    case 'model-disabled':
      return 'Waiting for an enabled model. Ask a workspace administrator to enable the processing model.';
    case 'credits-exhausted':
      return 'Waiting for workspace credits. Ask a workspace administrator to restore available credits.';
    default:
      return null;
  }
}

function HeartbeatResults({
  workspaceId,
  available,
  revision,
}: {
  workspaceId: string;
  available: boolean;
  revision: number;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const read = useGoogleResults(workspaceId, cursor);
  const configurationRead = useGoogleHeartbeat(workspaceId);
  const changes = useIntegrationChanges();
  const [retry, setRetry] = useState<RetryState>({ kind: 'idle' });
  const retryLock = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const blocked = !available || read.busy || !!read.error || retry.kind === 'pending' || retry.kind === 'uncertain';
  const configuration = configurationRead.data;
  const enabled =
    configuration?.revision === revision &&
    configuration.enabled &&
    configuration.state === 'ready' &&
    !configurationRead.error;
  async function submitRetry(command: HeartbeatRetry) {
    if (retryLock.current || !available || read.busy || read.error) return;
    retryLock.current = true;
    setRetry({ kind: 'pending', command });
    try {
      await googleApi.retryHeartbeat(workspaceId, command);
      await changes.content('google');
      setRetry({ kind: 'accepted', command });
    } catch (error) {
      if (error instanceof GoogleRequestError && error.status >= 400 && error.status < 500) {
        setRetry({
          kind: 'rejected',
          command,
          message:
            error.code === 'heartbeat-stale'
              ? 'The heartbeat settings or account binding changed. Load saved settings and check Google status before continuing.'
              : googleError(error),
        });
        await Promise.all([read.refresh(), configurationRead.refresh()]);
      } else setRetry({ kind: 'uncertain', command });
    } finally {
      retryLock.current = false;
      feedback.current?.focus();
    }
  }
  return (
    <section
      aria-labelledby="heartbeat-results-heading"
      className="flex min-w-0 flex-col gap-4 border-t border-border pt-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h4 id="heartbeat-results-heading" className="font-medium">
          Your private heartbeat results
        </h4>
        <Button
          variant="outline"
          disabled={read.busy || retry.kind === 'pending'}
          aria-busy={read.busy}
          onClick={() => void read.refresh()}
        >
          <span aria-hidden="true" className={read.busy ? 'animate-spin motion-reduce:animate-none' : undefined}>
            <Refresh size={16} />
          </span>
          Refresh heartbeat results
        </Button>
      </header>
      <p className="text-muted-foreground">
        These are persisted private processing results, not chat conversations. Only your current membership and
        connected account can read them.
      </p>
      <GoogleReadFeedback busy={read.busy} error={read.error} hasData={!!read.data} title="heartbeat results" />
      <div ref={feedback} tabIndex={-1} aria-label="Heartbeat retry status" className="flex flex-col gap-3">
        {retry.kind === 'pending' && <p role="status">Requesting processing retry…</p>}
        {retry.kind === 'accepted' && (
          <p role="status">Processing retry accepted. Refresh results to check progress.</p>
        )}
        {retry.kind === 'rejected' && (
          <Alert variant="destructive">
            <AlertDescription>Processing retry was rejected. {retry.message}</AlertDescription>
          </Alert>
        )}
        {retry.kind === 'uncertain' && (
          <>
            <Alert variant="destructive">
              <AlertDescription>
                The retry response was not confirmed. Your exact command is retained in this tab, even when you refresh
                results. Recovery resends that same command and cannot queue it twice. Leaving this page loses this
                local recovery command.
              </AlertDescription>
            </Alert>
            <Button
              variant="outline"
              disabled={
                !available ||
                read.busy ||
                !!read.error ||
                !enabled ||
                configuration?.revision !== retry.command.revision
              }
              onClick={() => void submitRetry(retry.command)}
            >
              Recover processing retry
            </Button>
          </>
        )}
      </div>
      {read.data && (
        <>
          {!read.data.results.length && (
            <StatePanel
              kind="empty"
              title="No heartbeat results yet"
              description="Enable heartbeat above. New matching mail will appear after a scheduled check. Existing inbox messages are not processed on initial enable."
            />
          )}
          <ol className="divide-y divide-border">
            {read.data.results.map(result => {
              const waiting = result.status === 'queued' ? queuedExplanation(result.error) : null;
              const canRetry = result.status === 'failed' && enabled && result.revision === configuration?.revision;
              return (
                <li key={result.id} className="flex min-w-0 flex-col gap-3 py-4">
                  <header className="flex flex-wrap items-center gap-3">
                    <Badge
                      variant={
                        result.status === 'succeeded'
                          ? 'success'
                          : result.status === 'failed'
                            ? 'destructive'
                            : 'secondary'
                      }
                    >
                      {result.status}
                    </Badge>
                    <time className="text-sm text-muted-foreground" dateTime={result.createdAt}>
                      {new Date(result.createdAt).toLocaleString()}
                    </time>
                  </header>
                  <p className="break-all text-sm">
                    Message {result.messageId} · Settings revision {result.revision}
                  </p>
                  {result.answer !== null && <p className="whitespace-pre-wrap break-words">{result.answer}</p>}
                  {result.status === 'queued' && (
                    <p>
                      {waiting
                        ? `${waiting} No model request was sent for this check and no processing attempt was consumed. Heartbeat automatically checks again after five minutes and resumes when the issue is resolved. No manual retry is needed.`
                        : 'Waiting for processing. Refresh results after the next worker check.'}
                    </p>
                  )}
                  {result.status === 'processing' && (
                    <p>Processing continues in the background. Refresh results to check completion.</p>
                  )}
                  {result.status === 'failed' && (
                    <>
                      <p>
                        {result.error === 'processing-outcome-unknown'
                          ? 'The previous processing outcome is unknown.'
                          : 'Processing failed.'}{' '}
                        There is no automatic retry.
                      </p>
                      {canRetry ? (
                        <>
                          <p id={`retry-warning-${result.id}`} className="max-w-prose text-muted-foreground">
                            The previous attempt may have incurred usage. Retrying may use more workspace credits. It
                            uses the original message and instructions, without tools or sending mail.
                          </p>
                          <div>
                            <Button
                              variant="outline"
                              disabled={blocked}
                              aria-busy={retry.kind === 'pending' && retry.command.itemId === result.id}
                              aria-describedby={`retry-warning-${result.id}`}
                              onClick={() =>
                                void submitRetry({
                                  commandId: crypto.randomUUID(),
                                  itemId: result.id,
                                  revision: result.revision,
                                })
                              }
                            >
                              Retry processing
                            </Button>
                          </div>
                        </>
                      ) : (
                        <p className="text-muted-foreground">
                          This item cannot be retried because its settings revision is no longer the current enabled
                          configuration.
                        </p>
                      )}
                    </>
                  )}
                  {result.status === 'cancelled' && <p>Cancelled because configuration or account access changed.</p>}
                  {result.error && (
                    <p className="break-words text-sm text-muted-foreground">Diagnostic code: {result.error}</p>
                  )}
                  <Collapsible>
                    <CollapsibleTrigger render={<Button variant="ghost" />}>
                      Instructions used for this result
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="whitespace-pre-wrap break-words pt-2">{result.instructions}</p>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap gap-3">
            {cursor && (
              <Button
                variant="outline"
                disabled={read.busy || retry.kind === 'pending'}
                onClick={() => setCursor(null)}
              >
                Newest heartbeat results
              </Button>
            )}
            {read.data.nextCursor && (
              <Button
                variant="outline"
                disabled={read.busy || !!read.error || retry.kind === 'pending'}
                onClick={() => setCursor(read.data?.nextCursor ?? null)}
              >
                Older heartbeat results
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
