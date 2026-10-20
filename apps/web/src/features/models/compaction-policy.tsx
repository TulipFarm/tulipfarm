import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { CheckboxField, Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { UnsavedChanges } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { compactionApi, type CompactionPolicy, type CompactionPolicyCommand } from './compaction-api';
import { compactionCommand, compactionDraft, compactionErrors, type CompactionDraft } from './compaction-draft';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; policy: CompactionPolicy };
type Save =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'rejected'; message: string }
  | { kind: 'uncertain'; command: CompactionPolicyCommand };

/** Workspace-wide compaction settings. Every chat in the workspace uses them; there are no per-chat overrides. */
export function CompactionPolicySection({
  workspaceId,
  admin,
  writable,
  accessVersion,
}: {
  workspaceId: string;
  admin: boolean;
  writable: boolean;
  accessVersion: number;
}) {
  const api = useMemo(() => compactionApi(workspaceId), [workspaceId]);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<CompactionDraft | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const dirty =
    load.kind === 'ready' && draft !== null && JSON.stringify(draft) !== JSON.stringify(compactionDraft(load.policy));
  const busy = save.kind === 'sending';
  const receive = useEffectEvent((policy: CompactionPolicy) => {
    if (load.kind === 'ready' && (dirty || save.kind === 'uncertain' || save.kind === 'conflict')) {
      setLoad({ kind: 'ready', policy: { ...load.policy, budgetFamilies: policy.budgetFamilies } });
    } else {
      setLoad({ kind: 'ready', policy });
      setDraft(compactionDraft(policy));
    }
    setRefreshing(false);
    setReadError(null);
  });
  const failed = useEffectEvent((error: unknown) => {
    const message =
      error instanceof TableRequestError
        ? error.message
        : 'Couldn’t load compaction settings. Check your connection, then retry.';
    if (load.kind === 'ready' && !(error instanceof TableRequestError && [401, 403, 404].includes(error.status)))
      setReadError(message);
    else setLoad({ kind: 'error', message });
    setRefreshing(false);
  });
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    setRefreshing(true);
    api.read(controller.signal).then(
      policy => {
        if (!controller.signal.aborted) receive(policy);
      },
      error => {
        if (!controller.signal.aborted) failed(error);
      },
    );
    return () => controller.abort();
  }, [api, attempt, accessVersion, busy]);
  useEffect(() => () => active.current?.abort(), []);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const reload = useCallback(() => {
    setSave({ kind: 'idle' });
    setShowErrors(false);
    setLoad({ kind: 'loading' });
    setDraft(null);
    setAttempt(value => value + 1);
  }, []);

  if (load.kind === 'loading')
    return (
      <section aria-label="Conversation compaction">
        <p role="status" className="text-sm text-muted-foreground">
          Loading compaction settings…
        </p>
      </section>
    );
  if (load.kind === 'error')
    return (
      <section aria-label="Conversation compaction" className="space-y-3">
        <Alert variant="destructive">
          <AlertDescription>{load.message}</AlertDescription>
        </Alert>
        <Button variant="outline" disabled={refreshing} onClick={retry}>
          Retry compaction settings
        </Button>
      </section>
    );
  const policy = load.policy;
  const families = policy.budgetFamilies;
  const name = (id: string | null) => families.find(family => family.id === id)?.name ?? id;
  const refreshFeedback = (
    <>
      {refreshing && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing compaction settings…
        </p>
      )}
      {readError && (
        <div className="space-y-3">
          <Alert variant="destructive">
            <AlertDescription>
              {readError}
              {dirty && ' Your unsaved choices are retained.'}
            </AlertDescription>
          </Alert>
          <Button variant="outline" disabled={refreshing} onClick={retry}>
            Retry compaction settings
          </Button>
        </div>
      )}
    </>
  );
  if (!admin || !draft)
    return (
      <>
        {refreshFeedback}
        <FormSection
          title="Conversation compaction"
          description="Keeps long chats within the model context by summarizing earlier messages. Applies to every chat in this workspace."
        >
          <dl className="grid gap-2 text-sm">
            <div>
              <dt className="inline text-muted-foreground">Automatic: </dt>
              <dd className="inline">
                {policy.automatic
                  ? `On, from ${policy.triggerPercent}% down to ${policy.targetPercent}% of the model context`
                  : 'Off. People can still run /compact.'}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Summary model: </dt>
              <dd className="inline">
                {name(policy.modelFamilyId)}
                {policy.fallbackFamilyId ? `, then ${name(policy.fallbackFamilyId)}` : ''}
              </dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">Only workspace admins can change compaction settings.</p>
        </FormSection>
      </>
    );

  const errors = compactionErrors(draft, families);
  const visible = showErrors ? errors : {};
  const invalidCount = Object.keys(errors).length;
  const update = (patch: Partial<CompactionDraft>) => {
    setDraft({ ...draft, ...patch });
    if (save.kind === 'saved' || save.kind === 'rejected') setSave({ kind: 'idle' });
  };

  async function send(command: CompactionPolicyCommand) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setSave({ kind: 'sending' });
    try {
      const receipt = await api.save(command, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      if (controller.signal.aborted) return;
      setLoad({ kind: 'ready', policy: receipt });
      setDraft(compactionDraft(receipt));
      setShowErrors(false);
      setSave({ kind: 'saved' });
    } catch (error) {
      if (controller.signal.aborted && active.current !== controller) return;
      if (error instanceof TableRequestError && error.code === 'compaction-policy-revision-conflict')
        setSave({ kind: 'conflict' });
      else if (
        error instanceof TableRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        setSave({ kind: 'rejected', message: error.message });
      else setSave({ kind: 'uncertain', command });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  return (
    <>
      <UnsavedChanges dirty={dirty} />
      {refreshFeedback}
      <Form
        label="Conversation compaction"
        disabled={busy || !writable || refreshing || !!readError}
        onSubmit={() => {
          if (busy || !writable || refreshing || readError) return;
          if (invalidCount) {
            setShowErrors(true);
            return 'invalid';
          }
          if (!dirty || save.kind === 'conflict') return;
          void send(save.kind === 'uncertain' ? save.command : compactionCommand(draft, policy.revision));
        }}
      >
        <div className="grid gap-4">
          <FormSection
            title="Conversation compaction"
            description="Keeps long chats within the model context by summarizing earlier messages. Applies to every chat in this workspace."
          >
            <CheckboxField
              id="compaction-automatic"
              label="Compact automatically"
              helper="Summarize earlier messages when a chat reaches the trigger. People can always run /compact."
              checked={draft.automatic}
              onCheckedChange={automatic => update({ automatic })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="compaction-trigger"
                label="Trigger"
                required
                helper="Percent of the model context that starts compaction."
                error={visible.trigger}
              >
                <Input
                  inputMode="numeric"
                  value={draft.trigger}
                  onChange={event => update({ trigger: event.target.value })}
                />
              </Field>
              <Field
                id="compaction-target"
                label="Target"
                required
                helper="Percent of the model context to compact down to."
                error={visible.target}
              >
                <Input
                  inputMode="numeric"
                  value={draft.target}
                  onChange={event => update({ target: event.target.value })}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="compaction-model"
                label="Summary model"
                required
                helper="An approved budget model writes summaries and handoffs."
                error={visible.model}
              >
                <Select value={draft.model} onValueChange={value => update({ model: value ?? '' })}>
                  <SelectTrigger width="full">
                    <SelectValue placeholder="Choose a model">{name(draft.model)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {families.map(family => (
                      <SelectItem key={family.id} value={family.id} disabled={!family.enabled}>
                        {family.name}
                        {family.enabled ? '' : ' (unavailable)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                id="compaction-fallback"
                label="Fallback summary model"
                optional
                helper="Used only when the summary model is unavailable."
                error={visible.fallback}
              >
                <Select value={draft.fallback} onValueChange={value => update({ fallback: value ?? '' })}>
                  <SelectTrigger width="full">
                    <SelectValue>{draft.fallback ? name(draft.fallback) : 'No fallback'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No fallback</SelectItem>
                    {families.map(family => (
                      <SelectItem
                        key={family.id}
                        value={family.id}
                        disabled={!family.enabled || family.id === draft.model}
                      >
                        {family.name}
                        {family.enabled ? '' : ' (unavailable)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field
              id="compaction-prompt"
              label="Handoff instructions"
              optional
              counter={`${draft.prompt.trim().length.toLocaleString()} / 2,000`}
              helper="Shapes the handoff written by /compact, such as the audience or format. A /compact message can add its own."
              error={visible.prompt}
            >
              <Textarea rows={3} value={draft.prompt} onChange={event => update({ prompt: event.target.value })} />
            </Field>
          </FormSection>
          <FormFooter
            dirty={dirty}
            note="Summaries use only approved budget models and never switch to a larger model."
            submit={{
              label: 'Save compaction settings',
              pendingLabel: 'Saving compaction settings…',
              state: busy
                ? { kind: 'busy' }
                : !writable
                  ? { kind: 'blocked', reason: 'Reload the Models page to check your current access first.' }
                  : refreshing
                    ? { kind: 'blocked', reason: 'Wait for compaction settings to finish refreshing.' }
                    : readError
                      ? { kind: 'blocked', reason: 'Retry compaction settings before saving.' }
                      : save.kind === 'conflict'
                        ? { kind: 'blocked', reason: 'Reload the latest settings first.' }
                        : { kind: 'ready' },
            }}
            cancel={{
              kind: 'reset',
              label: 'Discard changes',
              onReset: () => {
                setDraft(compactionDraft(policy));
                setShowErrors(false);
                setSave({ kind: 'idle' });
              },
            }}
            error={
              showErrors && invalidCount
                ? `Fix ${invalidCount} ${invalidCount === 1 ? 'field' : 'fields'} to save compaction settings.`
                : undefined
            }
          >
            {save.kind === 'saved' && (
              <p role="status" className="text-sm">
                Compaction settings saved.
              </p>
            )}
            {save.kind === 'rejected' && (
              <Alert variant="destructive">
                <AlertDescription>{save.message}</AlertDescription>
              </Alert>
            )}
            {save.kind === 'uncertain' && (
              <Alert>
                <AlertDescription>
                  We could not confirm this save. Saving again sends the same change once.
                </AlertDescription>
              </Alert>
            )}
            {save.kind === 'conflict' && (
              <div className="space-y-2">
                <Alert variant="destructive">
                  <AlertDescription>
                    Another admin changed compaction settings. Reload the latest settings, then save again. Reloading
                    discards your changes here.
                  </AlertDescription>
                </Alert>
                <Button variant="outline" onClick={reload}>
                  Reload latest settings
                </Button>
              </div>
            )}
          </FormFooter>
        </div>
      </Form>
    </>
  );
}
