import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { BookOpen } from 'reicon-react/icons/BookOpen';
import { Users } from 'reicon-react/icons/Users';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { BrandStack, type Brand } from '@tulipfarm/sprout/brand-icon';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { UnsavedChanges } from '@/features/tables/feedback';
import type {
  AgentDefinitionField,
  AuthoringProposal,
  DraftOutcome,
  WorkflowProposal,
} from '@tulipfarm/agents/draft-contracts';
import { RowDraftCard, TechnicalDetail } from './row-draft-card';
import { formatRun, workflowChange, workflowSaveLabel } from './workflow-draft-details';
import { WorkflowCanvasButton } from './workflow-canvas';
import { GitHubInstallNote } from '@/features/workflows/github-install-note';
import { WorkflowSlackCheck } from '@/features/workflows/slack-step';
import type { ConversationApi, ConversationCommand } from './conversation-api';
import { AgentSetupDraftCard } from './agent-setup-draft-card';
import { DraftSkill } from '@/features/agents/setup-review';
import { useConversationCommand } from './conversation-state';
import { useAuthoringDraft, draftPending as pending } from './queries';
import { Badge } from '@tulipfarm/sprout/badge';
import { Disclosure } from '@/components/disclosure';
import { workspaceRoute } from '@/router';
import { useFeatureRead } from '@/lib/query';
import { agentApi } from '@/features/agents/api';
import { agentReads } from '@/features/agents/queries';
import { toolLabels } from '@/features/agents/labels';
import { changingTools } from '@/features/agents/tool-picker';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import { useResultAttention } from './canvas-state';

