import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LockKeyhole } from 'reicon-react/icons/LockKeyhole';
import { LockKeyholeOpen } from 'reicon-react/icons/LockKeyholeOpen';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { CheckboxField, Field } from '@tulipfarm/sprout/field';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tulipfarm/sprout/tooltip';
import { UnsavedChanges } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { useFeatureScope } from '@/lib/query';
import type { InformationRequest } from '@/features/chat/interaction-contracts';
import { secretErrorMessage } from './api';
import {
  destinationHosts,
  destinationLabel,
  kindLabels,
  placementError,
  placementPhrase,
  valueError,
  type Placement,
  type SecretRequestField,
  type SecretRequestView,
  type SecretValue,
  type SubmitField,
} from './contracts';
import {
  ExpiryPicker,
  PlacementEditor,
  SecretInput,
  emptyValue,
  expiryAt,
  expiryError,
  expiryPhrase,
  formatDate,
  type ExpiryChoice,
} from './fields';
import { useSecretRequest, useSecretsApi, useSecretsCapabilities, useSecretsChanges } from './queries';

type RequestContext = 'chat' | 'task';
type SecretsAnswer = Extract<NonNullable<InformationRequest['response']>['answer'], { kind: 'secrets' }>;

/**
 * A secrets request in the chat. Only the member it is addressed to can read its form; everyone else gets a
 * not-found from the API and sees the request's status only. Values go straight to the secrets API, never into
 * the conversation, and are cleared once sent.
 */
export function SecretRequestCard({
  request,
  onSettled,
  context = 'chat',
}: {
  request: InformationRequest;
  onSettled: () => Promise<void>;
  /** Where the request was made; a temporary value lasts for that chat or task run. */
  context?: RequestContext;
}) {
  const { status, expiresAt } = request;
  const secretRequestId = request.answerSchema.kind === 'secrets' ? request.answerSchema.secretRequestId : '';
  const answer = request.response?.answer.kind === 'secrets' ? request.response.answer : null;
  const id = useId();
  const scope = useFeatureScope();
  const workspaceId = scope.kind === 'workspace' ? scope.workspaceId : '';
  const pending = status === 'pending';
  const capabilities = useSecretsCapabilities(workspaceId, pending && !!workspaceId);
  const enabled = capabilities.state.kind === 'ready' && capabilities.state.data.enabled;
  const view = useSecretRequest(workspaceId, secretRequestId, pending && enabled);
  const viewStatus = view.state.kind === 'ready' ? view.state.data.status : null;
  const latestSettled = useRef(onSettled);
  latestSettled.current = onSettled;
  useEffect(() => {
    if (viewStatus && viewStatus !== 'waiting') void latestSettled.current();
  }, [viewStatus]);

  if (!pending) return <SettledStatus id={id} status={status} answer={answer} />;
  if (!workspaceId || capabilities.state.kind === 'unavailable' || view.state.kind === 'unavailable')
    return (
      <StatusLine id={id} title="Waiting for a secret">
        Only the person asked can answer.
      </StatusLine>
    );
  if (capabilities.state.kind === 'ready' && !capabilities.state.data.enabled)
    return (
      <StatusLine id={id} title="Secrets are turned off">
        Ask an admin to turn them on to answer this.
      </StatusLine>
    );
  if (capabilities.state.kind === 'error' || view.state.kind === 'error')
    return (
      <section
        aria-labelledby={`${id}-title`}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-3 py-2 text-sm text-card-foreground"
      >
        <h4 id={`${id}-title`} className="font-medium">
          Could not load this request
        </h4>
        <span className="text-muted-foreground">Check your connection.</span>
        <Button
          variant="link"
          size="sm"
          onClick={() => void (capabilities.state.kind === 'error' ? capabilities.refresh() : view.refresh())}
        >
          Try again
        </Button>
      </section>
    );
  if (view.state.kind !== 'ready')
    return (
      <div role="status" aria-label="Loading request" className="space-y-3">
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading request…</span>
      </div>
    );
  if (view.state.data.status !== 'waiting')
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Updating…
      </p>
    );
  return (
    <SecretRequestForm
      key={`${view.state.data.id}:${view.state.data.revision}`}
      workspaceId={workspaceId}
      view={view.state.data}
      context={context}
      expiresAt={expiresAt}
      refresh={async () => {
        await view.refresh();
      }}
      onSettled={onSettled}
    />
  );
}

