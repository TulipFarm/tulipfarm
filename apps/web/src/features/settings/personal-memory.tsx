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
import { UnsavedChanges } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { settingsRequest } from './api';

type State =
  | { kind: 'loading' }
  | { kind: 'load-error' }
  | { kind: 'unavailable' }
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }
  | { kind: 'uncertain' }
  | { kind: 'checking' }
  | { kind: 'conflict'; latest: PersonalMemory };

export function PersonalMemoryEditor({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [saved, setSaved] = useState<PersonalMemory | null>(null);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
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
      setState(denied ? { kind: 'unavailable' } : { kind: check ? 'uncertain' : 'load-error' });
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
      if (result.revision !== saved.revision + 1 || result.content !== (draft.trim() ? draft : ''))
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
      ) : state.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Memory is unavailable"
          description="Check your workspace access before editing your preferences."
        />
      ) : (
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
            {saved?.content === '' && (
              <p className="text-sm text-muted-foreground">
                No preferences saved yet. Add your own, or tell Bud how you like replies. Closed chats are checked in
                the background.
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
                  if (state.kind === 'saved' || state.kind === 'error') setState({ kind: 'ready' });
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
              note="Manual changes take priority over older chats. To clear memory, remove the text and save. New chats can add new preferences."
              error={
                state.kind === 'error' ? state.message : invalid ? 'Fix the memory text before saving.' : undefined
              }
            />
          </div>
        </Form>
      )}
    </FormSection>
  );
}
