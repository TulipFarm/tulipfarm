import { useState, type ReactNode, type RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import type { AuthoringProposal, DraftView } from '@tulipfarm/agents/draft-contracts';
import type { PublishAgentSetup } from '@tulipfarm/agents/setup-contracts';
import { Users } from 'reicon-react/icons/Users';
import { Button } from '@tulipfarm/sprout/button';
import { CheckboxField } from '@tulipfarm/sprout/field';
import { ReviewCard } from '@tulipfarm/sprout/review-card';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { UnsavedChanges } from '@/features/tables/feedback';
import { AgentSetupReview, setupScheduleLabel } from '@/features/agents/setup-review';
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
  const { workspace, membershipId } = workspaceRoute.useRouteContext();
  const [consent, setConsent] = useState<PublishAgentSetup['consent']>({ sponsorScheduleIds: [], replaceChannels: [] });
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
  const ready =
    setup.schedules.every(
      schedule => schedule.sponsorMembershipId === membershipId && consent.sponsorScheduleIds.includes(schedule.id),
    ) && replacements.every(channel => consent.replaceChannels.includes(channel.channel));
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
          {setup.schedules.map((schedule, index) =>
            schedule.sponsorMembershipId === membershipId ? (
              <CheckboxField
                key={schedule.id}
                id={`draft-${draft.id}-schedule-${schedule.id}`}
                label={`I sponsor schedule ${index + 1}: ${setupScheduleLabel(schedule.trigger)}`}
                helper="Runs use your current permissions and create private tasks."
                checked={consent.sponsorScheduleIds.includes(schedule.id)}
                onCheckedChange={checked =>
                  setConsent(previous => ({
                    ...previous,
                    sponsorScheduleIds: checked
                      ? [...previous.sponsorScheduleIds, schedule.id]
                      : previous.sponsorScheduleIds.filter(id => id !== schedule.id),
                  }))
                }
              />
            ) : (
              <Alert key={schedule.id} variant="destructive">
                <AlertDescription>
                  Schedule {index + 1} names another sponsor. Edit in the builder and choose to sponsor it yourself
                  before activating.
                </AlertDescription>
              </Alert>
            ),
          )}
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
        <div>
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
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Only this review action can save or activate the setup. Chat text is not approval.
      </p>
      {checkStatus}
    </ReviewCard>
  );
}