export function AuthoringDraftCard({ api, chatId, id }: { api: ConversationApi; chatId: string; id: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const write = useConversationCommand(api, () => {});
  const result = useRef<HTMLDivElement>(null);
  const submitted = useRef(false);
  const [slackReady, setSlackReady] = useState<Record<string, boolean>>({});
  const onSlackReady = useCallback(
    (id: string, ready: boolean) =>
      setSlackReady(current => (current[id] === ready ? current : { ...current, [id]: ready })),
    [],
  );
  const denied = write.state.kind === 'rejected' && [401, 403, 404].includes(write.state.status);
  const read = useAuthoringDraft(api, chatId, id, !denied);
  const draft = read.state.kind === 'ready' ? read.state.data : null;
  useResultAttention(`draft:${id}`, draft?.status === 'pending', 'A draft needs your review');
  useEffect(() => {
    if (submitted.current && draft && !pending(draft)) {
      result.current?.focus();
      submitted.current = false;
    }
  }, [draft]);
  if (denied || read.state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        title="Draft unavailable"
        description="This draft is missing or your current access does not allow it. Its definition has been cleared."
      />
    );
  if (read.state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading authoring draft">
        <Skeleton />
        <span className="sr-only">Loading draft…</span>
      </div>
    );
  if (read.state.kind === 'error')
    return (
      <StatePanel kind="error" title="Could not load draft" description="The saved draft state is unknown.">
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry loading draft
        </Button>
      </StatePanel>
    );
  if (!draft) return null;
  const proposal = draft.proposal;
  const slackUnchecked =
    (proposal.kind === 'workflow' || (proposal.kind === 'workflow-activation' && proposal.input.enabled)) &&
    proposal.input.definition.steps.some(step => step.kind === 'slack-message' && !slackReady[step.destinationId]);
  const locked =
    write.locked ||
    write.state.kind === 'accepted' ||
    read.state.kind !== 'ready' ||
    !!read.state.error ||
    read.state.refreshing;
  const decide = (
    decision: Extract<ConversationCommand, { kind: 'draft-decision' }>['decision'],
    consent?: Extract<ConversationCommand, { kind: 'draft-decision' }>['consent'],
  ) => {
    if (locked || (decision === 'save' && slackUnchecked)) return;
    submitted.current = true;
    void write.submit({
      kind: 'draft-decision',
      chatId,
      draftId: id,
      commandId: crypto.randomUUID(),
      digest: draft.digest,
      decision,
      ...(consent ? { consent } : {}),
    });
  };
  const feedback = (
    <>
      {read.state.kind === 'ready' && read.state.error && (
        <Alert variant="destructive">
          <AlertDescription>Could not refresh this draft. Check its status before deciding.</AlertDescription>
        </Alert>
      )}
      {write.state.kind === 'sending' && (
        <p role="status" className="text-sm">
          Recording your decision…
        </p>
      )}
      {write.state.kind === 'uncertain' && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>
              The outcome is uncertain. Retry the exact decision without creating another save.
            </AlertDescription>
          </Alert>
          <Button
            variant="outline"
            onClick={() => {
              if (write.state.kind === 'uncertain') void write.submit(write.state.command);
            }}
          >
            Retry same decision
          </Button>
        </div>
      )}
      {write.state.kind === 'rejected' && (
        <Alert variant="destructive">
          <AlertDescription>{write.state.message}</AlertDescription>
        </Alert>
      )}
      {read.delayed && (
        <p className="text-sm text-muted-foreground">
          Automatic checks stopped after a minute. Check draft status for an update.
        </p>
      )}
    </>
  );
  const checkStatus = (
    <Button
      size="sm"
      variant="ghost"
      disabled={write.state.kind === 'sending' || (read.state.kind === 'ready' && read.state.refreshing)}
      onClick={async () => {
        await read.refresh();
        if (write.state.kind === 'rejected') write.reset();
      }}
    >
      Check draft status
    </Button>
  );
  if (proposal.kind === 'row')
    return (
      <RowDraftCard
        id={id}
        draft={draft}
        proposal={proposal}
        locked={locked}
        sending={write.state.kind === 'sending'}
        dirty={write.state.kind === 'sending' || write.state.kind === 'uncertain'}
        decide={decide}
        result={result}
        feedback={feedback}
        checkStatus={checkStatus}
      />
    );
  if (proposal.kind === 'agent' && proposal.input.setup)
    return (
      <AgentSetupDraftCard
        key={draft.digest}
        draft={draft}
        proposal={proposal}
        chatId={chatId}
        locked={locked}
        dirty={write.state.kind === 'sending' || write.state.kind === 'uncertain'}
        decide={decide}
        result={result}
        feedback={feedback}
        checkStatus={checkStatus}
      />
    );
  const definition = proposal.input.definition;
  const workflow: WorkflowProposal | null =
    proposal.kind === 'workflow' || proposal.kind === 'workflow-activation' ? proposal : null;
  const noun = workflow ? 'workflow' : proposal.kind === 'agent' ? 'agent' : 'skill';
  const brands = proposal.kind === 'agent' ? toolBrands(proposal.input.definition.tools) : [];
  // Only a new agent starts off. Saving over an existing agent leaves its on or off state and active revision as they were.
  const updating = proposal.kind === 'agent' && proposal.input.expectedSavedRevision !== null;
  return (
    <ReviewCard
      label={`Review ${noun} draft`}
      icon={
        workflow ? <BranchDown size={16} /> : proposal.kind === 'agent' ? <Users size={16} /> : <BookOpen size={16} />
      }
      title={definition.name}
      badge={badges[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button
              disabled={locked || slackUnchecked}
              aria-busy={write.state.kind === 'sending'}
              onClick={() => decide('save')}
            >
              {workflow ? workflowSaveLabel(workflow) : proposal.kind === 'agent' ? 'Save agent' : 'Save skill'}
            </Button>
            <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
              Not now
            </Button>
          </>
        ) : undefined
      }
      status={
        <>
          <UnsavedChanges dirty={write.state.kind === 'sending' || write.state.kind === 'uncertain'} />
          <div ref={result} tabIndex={-1} className="text-sm">
            {draft.status === 'stale' && (
              <div className="space-y-2">
                <p role="status">
                  The target or workspace definition changed. Ask chat for a fresh draft and review it again.
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss draft
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && (
              <p role="status">The definition could not be saved. Ask chat for a fresh draft.</p>
            )}
            {draft.status === 'preparing' && (
              <p role="status">
                Your review is recorded. The definition is being saved. You can leave this chat and return later.
              </p>
            )}
            {draft.status === 'saved' && (
              <p role="status">
                {workflow && draft.outcome?.kind === 'workflow'
                  ? workflowResult(draft.outcome, workflow)
                  : proposal.kind === 'agent'
                    ? updating
                      ? 'Agent saved. These changes stay inactive until an agent manager activates this revision.'
                      : 'Agent saved. It stays off until an agent manager activates this revision.'
                    : 'Skill saved. Agents use it only after a skill manager reviews this revision.'}
              </p>
            )}
            {draft.status === 'dismissed' && (
              <p role="status">
                {workflow
                  ? 'Draft dismissed. Nothing was saved or activated.'
                  : 'Draft dismissed. No definition was saved.'}
              </p>
            )}
          </div>
          {feedback}
        </>
      }
    >
      {draft.agentChange && (
        <ReviewRows>
          <ReviewRow label="Change">
            {draft.agentChange.kind === 'create' ? (
              <span>Creates a new agent</span>
            ) : (
              <span>
                Updates existing agent{draft.agentChange.current ? ` “${draft.agentChange.current.name}”` : ''}
              </span>
            )}
          </ReviewRow>
          {draft.agentChange.kind === 'update' && (
            <ReviewRow label="Changed fields">
              <span>
                {draft.agentChange.current
                  ? draft.agentChange.current.changedFields.map(field => agentFieldLabels[field]).join(', ') ||
                    'No definition changes'
                  : 'Current definition unavailable'}
              </span>
            </ReviewRow>
          )}
        </ReviewRows>
      )}
      {workflow ? (
        <div className="space-y-3">
          <p className="text-sm">{workflowChange(workflow)}</p>
          <p className="text-sm">
            {workflow.input.definition.steps.length} {workflow.input.definition.steps.length === 1 ? 'step' : 'steps'}.{' '}
            {draft.workflowNextRunAt
              ? `Next run ${formatRun(draft.workflowNextRunAt, workflow.input.definition.trigger)}.`
              : 'Review the trigger, actors, and steps in Canvas.'}
          </p>
          {workflow.input.definition.trigger.kind === 'github' && (
            <p className="text-sm">
              <GitHubInstallNote workspaceId={workspace.id} />
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <WorkflowCanvasButton
              workspaceId={workspace.id}
              reference={{ kind: 'draft', chatId, draftId: id }}
              name="View workflow draft"
            />
            {draft.outcome?.kind === 'workflow' && (
              <WorkflowCanvasButton
                workspaceId={workspace.id}
                reference={{
                  kind: 'definition',
                  workflowId: draft.outcome.workflowId,
                  revision: draft.outcome.revision,
                }}
                name="View saved workflow"
              />
            )}
          </div>
          {draft.status === 'pending' &&
            [
              ...new Set(
                workflow.input.definition.steps.flatMap(step =>
                  step.kind === 'slack-message' ? [step.destinationId] : [],
                ),
              ),
            ].map(destinationId => (
              <WorkflowSlackCheck
                key={`${draft.digest}:${destinationId}`}
                workspaceId={workspace.id}
                id={destinationId}
                onReady={onSlackReady}
              />
            ))}
        </div>
      ) : (
        <>
          {proposal.kind === 'skill' && 'description' in definition && definition.description && (
            <p className="text-sm">{definition.description}</p>
          )}
          {'instructions' in definition && (
            <p className="whitespace-pre-wrap break-words text-sm">{definition.instructions}</p>
          )}
        </>
      )}
      {proposal.kind === 'agent' && (
        <AgentDraftRows
          workspaceId={workspace.id}
          owningTeamId={proposal.input.owningTeamId}
          definition={proposal.input.definition}
          brands={brands}
        />
      )}
      <p className="text-xs text-muted-foreground">
        {workflow
          ? workflowNote(workflow)
          : proposal.kind === 'agent'
            ? updating
              ? 'Saving does not activate these changes. An agent manager must activate the exact saved revision separately.'
              : 'Saving does not activate this agent. An agent manager must turn on execution and activate its exact saved revision separately.'
            : 'Saving creates a workspace skill draft. A skill manager must review its exact revision separately. Skills grant no authority.'}
      </p>
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          {draft.agentChange?.kind === 'update' && (
            <TechnicalDetail term="Agent ID">{draft.agentChange.agentId}</TechnicalDetail>
          )}
          {proposal.kind === 'agent' && (
            <>
              <TechnicalDetail term="Team ID">{proposal.input.owningTeamId ?? 'None (personal agent)'}</TechnicalDetail>
              {proposal.input.definition.modelFamilyId && (
                <TechnicalDetail term="Model family ID">{proposal.input.definition.modelFamilyId}</TechnicalDetail>
              )}
              <TechnicalDetail term="Tool IDs">{proposal.input.definition.tools.join(', ') || 'None'}</TechnicalDetail>
              <TechnicalDetail term="Skill revisions">
                {proposal.input.definition.skills
                  ?.map(skill => `${skill.id} · Revision ${skill.revision}`)
                  .join(', ') || 'None'}
              </TechnicalDetail>
            </>
          )}
          {workflow && <TechnicalDetail term="Workflow ID">{workflow.targetId}</TechnicalDetail>}
          <TechnicalDetail term="Draft ID">{id}</TechnicalDetail>
          <TechnicalDetail term="SHA-256">{draft.digest}</TechnicalDetail>
        </dl>
      </Disclosure>
      {checkStatus}
    </ReviewCard>
  );
}

type AgentDefinition = Extract<AuthoringProposal, { kind: 'agent' }>['input']['definition'];

function AgentDraftRows({
  workspaceId,
  owningTeamId,
  definition,
  brands,
}: {
  workspaceId: string;
  owningTeamId: string | null;
  definition: AgentDefinition;
  brands: { brand: Brand; name: string }[];
}) {
  const agents = useMemo(() => agentApi(workspaceId), [workspaceId]);
  const context = useFeatureRead({ ...agentReads.context(agents), enabled: owningTeamId !== null });
  const catalog = useModelCatalog(workspaceId);
  const team =
    owningTeamId === null
      ? 'Personal agent'
      : context.state.kind === 'ready'
        ? (context.state.data.teams.find(item => item.id === owningTeamId)?.name ?? 'A team you cannot see')
        : context.state.kind === 'loading'
          ? 'Loading team name…'
          : 'Team name unavailable. See technical details.';
  const model = !definition.modelFamilyId
    ? 'No preference'
    : ((catalog.state.kind === 'ready'
        ? catalog.state.data.families.find(family => family.id === definition.modelFamilyId)?.displayName
        : undefined) ?? definition.modelFamilyId);
  const changing = definition.tools.filter(tool => changingTools.has(tool)).length;
  return (
    <ReviewRows>
      <ReviewRow label="Team">{team}</ReviewRow>
      <ReviewRow label="Model">{model}</ReviewRow>
      <ReviewRow label="Actions">
        {definition.tools.length ? (
          <div className="grid justify-items-end gap-1">
            <BrandStack brands={brands} />
            <ul aria-label="Actions this agent may take" className="flex flex-wrap justify-end gap-1">
              {definition.tools.map(tool => (
                <li key={tool}>
                  <Badge variant={changingTools.has(tool) ? 'warning' : 'secondary'}>{toolLabels[tool]}</Badge>
                </li>
              ))}
            </ul>
            {changing > 0 && (
              <p className="text-xs text-muted-foreground">
                {changing === 1 ? '1 action changes data.' : `${changing} actions change data.`}
              </p>
            )}
          </div>
        ) : (
          <span>No actions selected.</span>
        )}
      </ReviewRow>
      <ReviewRow label="Skills">
        {definition.skills?.length ? (
          <ul aria-label="Pinned skills" className="flex flex-col items-end gap-1">
            {definition.skills.map(skill => (
              <DraftSkill key={skill.id} workspaceId={workspaceId} id={skill.id} />
            ))}
          </ul>
        ) : (
          <span>No skills selected.</span>
        )}
      </ReviewRow>
    </ReviewRows>
  );
}

function workflowResult(outcome: Extract<DraftOutcome, { kind: 'workflow' }>, proposal: WorkflowProposal) {
  switch (outcome.activation) {
    case 'not-requested':
      return outcome.enabled
        ? 'Workflow saved. The previously active revision keeps running until this one is activated.'
        : 'Workflow saved. It is not active. Activate it from chat or the Workflows page.';
    case 'activated':
      return outcome.nextRunAt
        ? `Workflow active. Next run ${formatRun(outcome.nextRunAt, proposal.input.definition.trigger)}.`
        : proposal.input.definition.trigger.kind === 'record'
          ? 'Workflow active. Upcoming record dates appear on the Workflows page within a minute.'
          : proposal.input.definition.trigger.kind === 'row'
            ? 'Workflow active. Runs start within about a minute of each matching row change.'
            : proposal.input.definition.trigger.kind === 'github'
              ? 'Workflow active. Runs start when GitHub sends a matching event.'
              : 'Workflow active.';
    case 'disabled':
      return 'Workflow disabled. It will not start new runs.';
    case 'sponsor-required':
      return 'Workflow saved but not activated. Another member sponsors it, so activate it from the Workflows page.';
    case 'audience-required':
      return 'Workflow saved but not activated. Someone who sees its run history cannot read the table. Change who sees run history on the Workflows page, then activate it.';
  }
}

function workflowNote(proposal: WorkflowProposal) {
  if (proposal.kind === 'workflow-activation' && !proposal.input.enabled)
    return 'Disabling stops new runs and blocks runs in progress.';
  const activates = proposal.kind === 'workflow-activation' || proposal.input.activate;
  return activates
    ? 'Scheduled, record-date and webhook runs start without you and run with your access as the sponsor. Webhook keys are created only on the Workflows page.'
    : 'Saving creates a revision you manage. It does not change which revision is active.';
}

const agentFieldLabels: Record<AgentDefinitionField, string> = {
  name: 'Name',
  instructions: 'Instructions',
  tools: 'Tools',
  modelFamilyId: 'Model family',
  skills: 'Skills',
  responseRule: 'Response rule',
  mcp: 'Connected app permissions',
};

const badges = {
  pending: { label: 'Draft', variant: 'secondary' },
  preparing: { label: 'Saving', variant: 'secondary' },
  saved: { label: 'Saved', variant: 'info' },
  dismissed: { label: 'Dismissed', variant: 'secondary' },
  stale: { label: 'Out of date', variant: 'warning' },
  failed: { label: 'Not saved', variant: 'destructive' },
} as const;

const toolBrandNames: [string, Brand, string][] = [
  ['google.', 'google', 'Google Workspace'],
  ['slack.', 'slack', 'Slack'],
  ['github.', 'github', 'GitHub'],
  ['atlassian.', 'jira', 'Atlassian'],
];
function toolBrands(tools: readonly string[]) {
  return toolBrandNames
    .filter(([prefix]) => tools.some(tool => tool.startsWith(prefix)))
    .map(([, brand, name]) => ({ brand, name }));
}