function StatusLine({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl border border-border bg-card px-3 py-2 text-sm text-card-foreground"
    >
      <span className="text-muted-foreground">
        <LockKeyhole size={14} aria-hidden="true" />
      </span>
      <h4 id={`${id}-title`} className="font-medium">
        {title}
      </h4>
      {children && (
        <p role="status" className="min-w-0 text-muted-foreground">
          {children}
        </p>
      )}
    </section>
  );
}

function SettledStatus({
  id,
  status,
  answer,
}: {
  id: string;
  status: 'answered' | 'expired' | 'cancelled' | 'pending';
  answer: SecretsAnswer | null;
}) {
  if (status === 'answered' && answer?.status === 'provided')
    return (
      <StatusLine id={id} title={answer.references.length > 1 ? 'Secrets provided' : 'Secret provided'}>
        The agent can use {answer.references.length > 1 ? 'them' : 'it'} but never sees the value.
      </StatusLine>
    );
  if (status === 'answered' && answer?.status === 'declined')
    return <StatusLine id={id} title="Secret request declined" />;
  return <StatusLine id={id} title={status === 'expired' ? 'Secret request expired' : 'Secret request cancelled'} />;
}

type FieldDraft = {
  source: 'new' | 'saved';
  secretId: string;
  value: SecretValue;
  placement: Placement | null;
  editingPlacement: boolean;
};

function draftFor(field: SecretRequestField): FieldDraft {
  return {
    source: 'new',
    secretId: field.options[0]?.secretId ?? '',
    value: emptyValue(field.kind),
    placement: field.placement,
    editingPlacement: field.placement === null,
  };
}

function fieldProblems(field: SecretRequestField, draft: FieldDraft) {
  if (draft.source === 'saved') return { value: null, placement: null };
  return {
    value: valueError(draft.value),
    placement: draft.placement ? placementError(field.kind, draft.placement) : 'Choose how to send it.',
  };
}

