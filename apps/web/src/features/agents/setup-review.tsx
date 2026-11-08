import { useMemo } from 'react';
import { z } from 'zod';
import type { AgentSetup } from '@tulipfarm/agents/setup-contracts';
import { Badge } from '@tulipfarm/sprout/badge';
import { Disclosure } from '@/components/disclosure';
import { useFeatureRead } from '@/lib/query';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import { ModelOption } from '@/features/models/model-option';
import { skillApi } from '@/features/skills/api';
import { useSkillDetail } from '@/features/skills/queries';
import { triggerLine, TriggerIcon } from '@/features/workflows/workflow-summary';
import { describeGitHubTrigger, type GitHubNames } from '@/features/workflows/definition-description';
import { useGitHubNames, useRowTableNames } from '@/features/workflows/queries';
import { AgentDraftSummary } from './builder-preview';
import { agentApi } from './api';
import { agentReads } from './queries';
import { AgentRead } from './feedback';
import { useSharingCandidates } from './sharing';
import { ScopeSummary, useSlackDestinationNames } from './reference-names';
import { toolLabels } from './labels';
import { changingTools } from './tool-picker';

type SetupTrigger = AgentSetup['triggers'][number];

export function setupTriggerLabel(
  trigger: SetupTrigger['trigger'],
  names?: GitHubNames,
  tableNames?: ReadonlyMap<string, string>,
) {
  return trigger.kind === 'github' ? describeGitHubTrigger(trigger, names) : triggerLine(trigger, tableNames);
}

/** Trigger names for a setup, with GitHub repositories, accounts and watched tables named rather than numbered. */
export function useSetupTriggerNames(workspaceId: string, triggers: readonly SetupTrigger[]) {
  const names = useGitHubNames(
    workspaceId,
    triggers.map(item => item.trigger),
  );
  const tableNames = useRowTableNames(
    workspaceId,
    triggers.map(item => item.trigger),
  );
  return (item: SetupTrigger) => item.label ?? setupTriggerLabel(item.trigger, names, tableNames);
}

