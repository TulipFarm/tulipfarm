import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, type ButtonState } from '@tulipfarm/sprout/button';
import { AgentAvatar } from '@tulipfarm/sprout/agent-avatar';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { webAgentDefinitionSchema } from './definition';
import { agentDraftErrors, agentDraftFooterError } from './draft';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { useTableWrite } from '@/features/tables/use-table-write';
import { useAgentCommand, useAgentPolicy } from './queries';
import { WriteFeedback, UnsavedChanges } from '@/features/tables/feedback';
import { AgentRead } from './feedback';
import { AgentModelPicker } from '@/features/models/agent-model-picker';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import { McpAgentPermissions } from '@/features/workspace-mcp/agent-permissions';
import { AgentSkillPicker, type SkillSelections } from './skill-picker';
import { AgentToolPicker, changingTools, type ToolName } from './tool-picker';
import type { agentApi, AgentCommand, AgentContext, AgentDetail, AgentInput } from './api';
import { activateRevision, needsActivationReview, type RevisionActivation } from './revision-activation';
import { RevisionReview } from './revision-review';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';

const responseRules = [
  {
    value: 'tag',
    label: 'When tagged',
    description: 'Replies when someone mentions the agent, then follows that thread.',
  },
  {
    value: 'every-message',
    label: 'Every channel message',
    description: 'Replies to every new message in its channels.',
  },
] as const;
const commandStatus: Record<AgentCommand['status'], string> = {
  accepted: 'Agent saved.',
  preparing: 'Save queued. It continues if you leave this page.',
  conflict: 'Another save finished first. Your input is retained. Refresh the definition before trying again.',
  failed: 'Save was not accepted. Check your current permissions.',
};
const instructionLimit = 32000;

type DefinitionDraft = {
  name: string;
  instructions: string;
  tools: ToolName[];
  skills: SkillSelections;
  responseRule: 'tag' | 'every-message';
  modelFamilyId: string | undefined;
};
function savedDraft(detail: AgentDetail | null): DefinitionDraft {
  const definition = detail?.definition;
  return {
    name: definition?.name ?? '',
    instructions: definition?.instructions ?? '',
    tools: definition?.tools ?? [],
    skills: definition?.skills ?? [],
    responseRule: definition?.responseRule ?? 'tag',
    modelFamilyId: definition?.modelFamilyId,
  };
}