function samePlacement(a: Placement | null, b: Placement | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function SecretRequestForm({
  workspaceId,
  view,
  context,
  expiresAt,
  refresh,
  onSettled,
}: {
  workspaceId: string;
  view: SecretRequestView;
  context: RequestContext;
  expiresAt: string;
  refresh: () => Promise<void>;
  onSettled: () => Promise<void>;
}) {
  const id = useId();
  const api = useSecretsApi(workspaceId);
  const changes = useSecretsChanges();
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(() =>
    Object.fromEntries(view.fields.map(field => [field.id, draftFor(field)])),
  );
  const [save, setSave] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryChoice>({ preset: '1d', custom: '' });
  const [editingExpiry, setEditingExpiry] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState<'submit' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  // Kept across retries of the same attempt, so a lost response replays instead of storing the values twice.
  const attempt = useRef<string | null>(null);
  const frozenExpiry = useRef<{ attempt: string; at: string | null } | null>(null);
  const single = view.fields.length === 1;
  const hosts = destinationHosts(view.destinations);
  const dirty = Object.values(drafts).some(draft =>
    'value' in draft.value ? !!draft.value.value : !!(draft.value.username || draft.value.password),
  );
  const update = (fieldId: string, change: Partial<FieldDraft>) => {
    attempt.current = null;
    setError(null);
    setDrafts(current => {
      const draft = current[fieldId];
      return draft ? { ...current, [fieldId]: { ...draft, ...change } } : current;
    });
  };
  const problems = Object.fromEntries(
    view.fields.map(field => [field.id, fieldProblems(field, drafts[field.id] ?? draftFor(field))]),
  );
  const anyNew = view.fields.some(field => (drafts[field.id] ?? draftFor(field)).source === 'new');
  const expiryProblem = anyNew ? expiryError(expiry) : null;
  const invalid = !!expiryProblem || Object.values(problems).some(problem => problem.value || problem.placement);
  const deleted = expiryPhrase(expiry);

  async function fail(failure: unknown) {
    if (failure instanceof TableRequestError && failure.status >= 400 && failure.status < 500) attempt.current = null;
    setError(secretErrorMessage(failure));
    if (failure instanceof TableRequestError && failure.code === 'secret-conflict') await refresh();
    if (failure instanceof TableRequestError && [404, 410].includes(failure.status)) await onSettled();
  }

  function reset() {
    setDrafts(Object.fromEntries(view.fields.map(field => [field.id, draftFor(field)])));
  }

  async function submit() {
    if (sending) return;
    setAttempted(true);
    if (invalid) {
      if (expiryProblem) setEditingExpiry(true);
      return;
    }
    attempt.current ??= crypto.randomUUID();
    if (frozenExpiry.current?.attempt !== attempt.current)
      frozenExpiry.current = { attempt: attempt.current, at: expiryAt(expiry) };
    const expiresAt = frozenExpiry.current.at;
    const fields: SubmitField[] = view.fields.map(field => {
      const draft = drafts[field.id] ?? draftFor(field);
      if (draft.source === 'saved') return { fieldId: field.id, secretId: draft.secretId };
      return {
        fieldId: field.id,
        value: draft.value,
        lifetime: save ? 'saved' : 'conversation',
        expiresAt,
        ...(draft.placement && !samePlacement(draft.placement, field.placement) ? { placement: draft.placement } : {}),
      };
    });
    setSending('submit');
    setError(null);
    try {
      await api.submit(view.id, { requestId: attempt.current, expectedRevision: view.revision, fields });
      reset();
      await Promise.all([changes.changed(), onSettled()]);
    } catch (failure) {
      await fail(failure);
    } finally {
      setSending(null);
    }
  }

  async function decline() {
    if (sending) return;
    attempt.current ??= crypto.randomUUID();
    setSending('decline');
    setError(null);
    try {
      await api.decline(view.id, {
        requestId: attempt.current,
        expectedRevision: view.revision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      reset();
      await onSettled();
    } catch (failure) {
      await fail(failure);
    } finally {
      setSending(null);
    }
  }

  const locked = sending !== null;
  const errorAlert = error && (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="question-panel space-y-3 rounded-xl border border-border bg-card px-3 py-3 text-card-foreground"
    >
      <UnsavedChanges dirty={dirty || !!reason} />
      <div className="space-y-0.5">
        <h4 id={`${id}-title`} className="flex items-center gap-2 text-sm font-medium">
          <LockKeyhole size={16} aria-hidden="true" />
          <span className="min-w-0 break-words">
            {single ? `The agent needs your ${view.fields[0]?.label}` : `The agent needs ${view.fields.length} secrets`}
          </span>
        </h4>
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{view.purpose}</p>
        {!single && <p className="text-xs text-muted-foreground">Sent only to {hosts}</p>}
        {view.destinations.some(destination => destination.plainHttp) && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <LockKeyholeOpen size={14} aria-hidden="true" />
            Sent without encryption
          </p>
        )}
      </div>
      {declining ? (
        <form
          className="space-y-3"
          onSubmit={event => {
            event.preventDefault();
            void decline();
          }}
        >
          <Field optional label="Reason" helper="The agent sees this." disabled={locked}>
            <Textarea value={reason} maxLength={500} onChange={event => setReason(event.target.value)} />
          </Field>
          {errorAlert}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => setDeclining(false)}>
              Back
            </Button>
            <Button type="submit" variant="destructive" size="sm" disabled={locked} aria-busy={sending === 'decline'}>
              {sending === 'decline' ? 'Declining…' : 'Decline request'}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="space-y-3"
          noValidate
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          {view.fields.map(field => (
            <RequestField
              key={field.id}
              field={field}
              view={view}
              context={context}
              draft={drafts[field.id] ?? draftFor(field)}
              problems={attempted ? problems[field.id] : undefined}
              disabled={locked}
              update={change => update(field.id, change)}
            />
          ))}
          {anyNew && (
            <div className="space-y-2">
              <CheckboxField
                label="Save to my secrets"
                checked={save}
                disabled={locked}
                onCheckedChange={checked => {
                  attempt.current = null;
                  setError(null);
                  setSave(checked);
                  setExpiry(current =>
                    checked && current.preset === '1d'
                      ? { ...current, preset: 'none' }
                      : !checked && current.preset === 'none'
                        ? { ...current, preset: '1d' }
                        : current,
                  );
                }}
                helper={
                  <>
                    {save
                      ? `Reuse it in other chats and share it from settings. ${deleted ? `Deleted ${deleted}.` : 'Kept until you delete it.'}`
                      : context === 'task'
                        ? `Used only for this task run, deleted when the run ends or ${deleted ?? 'in 1 day'}, whichever is first.`
                        : `Used only in this chat, deleted ${deleted ?? 'in 1 day'}.`}{' '}
                    <Button
                      variant="link"
                      size="sm"
                      disabled={locked}
                      aria-expanded={editingExpiry}
                      aria-controls={`${id}-expiry`}
                      onClick={() => setEditingExpiry(!editingExpiry)}
                    >
                      {editingExpiry ? 'Done' : 'Change'}
                    </Button>
                  </>
                }
              />
              {editingExpiry && (
                <div id={`${id}-expiry`} className="pl-6">
                  <ExpiryPicker
                    label="Delete it"
                    labelVisibility="screen-reader"
                    allowNone={save}
                    value={expiry}
                    error={attempted ? expiryProblem : null}
                    disabled={locked}
                    onChange={next => {
                      attempt.current = null;
                      setError(null);
                      setExpiry(next);
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {errorAlert}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LockKeyhole size={12} aria-hidden="true" />
              Only you can see this. The agent never sees the value.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" disabled={locked} onClick={() => setDeclining(true)}>
                Decline
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={<Button type="submit" size="sm" disabled={locked} aria-busy={sending === 'submit'} />}
                >
                  {sending === 'submit' ? 'Sending…' : single ? 'Provide secret' : 'Provide secrets'}
                </TooltipTrigger>
                <TooltipContent>Answer by {formatDate(expiresAt)}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}

function RequestField({
  field,
  view,
  context,
  draft,
  problems,
  disabled,
  update,
}: {
  field: SecretRequestField;
  view: SecretRequestView;
  context: RequestContext;
  draft: FieldDraft;
  problems: ReturnType<typeof fieldProblems> | undefined;
  disabled: boolean;
  update: (change: Partial<FieldDraft>) => void;
}) {
  const id = useId();
  const single = view.fields.length === 1;
  const hosts = destinationHosts(view.destinations);
  const selected = field.options.find(option => option.secretId === draft.secretId);
  const pair = 'username' in draft.value ? draft.value : null;
  const where = single ? `Sent only to ${hosts}` : 'Sent';
  const savedLink = field.options.length > 0 && (
    <Button variant="link" size="sm" disabled={disabled} onClick={() => update({ source: 'saved' })}>
      Use a saved secret instead
    </Button>
  );
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="space-y-1.5">
      <Label id={`${id}-label`} htmlFor={draft.source === 'new' && !pair ? `${id}-value` : undefined}>
        {field.label}
        <span className="font-normal text-muted-foreground"> · {kindLabels[field.kind]}</span>
      </Label>
      {draft.source === 'saved' ? (
        <>
          <Select
            value={draft.secretId}
            disabled={disabled}
            onValueChange={secretId => {
              if (secretId) update({ secretId });
            }}
          >
            <SelectTrigger width="full" aria-labelledby={`${id}-label`}>
              <SelectValue>{selected?.name ?? 'Choose a secret'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {field.options.map(option => (
                <SelectItem key={option.secretId} value={option.secretId}>
                  {option.lifetime === 'conversation'
                    ? `${option.name} (${context === 'task' ? 'this run only' : 'this chat only'})`
                    : option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs text-muted-foreground">
            {selected && (
              <span>
                {where} {placementPhrase(selected.placement)}
                {selected.expiresAt ? `, deleted on ${formatDate(selected.expiresAt)}` : ''}.
              </span>
            )}
            <Button variant="link" size="sm" disabled={disabled} onClick={() => update({ source: 'new' })}>
              Enter a new value
            </Button>
          </div>
        </>
      ) : (
        <>
          {pair ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <SecretInput
                id={`${id}-username`}
                label={`${field.label} username`}
                placeholder="Username"
                masked={false}
                value={pair.username}
                disabled={disabled}
                onChange={username => update({ value: { ...pair, username } })}
              />
              <SecretInput
                id={`${id}-value`}
                label={`${field.label} password`}
                placeholder="Password"
                value={pair.password}
                disabled={disabled}
                invalid={!!problems?.value}
                describedBy={problems?.value ? `${id}-error` : undefined}
                onChange={password => update({ value: { ...pair, password } })}
              />
            </div>
          ) : (
            <SecretInput
              id={`${id}-value`}
              value={'value' in draft.value ? draft.value.value : ''}
              disabled={disabled}
              invalid={!!problems?.value}
              describedBy={problems?.value ? `${id}-error` : undefined}
              onChange={value => update({ value: { value } })}
            />
          )}
          {problems?.value && (
            <p id={`${id}-error`} className="text-xs text-destructive">
              {problems.value}
            </p>
          )}
          {draft.placement && !draft.editingPlacement && (
            <div className="flex flex-wrap items-center justify-between gap-x-2">
              <p className="flex flex-wrap items-center text-xs text-muted-foreground">
                <span>
                  {where} {placementPhrase(draft.placement)}
                </span>
                <Button
                  variant="link"
                  size="sm"
                  disabled={disabled}
                  aria-expanded={false}
                  aria-controls={`${id}-placement`}
                  onClick={() => update({ editingPlacement: true })}
                >
                  Change
                </Button>
              </p>
              {savedLink}
            </div>
          )}
          {draft.editingPlacement && (
            <div id={`${id}-placement`} className="space-y-2 rounded-lg bg-muted px-3 py-2">
              <p className="text-sm font-medium">How should this be sent?</p>
              <PlacementEditor
                compact
                kind={field.kind}
                value={draft.placement}
                disabled={disabled}
                error={problems?.placement}
                onChange={placement => update({ placement })}
              />
              <div className="text-xs text-muted-foreground">
                <p>Only sent to:</p>
                <ul>
                  {view.destinations.map(destination => (
                    <li key={`${destination.kind}:${destination.value}`} className="break-all">
                      {destinationLabel(destination)}
                      {destination.plainHttp && ' · sent without encryption'}
                    </li>
                  ))}
                </ul>
              </div>
              {field.placement !== null && (
                <div className="flex flex-wrap gap-1">
                  {!samePlacement(draft.placement, field.placement) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => update({ placement: field.placement, editingPlacement: false })}
                    >
                      Use the agent's suggestion
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || !draft.placement || !!placementError(field.kind, draft.placement)}
                    aria-expanded
                    aria-controls={`${id}-placement`}
                    onClick={() => update({ editingPlacement: false })}
                  >
                    Done
                  </Button>
                </div>
              )}
            </div>
          )}
          {draft.editingPlacement && savedLink && <div className="flex justify-end">{savedLink}</div>}
        </>
      )}
    </div>
  );
}
