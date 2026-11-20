import { useEffect, useRef, useState } from 'react';
import {
  personalMemoryMaximumCharacters,
  personalMemorySchema,
  savePersonalMemorySchema,
  type PersonalMemory,
} from '@tulipfarm/conversations/personal-memory-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Alert } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { UnsavedChanges } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { settingsRequest } from './api';
import { MemoryProposals } from './memory-proposals';

type State =
  | { kind: 'loading' }
  | { kind: 'load-error' }
  | { kind: 'unavailable' }
  | { kind: 'hidden' }
  | { kind: 'service-unavailable' }
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'changed'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'uncertain' }
  | { kind: 'checking' }
  | { kind: 'conflict'; latest: PersonalMemory };

export function PersonalMemoryEditor({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [saved, setSaved] = useState<PersonalMemory | null>(null);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const active = useRef<AbortController | null>(null);
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/personal-memory`;
  const characters = Array.from(draft).length;
  const dirty = saved !== null && draft !== saved.content;
  const pending = state.kind === 'saving' || state.kind === 'checking';
  const unresolved = pending || state.kind === 'conflict' || state.kind === 'uncertain';
  const accept = (value: PersonalMemory) => {
    setSaved(value);
    setDraft(value.content);
    setInvalid(false);
  };

  async function read(check = false) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: check ? 'checking' : 'loading' });
    try {
      const result = personalMemorySchema.parse(
        await settingsRequest(path, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])),
      );
      if (controller.signal.aborted) return;
      if (!check) {
        accept(result);
        setState({ kind: 'ready' });
      } else if (result.content === (draft.trim() ? draft : '')) {
        accept(result);
        setState({ kind: 'saved' });
      } else setState({ kind: 'conflict', latest: result });
    } catch (error) {
      if (controller.signal.aborted) return;
      const denied = error instanceof TableRequestError && [401, 403, 404].includes(error.status);
      const code = error instanceof TableRequestError ? error.code : undefined;
      setState(
        denied
          ? { kind: 'unavailable' }
          : code === 'personal-memory-hidden'
            ? { kind: 'hidden' }
            : !check && code === 'personal-memory-unavailable'
              ? { kind: 'service-unavailable' }
              : { kind: check ? 'uncertain' : 'load-error' },
      );
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  useEffect(() => {
    void read();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, []);

  async function save() {
    if (!saved || active.current || unresolved) return;
    const parsed = savePersonalMemorySchema.safeParse({ content: draft, expectedRevision: saved.revision });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'saving' });
    try {
      const result = personalMemorySchema.parse(
        await settingsRequest(
          path,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          'PUT',
          parsed.data,
        ),
      );
      if (controller.signal.aborted) return;
      // Revisions only grow; with history they can grow by more than one.
      if (result.revision <= saved.revision || result.content !== (draft.trim() ? draft : ''))
        throw new Error('Unconfirmed memory save');
      accept(result);
      setState({ kind: 'saved' });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof TableRequestError && [401, 403, 404].includes(error.status))
        setState({ kind: 'unavailable' });
      else if (
        error instanceof TableRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 409, 429].includes(error.status)
      ) {
        setState({
          kind: 'error',
          message: 'Your memory was not saved. Check the text and try again. Your draft is kept.',
        });
      } else setState({ kind: 'uncertain' });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  /** Undo, delete or forget, each checked against the revision on screen. */
  async function change(action: 'undo' | 'delete' | 'forget') {
    if (!saved || active.current || unresolved || dirty) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'saving' });
    try {
      const result = personalMemorySchema.parse(
        await settingsRequest(
          action === 'delete' ? path : `${path}/${action}`,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          action === 'delete' ? 'DELETE' : 'POST',
          { expectedRevision: saved.revision },
        ),
      );
      if (controller.signal.aborted) return;
      accept(result);
      setState({
        kind: 'changed',
        message:
          action === 'forget'
            ? 'Memory forgotten permanently, including its history.'
            : action === 'delete'
              ? 'Memory deleted. You can restore it for 7 days.'
              : saved.history?.trashed
                ? 'Memory restored.'
                : 'Last change undone.',
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = error instanceof TableRequestError ? error.status : undefined;
      setState({
        kind: 'error',
        message:
          status === 409
            ? 'Your memory changed, or this can’t be undone. Nothing changed. Reload the page to see the latest version.'
            : status === 503
              ? 'Memory can’t be reached right now. Nothing changed. Try again in a moment.'
              : 'We could not confirm this change. Reload the page to see your memory.',
      });
    } finally {
      if (active.current === controller) active.current = null;
      setForgetting(false);
    }
  }
  const history = saved?.history;

  return (
    <FormSection
      title="Personal memory"
      description={`Your reply preferences in ${workspaceName}. Private to you in this workspace; not a summary of your chats.`}
    >
      <UnsavedChanges dirty={dirty && !pending} />
      {state.kind === 'loading' ? (
        <StatePanel
          kind="loading"
          heading="h3"
          title="Loading your memory"
          description="Checking your saved preferences."
        />
      ) : state.kind === 'load-error' ? (
        <StatePanel
          kind="error"
          heading="h3"
          title="Memory could not load"
          description="Your saved preferences have not changed."
        >
          <Button variant="outline" onClick={() => void read()}>
            Retry loading memory
          </Button>
        </StatePanel>
      ) : state.kind === 'service-unavailable' ? (
        <StatePanel
          kind="error"
          heading="h3"
          title="Memory can’t be reached"
          description="The memory service isn’t answering. Your saved preferences have not changed."
        >
          <Button variant="outline" onClick={() => void read()}>
            Retry loading memory
          </Button>
        </StatePanel>
      ) : state.kind === 'hidden' ? (
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Memory is turned off"
          description="Memory is turned off in this workspace. What you saved is kept but not used or shown."
        />
      ) : state.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Memory is unavailable"
          description="Check your workspace access before editing your preferences."
        />
      ) : (
        <>
          <Form
            label="Personal memory"
            disabled={pending}
            onSubmit={() => {
              if (
                !savePersonalMemorySchema.safeParse({ content: draft, expectedRevision: saved?.revision ?? 0 }).success
              ) {
                setInvalid(true);
                return 'invalid';
              }
              void save();
            }}
          >
            <div className="grid gap-4">
              {saved?.content === '' && !history?.trashed && (
                <p className="text-sm text-muted-foreground">
                  No preferences saved yet. Add your own, or tell Bud how you like replies.{' '}
                  {history
                    ? 'Closed chats are checked in the background, and changes are suggested below for you to review.'
                    : 'Closed chats are checked in the background.'}
                </p>
              )}
              <Field
                id="personal-memory"
                label="Your preferences"
                optional
                counter={`${characters.toLocaleString()} / 10,000`}
                helper="Markdown is supported. For example: Use short replies with emojis. Greet me for my time of day."
                error={
                  invalid || characters > personalMemoryMaximumCharacters
                    ? 'Use valid text with no more than 10,000 characters.'
                    : undefined
                }
              >
                <Textarea
                  value={draft}
                  readOnly={unresolved}
                  onChange={event => {
                    setDraft(event.target.value);
                    if (state.kind === 'saved' || state.kind === 'changed' || state.kind === 'error')
                      setState({ kind: 'ready' });
                    if (invalid)
                      setInvalid(
                        !savePersonalMemorySchema.safeParse({
                          content: event.target.value,
                          expectedRevision: saved?.revision ?? 0,
                        }).success,
                      );
                  }}
                />
              </Field>
              {state.kind === 'saved' && (
                <p role="status" className="text-sm text-muted-foreground">
                  Memory saved. Your next private replies will use it.
                </p>
              )}
              {state.kind === 'changed' && (
                <p role="status" className="text-sm text-muted-foreground">
                  {state.message}
                </p>
              )}
              {history?.trashed && (
                <Alert>
                  <p>Your memory is deleted. You can restore it for 7 days after deleting it.</p>
                  <div className="mt-3">
                    <Button variant="outline" disabled={pending || unresolved} onClick={() => void change('undo')}>
                      Restore memory
                    </Button>
                  </div>
                </Alert>
              )}
              {state.kind === 'uncertain' && (
                <Alert>
                  <p>
                    We could not confirm your save, or memory changed while you were editing. Your draft is kept. Check
                    the saved version before trying again.
                  </p>
                  <div className="mt-3">
                    <Button variant="outline" onClick={() => void read(true)}>
                      Check saved memory
                    </Button>
                  </div>
                </Alert>
              )}
              {state.kind === 'conflict' && (
                <Alert>
                  <p>Review the latest saved memory before replacing it with your draft.</p>
                  <pre className="my-3 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">
                    {state.latest.content || 'No saved preferences.'}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        accept(state.latest);
                        setState({ kind: 'ready' });
                      }}
                    >
                      Use saved version
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSaved(state.latest);
                        setState({ kind: 'ready' });
                      }}
                    >
                      Keep my draft
                    </Button>
                  </div>
                </Alert>
              )}
              <FormFooter
                dirty={dirty}
                submit={{
                  label: 'Save memory',
                  pendingLabel: state.kind === 'checking' ? 'Checking memory...' : 'Saving memory...',
                  state: pending
                    ? { kind: 'busy' }
                    : unresolved
                      ? { kind: 'blocked', reason: 'Resolve the saved version before saving.' }
                      : { kind: 'ready' },
                }}
                cancel={
                  unresolved
                    ? undefined
                    : {
                        kind: 'reset',
                        label: 'Discard changes',
                        onReset: () => {
                          if (saved) {
                            accept(saved);
                            setState({ kind: 'ready' });
                          }
                        },
                      }
                }
                note={
                  history
                    ? 'Manual changes take priority over older chats. Memory keeps a history of changes, so you can undo them.'
                    : 'Manual changes take priority over older chats. To clear memory, remove the text and save. New chats can add new preferences.'
                }
                error={
                  state.kind === 'error' ? state.message : invalid ? 'Fix the memory text before saving.' : undefined
                }
              />
              {history && !history.trashed && saved?.content !== '' && (
                <div role="group" aria-label="Memory history" className="flex flex-wrap gap-2">
                  {history.undo && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending || unresolved || dirty}
                      onClick={() => void change('undo')}
                    >
                      Undo last change
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending || unresolved || dirty}
                    onClick={() => void change('delete')}
                  >
                    Delete memory
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={pending || unresolved || dirty}
                    onClick={() => setForgetting(true)}
                  >
                    Forget permanently
                  </Button>
                </div>
              )}
            </div>
          </Form>
          {history && saved && (
            <MemoryProposals
              path={path}
              revision={saved.revision}
              blocked={dirty || pending || unresolved}
              onMemory={value => {
                accept(value);
                setState({ kind: 'ready' });
              }}
            />
          )}
        </>
      )}
      {forgetting && (
        <AlertDialog
          open
          onOpenChange={open => {
            if (!open && !pending) setForgetting(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle>Forget your memory permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This erases your memory and its whole history, including deleted versions. You can’t undo it or restore
              it. To keep a way back, use Delete memory instead.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Keep memory</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={pending}
                aria-busy={pending}
                onClick={() => void change('forget')}
              >
                {pending ? 'Forgetting…' : 'Forget permanently'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </FormSection>
  );
}