export function AgentEditor({
  api,
  workspaceId,
  slug,
  id,
  context,
  detail,
  concealed,
  refresh,
  onAccepted,
}: {
  api: ReturnType<typeof agentApi>;
  workspaceId: string;
  slug: string;
  id: string;
  context: AgentContext;
  detail: AgentDetail | null;
  concealed: boolean;
  refresh: () => Promise<void>;
  onAccepted?: ((receipt: AgentCommand) => void) | undefined;
}) {
  const [draft, setDraft] = useState(() => savedDraft(detail));
  const [teamId, setTeamId] = useState(detail?.owningTeamId ?? 'personal');
  const [command, setCommand] = useState<AgentCommand | null>(null);
  const [finished, setFinished] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [parseFailed, setParseFailed] = useState(false);
  const [baseRevision, setBaseRevision] = useState(detail?.savedRevision ?? null);
  const [live, setLive] = useState<Awaited<ReturnType<typeof activateRevision>> | null>(null);
  const [review, setReview] = useState<
    | { kind: 'save'; input: AgentInput; activation: Omit<RevisionActivation, 'savedRevision'> }
    | { kind: 'activate'; input: RevisionActivation }
    | null
  >(null);
  const submitIntent = useRef<'save' | null>(null);
  const activateAfterSave = useRef<Omit<RevisionActivation, 'savedRevision'> | null>(null);
  const canActivate = !!detail?.capabilities.includes('manage');
  const combined = canActivate && !!detail?.activations.length;
  const policy = useAgentPolicy(api, id, canActivate && !concealed);
  const activation = useTableWrite(
    (input: RevisionActivation) => activateRevision(api, id, input),
    result => {
      setLive(result);
      void refresh();
    },
  );
  const handled = useRef<string | null>(null);
  const write = useTableWrite(
    (input: AgentInput) => api.save(id, input),
    value => {
      setCommand(value);
      setFinished(false);
    },
  );
  const status = useAgentCommand(api, id, command, !concealed);
  const catalog = useModelCatalog(workspaceId);
  useEffect(() => {
    if (
      status.state.kind === 'ready' &&
      status.state.data.status === 'accepted' &&
      handled.current !== status.state.data.commandId
    ) {
      handled.current = status.state.data.commandId;
      setBaseRevision(status.state.data.savedRevision);
      setFinished(true);
      const intent = activateAfterSave.current;
      activateAfterSave.current = null;
      if (intent && status.state.data.savedRevision)
        void activation.submit({ ...intent, savedRevision: status.state.data.savedRevision });
      if (onAccepted) onAccepted(status.state.data);
    }
  }, [status.state, refresh, onAccepted]);
  const update = (change: Partial<DefinitionDraft>) => setDraft(current => ({ ...current, ...change }));
  const continueEditing = () => {
    setCommand(null);
    setFinished(false);
    write.reset();
    activation.reset();
    setLive(null);
    void refresh();
  };
  const commandPending =
    !!command &&
    (status.state.kind === 'loading' || (status.state.kind === 'ready' && status.state.data.status === 'preparing'));
  const commandUnknown = !!command && (status.state.kind === 'error' || status.state.kind === 'unavailable');
  const changedElsewhere = !finished && baseRevision !== (detail?.savedRevision ?? null);
  const save: ButtonState =
    write.state.kind === 'sending' || commandPending || activation.state.kind === 'sending'
      ? { kind: 'busy' }
      : write.state.kind === 'uncertain' || commandUnknown || activation.state.kind === 'uncertain'
        ? { kind: 'blocked', reason: 'Check whether your last save went through before saving again.' }
        : changedElsewhere
          ? {
              kind: 'blocked',
              reason: 'A newer version was saved. Choose which text to keep.',
              fix: { kind: 'jump', label: 'Review the newer version', target: 'agent-newer-definition' },
            }
          : finished
            ? {
                kind: 'blocked',
                reason: 'Your changes are saved.',
                fix: { kind: 'action', label: 'Continue editing', onClick: continueEditing },
              }
            : { kind: 'ready' };
  const locked = save.kind !== 'ready';
  const dirty =
    !finished && (JSON.stringify(draft) !== JSON.stringify(savedDraft(detail)) || (!detail && teamId !== 'personal'));
  const errors = showErrors ? agentDraftErrors(draft) : {};
  if (concealed) return <UnsavedChanges dirty={dirty || write.state.kind === 'uncertain'} />;
  const team = context.teams.find(item => item.id === (detail?.owningTeamId ?? teamId));
  const changing = draft.tools.filter(tool => changingTools.has(tool)).length;
  const activationState: ButtonState =
    activation.state.kind === 'sending' || policy.state.kind === 'loading'
      ? { kind: 'busy' }
      : activation.state.kind === 'uncertain'
        ? { kind: 'blocked', reason: 'Could not confirm activation. Check status before activating again.' }
        : policy.state.kind !== 'ready' || policy.state.error
          ? {
              kind: 'blocked',
              reason: 'Execution settings could not load. You can still save.',
              fix: { kind: 'action', label: 'Try again', onClick: () => void policy.refresh() },
            }
          : policy.state.refreshing
            ? { kind: 'busy' }
            : !policy.state.data.enabled
              ? {
                  kind: 'blocked',
                  reason: 'Execution is off. Turn on Enable execution and save, then activate.',
                  fix: {
                    kind: 'link',
                    label: 'Go to Enable execution',
                    link: (
                      <Link
                        to="/$workspaceSlug/agents/$agentId"
                        params={{ workspaceSlug: slug, agentId: id }}
                        search={{ tab: 'execution' }}
                        hash="agent-enable-execution"
                      />
                    ),
                  },
                }
              : { kind: 'ready' };
  const notLive = !!detail && !detail.activations.some(item => item.revision === detail.definitionRevision);
  const currentLive = live && live.savedRevision === detail?.savedRevision ? live : null;
  const activatedText = currentLive ? `Saved and activated. ${currentLive.name} now uses these instructions.` : null;
  const saving = write.state.kind === 'sending' || commandPending;
  const activating = activation.state.kind === 'sending';
  const activationFailed = activation.state.kind === 'rejected';
  const activationUncertain = activation.state.kind === 'uncertain';
  const uncertainActivation = activation.state.kind === 'uncertain' ? activation.state.input : null;
  const savedText = detail?.activations.length
    ? 'Saved. Runs still use the active version.'
    : `Saved. ${detail?.name} does not run until you activate a version.`;
  const progressText = activating
    ? 'Activating…'
    : saving
      ? status.delayed
        ? 'Saving is taking longer than expected. Automatic checks have stopped.'
        : 'Saving…'
      : (activatedText ??
        (command && status.state.kind === 'ready'
          ? status.state.data.status === 'accepted' && detail
            ? savedText
            : commandStatus[status.state.data.status]
          : null));
  const showSavedActivation = () => {
    const next = activationContext();
    if (next && detail && !dirty)
      setReview({ kind: 'activate', input: { ...next, savedRevision: detail.savedRevision } });
  };
  const activationContext = () => {
    if (activationState.kind !== 'ready' || policy.state.kind !== 'ready') return null;
    return {
      requestId: crypto.randomUUID(),
      policyVersion: policy.state.data.version,
      activationIds: detail?.activations.map(item => item.id) ?? [],
      scope: detail?.activations[0]?.scope ?? policy.state.data.limits,
    };
  };
  async function checkActivation() {
    if (activation.state.kind === 'uncertain') {
      const input = activation.state.input;
      try {
        const current = await api.detail(id, AbortSignal.timeout(15000));
        if (
          current.savedRevision === input.savedRevision &&
          current.activations.some(
            item =>
              item.id === input.requestId &&
              item.revision === current.definitionRevision &&
              JSON.stringify(item.scope) === JSON.stringify(input.scope),
          )
        ) {
          setLive({ name: current.name, savedRevision: current.savedRevision, revision: current.definitionRevision });
          activation.reset();
        }
      } catch {
        // Keep the uncertain operation available for an exact-request retry.
      }
    }
    await refresh();
  }

  function submit(): 'invalid' | undefined {
    const intent = submitIntent.current ?? (combined ? 'activate' : 'save');
    submitIntent.current = null;
    if (locked) return;
    setParseFailed(false);
    if (Object.keys(agentDraftErrors(draft)).length) {
      setShowErrors(true);
      return 'invalid';
    }
    setShowErrors(false);
    const { modelFamilyId: _savedFamily, ...savedDefinition } = detail?.definition ?? {};
    const { modelFamilyId, ...definition } = draft;
    const parsed = webAgentDefinitionSchema.safeParse({
      ...savedDefinition,
      ...definition,
      ...(modelFamilyId === undefined ? {} : { modelFamilyId }),
    });
    if (!parsed.success) {
      setParseFailed(true);
      return;
    }
    const input: AgentInput = {
      requestId: crypto.randomUUID(),
      expectedSoulRevision: context.currentSoulRevision,
      expectedSavedRevision: baseRevision,
      owningTeamId: detail ? detail.owningTeamId : teamId === 'personal' ? null : teamId,
      definition: parsed.data,
    };
    setLive(null);
    activation.reset();
    if (intent === 'activate' && detail) {
      const next = activationContext();
      if (!next) return;
      if (notLive || needsActivationReview(detail.definition, parsed.data)) {
        setReview({ kind: 'save', input, activation: next });
        return;
      }
      activateAfterSave.current = next;
    } else activateAfterSave.current = null;
    void write.submit(input);
  }

  const name = (
    <Field id="agent-name" label="Agent name" required error={errors.name}>
      <Input
        value={draft.name}
        maxLength={120}
        placeholder="Invoice follow-up"
        onChange={event => update({ name: event.target.value })}
      />
    </Field>
  );
  const sections = (
    <>
      <FormSection title="Role" description="Who this agent is and the job it does.">
        {detail ? (
          name
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {name}
            <Field
              id="agent-owner"
              label="Team placement"
              optional
              helper="Private to you when created. You can share it with people or teams later."
            >
              <Select
                value={teamId}
                onValueChange={value => {
                  if (value) setTeamId(value);
                }}
              >
                <SelectTrigger>
                  <SelectValue>{team?.name ?? 'Personal agent'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal agent</SelectItem>
                  {context.teams.map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
        <Field
          id="agent-instructions"
          label="Instructions"
          required
          counter={`${draft.instructions.length.toLocaleString()} / ${instructionLimit.toLocaleString()}`}
          helper="Describe the job, what good work looks like, and when to ask a person."
          error={errors.instructions}
        >
          <Textarea
            value={draft.instructions}
            maxLength={instructionLimit}
            rows={12}
            onChange={event => update({ instructions: event.target.value })}
          />
        </Field>
      </FormSection>
      <AgentModelPicker
        workspaceId={workspaceId}
        value={draft.modelFamilyId}
        onChange={modelFamilyId => update({ modelFamilyId })}
      />
      <AgentSkillPicker
        workspaceId={workspaceId}
        value={draft.skills}
        onChange={skills => update({ skills })}
        disabled={locked}
      />
      <FormSection
        title="Permitted actions"
        meta={`${draft.tools.length} selected`}
        description="What this agent may do when it runs. Each app lists actions that only read first, then actions that change data."
      >
        <AgentToolPicker
          value={draft.tools}
          error={errors.tools}
          disabled={locked}
          onChange={tools => update({ tools })}
        />
      </FormSection>
      <FormSection
        title="Slack trigger"
        description="Choose which messages in attached Slack channels start this agent."
      >
        <ChoiceGroup
          id="agent-slack-response"
          type="radio"
          layout="columns"
          required
          legend="When should Slack start this agent?"
          options={responseRules}
          value={draft.responseRule}
          onValueChange={responseRule => update({ responseRule })}
        />
      </FormSection>
    </>
  );
  const footer = (
    <FormFooter
      layout={detail ? 'bar' : 'stack'}
      dirty={dirty}
      error={
        agentDraftFooterError(errors) ??
        (parseFailed ? 'Review the selected skills and actions, then save again.' : undefined)
      }
      submit={{
        label: combined ? 'Save and activate' : 'Save agent',
        pendingLabel: activating ? 'Activating…' : 'Saving…',
        state: combined && save.kind === 'ready' ? activationState : save,
      }}
      secondarySubmit={
        combined
          ? {
              label: 'Save without activating',
              disabled: locked,
              onSelect: () => {
                submitIntent.current = 'save';
              },
            }
          : undefined
      }
      summary={
        detail && notLive ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-warning">
              {!canActivate
                ? 'A manager needs to activate this version.'
                : detail.activations.length
                  ? 'This saved version is not active yet. Runs still use the earlier version.'
                  : `No active version. ${detail.name} does not run until you activate one.`}
            </p>
            {canActivate && (
              <Button
                variant="outline"
                state={dirty ? { kind: 'blocked', reason: 'Your changes are not saved yet.' } : activationState}
                pendingLabel="Activating…"
                onClick={showSavedActivation}
              >
                Activate saved instructions
              </Button>
            )}
          </div>
        ) : undefined
      }
      note={
        detail
          ? canActivate
            ? 'Stay on this page until activation finishes.'
            : 'A manager needs to activate this version.'
          : 'Saving keeps the agent off until a manager configures access and activates it.'
      }
      cancel={
        detail
          ? {
              kind: 'reset',
              label: 'Discard changes',
              onReset: () => {
                setDraft(savedDraft(detail));
                setShowErrors(false);
                setParseFailed(false);
              },
            }
          : {
              kind: 'leave',
              label: 'Cancel',
              link: <Link to="/$workspaceSlug/agents" params={{ workspaceSlug: slug }} />,
            }
      }
    >
      <WriteFeedback
        state={write.state.kind === 'sending' ? { kind: 'idle' } : write.state}
        checkStatus={() => void refresh()}
        retry={input => void write.submit(input)}
      />
      <p role="status" className="text-sm">
        {progressText}
      </p>
      {commandUnknown && (
        <AgentRead state={status.state} refresh={status.refresh}>
          {() => null}
        </AgentRead>
      )}
      {command &&
        status.state.kind === 'ready' &&
        (status.state.data.status === 'conflict' || status.state.data.status === 'failed') && (
          <Button variant="outline" onClick={continueEditing}>
            Continue editing
          </Button>
        )}
      {canActivate &&
        (policy.state.kind === 'error' ||
          policy.state.kind === 'unavailable' ||
          (policy.state.kind === 'ready' && policy.state.error)) && (
          <Alert variant="destructive">
            <AlertDescription>Execution settings could not load. You can still save.</AlertDescription>
            <Button variant="outline" onClick={() => void policy.refresh()}>
              Try again
            </Button>
          </Alert>
        )}
      {command && (
        <div>
          <Button variant="outline" onClick={() => void status.refresh()}>
            Check save status
          </Button>
        </div>
      )}
      {(activationFailed || activationUncertain) && (
        <Alert variant="destructive">
          <AlertDescription>
            {activationUncertain
              ? 'Could not confirm activation. Check status before activating again.'
              : detail?.activations.length
                ? 'Saved, but not activated. Runs still use the earlier version. Try activating again.'
                : `No active version. ${detail?.name} does not run until you activate one.`}
          </AlertDescription>
        </Alert>
      )}
      {activation.state.kind === 'rejected' && (
        <p role="alert" className="text-sm">
          {activation.state.message}
        </p>
      )}
      {activationUncertain && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void checkActivation()}>
            Check activation status
          </Button>
          <Button variant="outline" onClick={() => uncertainActivation && void activation.submit(uncertainActivation)}>
            Retry same operation
          </Button>
        </div>
      )}
    </FormFooter>
  );
  return (
    <section aria-label="Agent editor" className="space-y-6">
      <RevisionReview
        workspaceId={workspaceId}
        definition={review?.kind === 'save' ? review.input.definition : review ? (detail?.definition ?? null) : null}
        scope={review?.kind === 'save' ? review.activation.scope : (review?.input.scope ?? [])}
        close={() => setReview(null)}
        saved={review?.kind === 'activate'}
        confirm={() => {
          if (!review) return;
          if (review.kind === 'save') {
            activateAfterSave.current = review.activation;
            void write.submit(review.input);
          } else void activation.submit(review.input);
          setReview(null);
        }}
      />
      <UnsavedChanges dirty={dirty || write.state.kind === 'uncertain'} />
      <Form id="agent-definition-form" disabled={locked} onSubmit={submit}>
        {detail ? (
          <div className="grid gap-6">
            {sections}
            {footer}
          </div>
        ) : (
          <div className="grid gap-6 lg:flex lg:items-start">
            <div className="grid min-w-0 flex-1 gap-6">{sections}</div>
            <aside
              aria-label="Agent summary"
              className="grid min-w-0 content-start gap-5 rounded-xl border bg-card p-4 lg:sticky lg:top-4 lg:w-68 lg:shrink-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <AgentAvatar agentId={id} name={draft.name.trim() || 'Agent'} size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {draft.name.trim() || 'Untitled agent'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {team ? `Placed in ${team.name}` : 'Personal agent'}
                  </p>
                </div>
              </div>
              <dl className="space-y-2 text-sm">
                {[
                  [
                    'Model',
                    draft.modelFamilyId
                      ? ((catalog.state.kind === 'ready'
                          ? catalog.state.data.families.find(family => family.id === draft.modelFamilyId)?.displayName
                          : undefined) ?? draft.modelFamilyId)
                      : 'No preference',
                  ],
                  ['Skills', draft.skills.length ? String(draft.skills.length) : 'None'],
                  [
                    'Actions',
                    draft.tools.length ? `${draft.tools.length}${changing ? `, ${changing} change data` : ''}` : 'None',
                  ],
                  ['Slack', draft.responseRule === 'tag' ? 'When tagged' : 'Every message'],
                ].map(([term, value]) => (
                  <div key={term} className="flex min-w-0 justify-between gap-4">
                    <dt className="shrink-0 text-muted-foreground">{term}</dt>
                    <dd className="min-w-0 truncate text-right tabular-nums text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
              {footer}
            </aside>
          </div>
        )}
      </Form>
      {changedElsewhere && detail && (
        <section id="agent-newer-definition" aria-label="Newer saved definition" className="space-y-3 break-words">
          <h3 className="font-medium">Review the newer saved definition</h3>
          <p>{detail.definition.name}</p>
          <p className="whitespace-pre-wrap">{detail.definition.instructions}</p>
          <p>Tools: {detail.definition.tools.join(', ') || 'None'}</p>
          <p>
            Skills:{' '}
            {detail.definition.skills?.map(skill => `${skill.id} version ${skill.revision}`).join(', ') || 'None'}
          </p>
          <p>Model preference: {detail.definition.modelFamilyId ?? 'No saved preference'}</p>
          <p>Slack response rule: {detail.definition.responseRule ?? 'tag'}</p>
          <Button
            variant="outline"
            onClick={() => {
              setBaseRevision(detail.savedRevision);
              setDraft(savedDraft(detail));
              setCommand(null);
              write.reset();
            }}
          >
            Use newer saved text
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setBaseRevision(detail.savedRevision);
              setCommand(null);
              write.reset();
            }}
          >
            Keep my text against this version
          </Button>
        </section>
      )}
      {detail && (
        <McpAgentPermissions
          workspaceId={workspaceId}
          agentId={id}
          saveBlockedReason={
            changedElsewhere
              ? 'Choose which instruction text to keep first.'
              : save.kind === 'busy'
                ? 'Wait for the instruction save to finish.'
                : dirty
                  ? 'Save or discard your instruction changes first.'
                  : save.kind === 'blocked' && !finished
                    ? 'Check whether the instruction save went through first.'
                    : undefined
          }
          changed={refresh}
        />
      )}
    </section>
  );
}
