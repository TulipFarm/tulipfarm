import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { AgentSetupReceipt, SaveAgentSetupDraft, PublishAgentSetup } from '@tulipfarm/agents/setup-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Field } from '@tulipfarm/sprout/field';
import { FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import { useFeatureRead } from '@/lib/query';
import { useTableWrite } from '@/features/tables/use-table-write';
import { UnsavedChanges, WriteFeedback } from '@/features/tables/feedback';
import { AgentModelPicker } from '@/features/models/agent-model-picker';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import { ModelOption } from '@/features/models/model-option';
import { ImportSkillForm, SkillImportPanel } from '@/features/skills/import-flow';
import { AgentSkillPicker } from './skill-picker';
import { BuilderAccess } from './builder-access';
import { BuilderSlack } from './builder-slack';
import { BuilderSchedules, builderScheduleLabel } from './builder-schedules';
import { AgentBuilderLayout, builderSteps, type BuilderStep } from './builder-layout';
import { AgentBuilderPreview, AgentDraftSummary } from './builder-preview';
import { builderDraft, builderDefinition, parseBuilder, type BuilderDraft, type BuilderInitial } from './builder-draft';
import { InstructionImprovement } from './instruction-improvement';
import { BuilderTestChat, useBuilderTestChat } from './builder-test-chat';
import { AgentRead } from './feedback';
import { agentDraftErrors } from './draft';
import { useAgentChanges } from './queries';
import { AgentSetupReview } from './setup-review';
import type { agentApi, AgentContext } from './api';

type Operation = {
  draft: SaveAgentSetupDraft;
  publicationId: string;
  decision: PublishAgentSetup['decision'];
  consent: PublishAgentSetup['consent'];
};
const resultText: Record<AgentSetupReceipt['status'], string> = {
  preparing: 'Saving your setup. Nothing new runs until activation completes.',
  saved: 'Draft saved. Slack channels and schedules are not started.',
  active: 'Agent created and activated.',
  blocked: 'Instructions saved, but setup is incomplete. No new triggers were started.',
  conflict: 'Something changed before this setup could be applied. Your draft is kept.',
  failed: 'Setup did not finish. Your draft is kept.',
};

export function AgentBuilder({
  api,
  workspaceId,
  slug,
  id,
  membershipId,
  context,
  initial,
  concealed,
  refresh,
  onPersisted,
}: {
  api: ReturnType<typeof agentApi>;
  workspaceId: string;
  slug: string;
  id: string;
  membershipId: string;
  context: AgentContext;
  initial?: BuilderInitial | undefined;
  concealed: boolean;
  refresh: () => Promise<void>;
  onPersisted: () => void;
}) {
  const [draft, setDraft] = useState(() => builderDraft(initial));
  const [base, setBase] = useState(initial);
  const [step, setStep] = useState<BuilderStep>('basics');
  const [visited, setVisited] = useState<ReadonlySet<BuilderStep>>(new Set(['basics']));
  const [tab, setTab] = useState<'summary' | 'test'>('summary');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [activating, setActivating] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(initial?.commandId ?? null);
  const [latest, setLatest] = useState<AgentSetupReceipt | null>(null);
  const [savedKey, setSavedKey] = useState(() => JSON.stringify(draft));
  const [importOpen, setImportOpen] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const [importError, setImportError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [improving, setImproving] = useState(false);
  const submitIntent = useRef<'save' | null>(null);
  const changed = useAgentChanges();
  const catalog = useModelCatalog(workspaceId);
  const chat = useBuilderTestChat(workspaceId, builderDefinition(draft), draft.source);
  const write = useTableWrite(
    async (operation: Operation) => {
      const staged = await api.saveSetupDraft(id, operation.draft);
      setBase(staged);
      onPersisted();
      return api.publishSetup(id, {
        requestId: operation.publicationId,
        version: staged.version,
        digest: staged.digest,
        decision: operation.decision,
        consent: operation.consent,
      });
    },
    receipt => {
      setLatest(receipt);
      setCommandId(receipt.commandId);
    },
  );
  const status = useFeatureRead({
    key: ['agents', 'setup-command', id, commandId],
    enabled: !!commandId && !concealed,
    load: (signal: AbortSignal) => {
      if (!commandId) throw new Error('No setup command selected');
      return api.setupCommand(commandId, signal);
    },
    pollWhile: (receipt: AgentSetupReceipt) => receipt.status === 'preparing',
    interval: 1000,
    maxChecks: 60,
  });
  const receipt = commandId && status.state.kind === 'ready' ? status.state.data : latest;
  useEffect(() => {
    if (receipt?.status === 'saved' || receipt?.status === 'active') {
      setSavedKey(JSON.stringify(draft));
      void changed(id);
    }
  }, [receipt, draft, changed, id]);
  const sending = write.state.kind === 'sending' || (!!commandId && (!receipt || receipt.status === 'preparing'));
  const uncertain =
    write.state.kind === 'uncertain' ||
    (!!commandId && (status.state.kind === 'error' || status.state.kind === 'unavailable'));
  const terminal = receipt && receipt.status !== 'preparing';
  const locked = sending || uncertain || !!terminal || concealed;
  const dirty = JSON.stringify(draft) !== savedKey;
  const parsed = parseBuilder(draft, membershipId, activating, id);
  const review = parseBuilder(draft, membershipId, false, id);
  const errors = showErrors ? agentDraftErrors(draft.definition) : {};
  const errorSteps = new Set(showErrors ? parsed.problems.map(problem => problem.step) : []);
  const completed = new Set(
    builderSteps
      .filter(item => visited.has(item.id) && !review.problems.some(problem => problem.step === item.id))
      .map(item => item.id),
  );
  const currentIndex = builderSteps.findIndex(item => item.id === step);
  const chooseStep = (next: BuilderStep) => {
    setStep(next);
    setPreviewOpen(false);
    setVisited(previous => new Set([...previous, next]));
  };
  const update = (change: Partial<BuilderDraft>) =>
    setDraft(previous => ({
      ...previous,
      ...change,
      source: { version: previous.source.version + 1, fingerprint: crypto.randomUUID() },
    }));
  const updateDefinition = (change: Partial<BuilderDraft['definition']>) =>
    update({ definition: { ...draft.definition, ...change } });
  const team = context.teams.find(team => team.id === draft.owningTeamId)?.name;
  const family =
    catalog.state.kind === 'ready'
      ? catalog.state.data.families.find(family => family.id === draft.definition.modelFamilyId)
      : undefined;
  const model = family ? <ModelOption family={family} /> : (draft.definition.modelFamilyId ?? 'Workspace default');
  const summary = (
    <AgentDraftSummary
      name={draft.definition.name}
      instructions={draft.definition.instructions}
      team={team}
      model={model}
      skills={draft.definition.skills ?? []}
      tools={draft.definition.tools}
      channelNames={draft.channels.filter(channel => !channel.detach).map(channel => channel.name)}
      scheduleLabels={draft.schedules.map(builderScheduleLabel)}
      onEdit={chooseStep}
    />
  );
  function submit(): 'invalid' | undefined {
    const decision = submitIntent.current ?? (step === 'review' ? 'activate' : null);
    submitIntent.current = null;
    if (locked) return;
    if (!decision) {
      chooseStep(builderSteps[currentIndex + 1]!.id);
      return;
    }
    setActivating(decision === 'activate');
    const parsed = parseBuilder(draft, membershipId, decision === 'activate', id);
    if (!parsed.setup) {
      setShowErrors(true);
      chooseStep(parsed.problems[0]?.step ?? 'basics');
      return 'invalid';
    }
    setShowErrors(false);
    void write.submit({
      draft: {
        requestId: crypto.randomUUID(),
        expectedVersion: base?.version ?? 0,
        expectedSoulRevision: base?.expectedSoulRevision ?? context.currentSoulRevision,
        expectedSavedRevision: base?.expectedSavedRevision ?? null,
        expectedPolicyVersion: base?.expectedPolicyVersion ?? 0,
        expectedActivationIds: base?.expectedActivationIds ?? [],
        setup: parsed.setup,
      },
      publicationId: crypto.randomUUID(),
      decision,
      consent: {
        sponsorScheduleIds: draft.schedules.filter(schedule => schedule.sponsorConsent).map(schedule => schedule.id),
        replaceChannels: draft.channels.filter(channel => channel.replaceConsent).map(channel => channel.channel),
      },
    });
  }
  async function continueEditing() {
    if (!receipt) return;
    setStatusError('');
    try {
      const current = await api.context(AbortSignal.timeout(15000));
      const revision = receipt.savedRevision ?? base?.expectedSavedRevision;
      if (revision) {
        const detail = await api.detail(id, AbortSignal.timeout(15000));
        if (detail.savedRevision !== revision) {
          setStatusError(
            'This agent changed after your review. Open the saved agent and review its current definition before replacing it. Your draft is kept.',
          );
          return;
        }
      }
      setBase(
        previous =>
          previous && {
            ...previous,
            expectedSavedRevision: revision ?? null,
            expectedSoulRevision: current.currentSoulRevision,
          },
      );
      setCommandId(null);
      setLatest(null);
      write.reset();
      chooseStep(receipt.status === 'saved' ? 'review' : 'basics');
      await refresh();
    } catch (error) {
      setStatusError(
        error instanceof Error
          ? error.message
          : 'Could not refresh the saved setup. Your draft is kept. Retry checking its status.',
      );
    }
  }
  const panels = {
    basics: (
      <>
        <FormSection title="Identity" description="Start with the name and the job. Everything else is optional.">
          <Field id="agent-name" label="Agent name" required error={errors.name}>
            <Input
              value={draft.definition.name}
              maxLength={120}
              placeholder="People Ops helper"
              onChange={event => updateDefinition({ name: event.target.value })}
            />
          </Field>
          <Field
            id="agent-owner"
            label="Team placement"
            optional
            helper="Choosing a team does not grant it access. Share in Access when you are ready."
          >
            <Select
              value={draft.owningTeamId ?? 'personal'}
              onValueChange={value => {
                if (value) update({ owningTeamId: value === 'personal' ? null : value });
              }}
            >
              <SelectTrigger width="full">
                <SelectValue>{team ?? 'Personal agent'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">Personal agent</SelectItem>
                {context.teams.map(team => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            id="agent-instructions"
            label="Instructions"
            required
            counter={`${draft.definition.instructions.length.toLocaleString()} / 32,000`}
            helper="Describe its role, tone, responsibilities, and when it should ask a person."
            error={errors.instructions}
          >
            <Textarea
              rows={9}
              maxLength={32000}
              value={draft.definition.instructions}
              placeholder="Help teammates find People Ops policies. Cite the handbook, ask when context is missing, and send sensitive questions to a person."
              onChange={event => updateDefinition({ instructions: event.target.value })}
            />
          </Field>
          <InstructionImprovement
            workspaceId={workspaceId}
            agentName={draft.definition.name}
            instructions={draft.definition.instructions}
            source={draft.source}
            disabled={locked || chat.busy}
            onBusy={setImproving}
            onApply={instructions => updateDefinition({ instructions })}
          />
        </FormSection>
        <AgentModelPicker
          workspaceId={workspaceId}
          value={draft.definition.modelFamilyId}
          onChange={modelFamilyId => {
            const { modelFamilyId: _old, ...definition } = draft.definition;
            update({ definition: { ...definition, ...(modelFamilyId ? { modelFamilyId } : {}) } });
          }}
        />
      </>
    ),
    skills: (
      <AgentSkillPicker
        workspaceId={workspaceId}
        value={draft.definition.skills ?? []}
        onChange={skills => updateDefinition({ skills })}
        disabled={locked}
        builtins={context.builtinSkills}
        onImport={() => setImportOpen(true)}
      />
    ),
    access: (
      <BuilderAccess
        workspaceId={workspaceId}
        slug={slug}
        teams={context.teams}
        tools={draft.definition.tools}
        onTools={tools => updateDefinition({ tools })}
        value={draft.access}
        onChange={change => update({ access: { ...draft.access, ...change } })}
        disabled={locked}
        showErrors={showErrors}
      />
    ),
    triggers: (
      <>
        <BuilderSlack
          workspaceId={workspaceId}
          slug={slug}
          agentId={id}
          value={draft.channels}
          onChange={channels => update({ channels })}
          rule={draft.definition.responseRule ?? 'tag'}
          onRule={responseRule => updateDefinition({ responseRule })}
          disabled={locked}
          showErrors={showErrors && activating}
          enabled={step === 'triggers' || draft.channels.length > 0}
        />
        <BuilderSchedules
          value={draft.schedules}
          onChange={schedules => update({ schedules })}
          disabled={locked}
          showErrors={showErrors}
          activating={activating}
        />
      </>
    ),
    review: (
      <FormSection
        title="Review your agent"
        description="Create and activate approves this exact setup. Save draft keeps new triggers off."
      >
        {review.setup ? (
          <AgentSetupReview
            workspaceId={workspaceId}
            setup={review.setup}
            channelNames={Object.fromEntries(draft.channels.map(channel => [channel.channel, channel.name]))}
          />
        ) : (
          <>
            <p className="text-sm">Finish the required fields before approving this setup.</p>
            <ul className="grid gap-2 text-sm">
              {review.problems.map((problem, index) => (
                <li key={index}>
                  <Button variant="link" onClick={() => chooseStep(problem.step)}>
                    {problem.message}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </FormSection>
    ),
  };
  if (concealed) return <UnsavedChanges dirty={dirty || uncertain} />;
  return (
    <section aria-label="Agent builder" className="grid min-w-0 gap-4">
      <UnsavedChanges dirty={(dirty && !terminal) || uncertain} />
      {receipt?.status === 'active' ? (
        <section aria-label="Agent creation receipt" className="grid gap-4">
          <h2 tabIndex={-1} ref={node => node?.focus()} className="text-lg font-medium">
            Agent created and activated.
          </h2>
          <p className="text-sm text-muted-foreground">
            Its reviewed access, channel attachments, and schedules are now in place.
          </p>
          <div>
            <Button
              nativeButton={false}
              render={<Link to="/$workspaceSlug/agents/$agentId" params={{ workspaceSlug: slug, agentId: id }} />}
            >
              Open agent
            </Button>
          </div>
        </section>
      ) : (
        <>
          <AgentBuilderLayout
            step={step}
            onStep={chooseStep}
            completed={completed}
            errors={errorSteps}
            panels={panels}
            disabled={locked}
            onSubmit={submit}
            previewOpen={previewOpen}
            onPreviewOpenChange={setPreviewOpen}
            preview={
              <AgentBuilderPreview
                agentId={id}
                name={draft.definition.name}
                team={team}
                tab={tab}
                onTab={setTab}
                summary={summary}
              >
                <BuilderTestChat chat={chat} disabled={locked || improving} />
              </AgentBuilderPreview>
            }
            footer={
              <>
                <nav aria-label="Setup navigation" className="flex items-center justify-between gap-3">
                  <Button
                    variant="ghost"
                    disabled={locked || currentIndex === 0}
                    onClick={() => chooseStep(builderSteps[currentIndex - 1]!.id)}
                  >
                    Back
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {currentIndex + 1} of {builderSteps.length}
                  </p>
                </nav>
                <FormFooter
                  dirty={dirty && !terminal}
                  submit={{
                    label: step === 'review' ? 'Create and activate' : currentIndex === 3 ? 'Review agent' : 'Continue',
                    pendingLabel: 'Saving setup…',
                    state: sending
                      ? { kind: 'busy' }
                      : locked
                        ? {
                            kind: 'blocked',
                            reason: uncertain
                              ? 'Check the saved status before trying again.'
                              : 'Review the save result below.',
                          }
                        : { kind: 'ready' },
                  }}
                  secondarySubmit={{
                    label: 'Save draft',
                    disabled: locked,
                    onSelect: () => {
                      submitIntent.current = 'save';
                    },
                  }}
                  error={showErrors ? parsed.problems.map(problem => problem.message).join(' ') : undefined}
                  note={
                    step === 'review'
                      ? 'Nothing new runs unless activation completes.'
                      : 'Move between sections freely. Your choices stay here.'
                  }
                >
                  <WriteFeedback
                    state={write.state}
                    checkStatus={() => {
                      if (commandId) void status.refresh();
                      else if ('input' in write.state) void write.submit(write.state.input);
                    }}
                    retry={input => void write.submit(input)}
                  />
                  {commandId && (
                    <AgentRead state={status.state} refresh={status.refresh}>
                      {value => (
                        <p role="status" className="text-sm">
                          {resultText[value.status]}
                        </p>
                      )}
                    </AgentRead>
                  )}
                  {status.delayed && (
                    <p role="status" className="text-sm">
                      Automatic status checks stopped. The save may still be running.
                    </p>
                  )}
                  {receipt?.error && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        Setup stopped: {receipt.error}. Recheck access and trigger settings. The earlier active setup
                        was not replaced.
                      </AlertDescription>
                    </Alert>
                  )}
                  {statusError && (
                    <Alert variant="destructive">
                      <AlertDescription>{statusError}</AlertDescription>
                    </Alert>
                  )}
                  {commandId && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={write.state.kind === 'sending'}
                        onClick={() => void status.refresh()}
                      >
                        Check setup status
                      </Button>
                      {terminal && (
                        <Button variant="outline" onClick={() => void continueEditing()}>
                          Continue editing
                        </Button>
                      )}
                      {receipt?.status === 'blocked' && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setStatusError('');
                            void api.retrySetupCommand(receipt.commandId).then(
                              value => {
                                setLatest(value);
                                void status.refresh();
                              },
                              error => {
                                setStatusError(
                                  error instanceof Error
                                    ? error.message
                                    : 'Could not retry setup. Check its status again.',
                                );
                              },
                            );
                          }}
                        >
                          Retry this setup
                        </Button>
                      )}
                    </div>
                  )}
                </FormFooter>
              </>
            }
          />
          <Sheet open={importOpen} onOpenChange={setImportOpen}>
            <SheetContent size="lg">
              <SheetHeader>
                <SheetTitle>Import skills for this agent</SheetTitle>
                <SheetDescription>
                  Review before installing. Installed skills stay in your workspace even if you discard the agent draft.
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {importError && (
                  <div className="mb-4">
                    <Alert variant="destructive">
                      <AlertDescription>{importError}</AlertDescription>
                    </Alert>
                  </div>
                )}
                {importId ? (
                  <SkillImportPanel
                    importId={importId}
                    onOpen={setImportId}
                    onRestart={() => {
                      setImportId(null);
                      setImportError('');
                    }}
                    onInstalled={receipts => {
                      const usable = receipts.filter(receipt => receipt.enabled && receipt.activeRevision);
                      const current = draft.definition.skills ?? [];
                      const next = [
                        ...current.filter(skill => !usable.some(receipt => receipt.id === skill.id)),
                        ...usable.map(receipt => ({ id: receipt.id, revision: receipt.activeRevision! })),
                      ];
                      if (next.length > 16) {
                        setImportError(
                          'These skills are installed, but the agent would exceed 16 skills. Close this panel and remove some selections before adding them.',
                        );
                        return;
                      }
                      if (usable.length !== receipts.length) {
                        setImportError(
                          'Some installed skills are not active. Enable them in Skills before selecting them.',
                        );
                        return;
                      }
                      updateDefinition({ skills: next });
                      setImportOpen(false);
                      setImportError('');
                    }}
                  />
                ) : (
                  <ImportSkillForm onOpen={setImportId} />
                )}
              </div>
            </SheetContent>
          </Sheet>
        </>
      )}
    </section>
  );
}
