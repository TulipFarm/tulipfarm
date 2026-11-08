import { useState, type ReactNode, type RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import type { AuthoringProposal, DraftView } from '@tulipfarm/agents/draft-contracts';
import { unattendedTrigger, type PublishAgentSetup } from '@tulipfarm/agents/setup-contracts';
import { Users } from 'reicon-react/icons/Users';
import { Button } from '@tulipfarm/sprout/button';
import { CheckboxField } from '@tulipfarm/sprout/field';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { MoreH } from 'reicon-react/icons/MoreH';
import { ReviewCard } from '@tulipfarm/sprout/review-card';
import { UnsavedChanges } from '@/features/tables/feedback';
import { AgentSetupReview, setupTriggerLabel, useTriggerTableNames } from '@/features/agents/setup-review';
import { workspaceRoute } from '@/router';
import type { ConversationCommand } from './conversation-api';

type Decision = Extract<ConversationCommand, { kind: 'draft-decision' }>;
export function AgentSetupDraftCard({
  draft,
  proposal,
  chatId,
  locked,
  dirty,
  decide,
  result,
  feedback,
  checkStatus,
}: {
  draft: DraftView;
  proposal: Extract<AuthoringProposal, { kind: 'agent' }>;
  chatId: string;
  locked: boolean;
  dirty: boolean;
  decide: (decision: Decision['decision'], consent?: Decision['consent']) => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const [consent, setConsent] = useState<PublishAgentSetup['consent']>({ sponsorTriggerIds: [], replaceChannels: [] });
  const tableNames = useTriggerTableNames(workspace.id, proposal.input.setup?.triggers ?? []);
  if (!proposal.input.setup) return null;
  const setup = {
    ...proposal.input.setup,
    definition: proposal.input.definition,
    owningTeamId: proposal.input.owningTeamId,
  };
  const receipt = draft.outcome?.kind === 'agent' ? draft.outcome.setupReceipt : undefined;
  const replacements = setup.slackChannels.filter(
    channel => channel.replaceAgentId && channel.replaceAgentId !== proposal.targetId,
  );
  const sponsored = setup.triggers.filter(item => unattendedTrigger(item.trigger));
  const ready =
    sponsored.every(item => consent.sponsorTriggerIds.includes(item.id)) &&
    replacements.every(channel => consent.replaceChannels.includes(channel.channel));
  const updating = proposal.input.expectedSavedRevision !== null;
  const handoff = {
    setupAgentId: proposal.targetId,
    ...(draft.status === 'pending' ? { chatId, draftId: draft.id } : {}),
  };
  const badge =
    receipt?.status === 'active'
      ? { label: 'Active', variant: 'success' as const }
      : receipt?.status === 'blocked'
        ? { label: 'Setup incomplete', variant: 'warning' as const }
        : {
            label:
              draft.status === 'pending'
                ? 'Draft'
                : draft.status === 'preparing'
                  ? 'Saving'
                  : draft.status === 'saved'
                    ? 'Saved draft'
                    : draft.status === 'dismissed'
                      ? 'Dismissed'
                      : 'Needs review',
            variant: 'secondary' as const,
          };
  return (
    <ReviewCard
      label="Review agent draft"
      icon={<Users size={16} />}
      title={setup.definition.name}
      badge={badge}
      settled={!['pending', 'preparing'].includes(draft.status)}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button disabled={locked || !ready} onClick={() => decide('activate', consent)}>
              {updating ? 'Save and activate' : 'Create and activate'}
            </Button>
            <Button variant="outline" disabled={locked} onClick={() => decide('save')}>
              Save draft
            </Button>
            <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
              Not now
            </Button>
          </>
        ) : undefined
      }
      status={
        <>
          <UnsavedChanges dirty={dirty} />
          <div ref={result} tabIndex={-1} className="text-sm">
            {draft.status === 'preparing' && (
              <p role="status">Your review is recorded. Setup is being saved. You can return to this chat later.</p>
            )}
            {receipt?.status === 'active' && (
              <p role="status">Agent active. Its reviewed access and triggers are now in place.</p>
            )}
            {receipt?.status === 'active' && !!receipt.workflows.length && (
              <ul aria-label="Workflows that run this agent" className="mt-2 grid gap-1">
                {receipt.workflows.map((item, index) => {
                  const trigger = setup.triggers.find(candidate => candidate.id === item.triggerId);
                  return (
                    <li key={item.workflowId}>
                      <Button
                        variant="link"
                        size="sm"
                        nativeButton={false}
                        render={
                          <Link
                            to="/$workspaceSlug/workflows/$workflowId"
                            params={{ workspaceSlug: workspace.slug, workflowId: item.workflowId }}
                          />
                        }
                      >
                        {`Workflow ${index + 1}${trigger ? `: ${setupTriggerLabel(trigger.trigger, tableNames)}` : ''}`}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {receipt?.status === 'saved' && (
              <p role="status">Draft saved. No new triggers were started. Any earlier active revision is unchanged.</p>
            )}
            {receipt?.status === 'blocked' && (
              <p role="status">
                Instructions saved, but setup is incomplete. No new triggers were started. Continue in the builder to
                fix or retry this setup.
              </p>
            )}
            {draft.status === 'stale' && (
              <p role="status">This proposal is out of date. Ask chat for a fresh draft before approving changes.</p>
            )}
            {draft.status === 'failed' && receipt?.status !== 'blocked' && (
              <p role="status">Setup did not finish. Check its status before trying again.</p>
            )}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was saved or activated.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <p className="text-sm">
        {updating
          ? 'Updates the existing agent. The earlier active setup remains until this replacement succeeds.'
          : 'Creates a new agent. Review the exact setup below before activating it.'}
      </p>
      <AgentSetupReview workspaceId={workspace.id} setup={setup} />
      {draft.status === 'pending' && (
        <fieldset disabled={locked} className="grid gap-3">
          <legend className="sr-only">Activation consent</legend>
          {sponsored.map((item, index) => (
            <CheckboxField
              key={item.id}
              id={`draft-${draft.id}-trigger-${item.id}`}
              label={`I sponsor trigger ${index + 1}: ${setupTriggerLabel(item.trigger, tableNames)}`}
              helper="Activating creates a workflow that runs this agent with your current permissions and creates private tasks."
              checked={consent.sponsorTriggerIds.includes(item.id)}
              onCheckedChange={checked =>
                setConsent(previous => ({
                  ...previous,
                  sponsorTriggerIds: checked
                    ? [...previous.sponsorTriggerIds, item.id]
                    : previous.sponsorTriggerIds.filter(id => id !== item.id),
                }))
              }
            />
          ))}
          {replacements.map((channel, index) => (
            <CheckboxField
              key={channel.channel}
              id={`draft-${draft.id}-${channel.channel}`}
              label={`Replace the existing agent in channel ${index + 1}`}
              helper="Existing threads keep their original agent. Check the channel identity in Setup details."
              checked={consent.replaceChannels.includes(channel.channel)}
              onCheckedChange={checked =>
                setConsent(previous => ({
                  ...previous,
                  replaceChannels: checked
                    ? [...previous.replaceChannels, channel.channel]
                    : previous.replaceChannels.filter(id => id !== channel.channel),
                }))
              }
            />
          ))}
        </fieldset>
      )}
      {(draft.status === 'pending' || receipt) && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={dirty || draft.status === 'preparing'}
            nativeButton={false}
            render={
              <Link to="/$workspaceSlug/agents/new" params={{ workspaceSlug: workspace.slug }} search={handoff} />
            }
          >
            {draft.status === 'pending' ? 'Edit in builder' : 'Continue setup'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={dirty || draft.status === 'preparing'}
                  aria-label="More setup options"
                />
              }
            >
              <MoreH size={16} aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                render={
                  <Link
                    to="/$workspaceSlug/agents/new"
                    params={{ workspaceSlug: workspace.slug }}
                    search={{ ...handoff, step: 'access' }}
                  />
                }
              >
                Add actions
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    to="/$workspaceSlug/agents/new"
                    params={{ workspaceSlug: workspace.slug }}
                    search={{ ...handoff, step: 'skills' }}
                  />
                }
              >
                Add skills
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Only this review action can save or activate the setup. Chat text is not approval.
      </p>
      {checkStatus}
    </ReviewCard>
  );
}