export function AgentSetupReview({
  workspaceId,
  setup,
  channelNames = {},
}: {
  workspaceId: string;
  setup: AgentSetup;
  channelNames?: Readonly<Record<string, string>>;
}) {
  const api = useMemo(() => agentApi(workspaceId), [workspaceId]);
  const context = useFeatureRead(agentReads.context(api));
  const candidates = useSharingCandidates(workspaceId);
  const catalog = useModelCatalog(workspaceId);
  const triggerName = useSetupTriggerNames(workspaceId, setup.triggers);
  const slack = useSlackDestinationNames(workspaceId, setup.scope);
  const limits = setup.runLimits ?? setup.taskLimits;
  const family =
    catalog.state.kind === 'ready'
      ? catalog.state.data.families.find(item => item.id === setup.definition.modelFamilyId)
      : undefined;
  const teamName = (id: string) =>
    context.state.kind === 'ready'
      ? (context.state.data.teams.find(team => team.id === id)?.name ?? 'Team name unavailable')
      : 'Loading team name';
  return (
    <div className="grid min-w-0 gap-5">
      <AgentDraftSummary
        name={setup.definition.name}
        instructions={setup.definition.instructions}
        team={setup.owningTeamId ? teamName(setup.owningTeamId) : undefined}
        model={
          family ? (
            <ModelOption family={family} />
          ) : setup.definition.modelFamilyId ? (
            'Selected model unavailable'
          ) : (
            'Workspace default'
          )
        }
        skills={setup.definition.skills ?? []}
        tools={setup.definition.tools}
        channelNames={setup.slackChannels
          .filter(item => !item.detach)
          .map(item => channelNames[item.channel] ?? item.channel)}
        postsTo={slack.postsTo}
        triggerLabels={setup.triggers.map(triggerName)}
      />
      {!!setup.definition.skills?.length && (
        <section aria-label="Reviewed skills" className="grid gap-2">
          <h3 className="text-sm font-medium">Skills</h3>
          <ul className="grid gap-1">
            {setup.definition.skills.map(skill => (
              <DraftSkill key={skill.id} workspaceId={workspaceId} id={skill.id} />
            ))}
          </ul>
        </section>
      )}
      {!!setup.definition.tools.length && (
        <section aria-label="Reviewed actions" className="grid gap-2">
          <h3 className="text-sm font-medium">Permitted actions</h3>
          <ul className="flex flex-wrap gap-1.5">
            {setup.definition.tools.map(tool => (
              <li key={tool}>
                <Badge variant={changingTools.has(tool) ? 'warning' : 'secondary'}>{toolLabels[tool]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Reviewed access" className="grid gap-3 border-t pt-4 text-sm">
        <h3 className="font-medium">Data and sharing</h3>
        <p>
          <ScopeSummary workspaceId={workspaceId} scope={setup.scope} />
        </p>
        <p>Team permissions: {setup.enrollment.length ? setup.enrollment.map(teamName).join(', ') : 'None'}.</p>
        <AgentRead state={candidates.state} refresh={candidates.refresh}>
          {data => (
            <ul aria-label="Who can use this agent" className="grid gap-2">
              {setup.policy.grants
                .filter(grant => grant.permissions.length)
                .map(grant => (
                  <li key={grant.teamId}>
                    {data.teams.find(team => team.id === grant.teamId)?.name ?? 'Team name unavailable'}:{' '}
                    {grant.permissions.join(', ')}
                  </li>
                ))}
              {setup.policy.personGrants
                .filter(grant => grant.permissions.length)
                .map(grant => (
                  <li key={grant.membershipId}>
                    {data.people.find(person => person.membershipId === grant.membershipId)?.name ??
                      'Person name unavailable'}
                    : {grant.permissions.join(', ')}
                  </li>
                ))}
            </ul>
          )}
        </AgentRead>
        <p>The creator keeps manager access on a new agent. Slack channel access does not grant settings access.</p>
        <p>
          Each task: {setup.taskLimits.toolCalls} tool calls, {setup.taskLimits.activeMilliseconds / 1000} active
          seconds, {setup.taskLimits.credits} credits.
        </p>
        {!!setup.definition.mcp?.length && (
          <p>
            {setup.definition.mcp.reduce((count, slot) => count + slot.tools.length, 0)} reviewed MCP tools. Exact
            integrations and revisions are in Details.
          </p>
        )}
      </section>
      {!!setup.slackChannels.length && (
        <section aria-label="Reviewed Slack channels" className="grid gap-2 border-t pt-4 text-sm">
          <h3 className="font-medium">Slack</h3>
          <p>
            {setup.slackChannels.filter(channel => !channel.detach).length} attached channels.{' '}
            {setup.slackChannels.filter(channel => channel.detach).length} detachments.
          </p>
          <p>
            {setup.definition.responseRule === 'every-message'
              ? 'Replies to every channel message.'
              : 'Replies when mentioned, then follows the thread.'}{' '}
            Callers need a linked, current workspace membership and channel access.
          </p>
          <p>
            Outgoing actions use {setup.slackSender === 'app' ? 'the workspace app' : 'the caller’s Slack integration'}.
          </p>
        </section>
      )}
      {(!!setup.triggers.length || !!setup.prompt) && (
        <section aria-label="Reviewed triggers" className="grid gap-3 border-t pt-4 text-sm">
          <h3 className="font-medium">Triggers</h3>
          <p className="text-muted-foreground">
            {setup.triggers.length
              ? 'Activating saves these triggers to this agent’s workflow. Each one runs the agent with the task below.'
              : 'Activating saves this task to this agent’s workflow. It runs only when someone starts it.'}
          </p>
          {setup.triggers.map(item => (
            <div key={item.id} className="flex items-center gap-3">
              <TriggerIcon trigger={item.trigger} />
              <p className="min-w-0 font-medium wrap-anywhere">{triggerName(item)}</p>
            </div>
          ))}
          {setup.prompt && (
            <div className="grid gap-1">
              <p className="font-medium">Task</p>
              <p className="whitespace-pre-wrap wrap-anywhere">{setup.prompt}</p>
              <p className="text-muted-foreground">
                {limits.toolCalls} tool calls, {limits.activeMilliseconds / 1000} active seconds, {limits.credits}{' '}
                credits per run.
              </p>
            </div>
          )}
        </section>
      )}
      <Disclosure title="Setup details">
        <pre className="whitespace-pre-wrap wrap-anywhere text-xs">
          {JSON.stringify({ ...setup, definition: { ...setup.definition, instructions: undefined } }, null, 2)}
        </pre>
      </Disclosure>
    </div>
  );
}

export function DraftSkill({ workspaceId, id }: { workspaceId: string; id: string }) {
  const api = useMemo(() => skillApi(workspaceId), [workspaceId]);
  const workspaceSkill = z.uuid().safeParse(id).success;
  const detail = useSkillDetail(api, id, workspaceSkill);
  const name = !workspaceSkill
    ? `Built-in skill: ${id}`
    : detail.state.kind === 'ready'
      ? (detail.state.data.reviewedDefinition?.name ?? detail.state.data.definition.name)
      : detail.state.kind === 'loading'
        ? 'Loading skill name…'
        : 'Skill name unavailable. See setup details.';
  return <li className="wrap-anywhere text-sm">{name}</li>;
}
