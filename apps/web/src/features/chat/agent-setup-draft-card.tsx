import { useMemo, useState, type ReactNode, type RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import type { AuthoringProposal, DraftView } from '@tulipfarm/agents/draft-contracts';
import { unattendedTrigger, type PublishAgentSetup } from '@tulipfarm/agents/setup-contracts';
import { Users } from 'reicon-react/icons/Users';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
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
import { agentApi } from '@/features/agents/api';
import { setupErrorText } from '@/features/agents/setup-errors';
import { AgentSetupReview, useSetupTriggerNames } from '@/features/agents/setup-review';
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
  refresh,
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
  refresh: () => Promise<unknown>;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const agents = useMemo(() => agentApi(workspace.id), [workspace.id]);
  const [consent, setConsent] = useState<PublishAgentSetup['consent']>({ sponsor: false, replaceChannels: [] });
  const [retry, setRetry] = useState<{ kind: 'idle' | 'sending' } | { kind: 'error'; message: string }>({
    kind: 'idle',
  });
  const triggerName = useSetupTriggerNames(workspace.id, proposal.input.setup?.triggers ?? []);
  if (!proposal.input.setup) return null;
  const setup = {
    ...proposal.input.setup,
    definition: proposal.input.definition,
    owningTeamId: proposal.input.owningTeamId,
  };
  const receipt = draft.outcome?.kind === 'agent' ? draft.outcome.setupReceipt : undefined;
  const stopped = receipt?.status === 'blocked' || receipt?.status === 'failed';
  async function retrySetup(commandId: string) {
    setRetry({ kind: 'sending' });
    try {
      await agents.retrySetupCommand(commandId);
      await refresh();
      setRetry({ kind: 'idle' });
    } catch (error) {
      setRetry({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not retry setup. Check its status again.',
      });
    }
  }
  const replacements = setup.slackChannels.filter(
    channel => channel.replaceAgentId && channel.replaceAgentId !== proposal.targetId,
  );
  const sponsored = setup.triggers.filter(item => unattendedTrigger(item.trigger));
  const ready =
    (!sponsored.length || consent.sponsor) &&
    replacements.every(channel => consent.replaceChannels.includes(channel.channel));
  const updating = proposal.input.expectedSavedRevision !== null;
  const handoff = {
    setupAgentId: proposal.targetId,
    ...(draft.status === 'pending' ? { chatId, draftId: draft.id } : {}),
  };
  const badge =
    receipt?.status === 'active'
      ? { label: 'Active', variant: 'success' as const }
      : receipt?.status === 'conflict'
        ? { label: 'Out of date', variant: 'warning' as const }
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
            {receipt?.status === 'active' && receipt.workflowId && (
              <Button
                variant="link"
                size="sm"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug/workflows/$workflowId"
                    params={{ workspaceSlug: workspace.slug, workflowId: receipt.workflowId }}
                  />
                }
              >
                Open this agent&apos;s workflow
              </Button>
            )}
            {receipt?.status === 'conflict' && (
              <p role="status">
                This agent&apos;s workflow changed after this draft was made. Nothing was changed. Ask chat for a fresh
                draft.
              </p>
            )}
            {receipt?.status === 'saved' && (
              <p role="status">Draft saved. No new triggers were started. Any earlier active revision is unchanged.</p>
            )}
            {receipt?.status === 'blocked' && (
              <p role="status">Instructions saved, but setup is incomplete. No new triggers were started.</p>
            )}
            {draft.status === 'stale' && (
              <p role="status">This proposal is out of date. Ask chat for a fresh draft before approving changes.</p>
            )}
            {draft.status === 'failed' && receipt?.status !== 'blocked' && receipt?.status !== 'conflict' && (
              <p role="status">Setup did not finish. Check its status before trying again.</p>
            )}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was saved or activated.</p>}
          </div>
          {stopped && receipt.error && (
            <Alert variant="destructive">
              <AlertDescription>{setupErrorText(receipt.error)}</AlertDescription>
            </Alert>
          )}
          {retry.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>{retry.message}</AlertDescription>
            </Alert>
          )}
          {stopped && (
            <div className="flex flex-wrap gap-2">
              {receipt.status === 'blocked' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={dirty || retry.kind === 'sending'}
                  onClick={() => void retrySetup(receipt.commandId)}
                >
                  {retry.kind === 'sending' ? 'Retrying setup…' : 'Retry setup'}
                </Button>
              )}
              <Button
                variant="link"
                size="sm"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug/agents/$agentId"
                    params={{ workspaceSlug: workspace.slug, agentId: receipt.agentId }}
                  />
                }
              >
                Open agent to finish setup
              </Button>
            </div>
          )}
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
          {sponsored.length > 0 && (
            <CheckboxField
              id={`draft-${draft.id}-sponsor`}
              label={`I sponsor ${sponsored.length === 1 ? triggerName(sponsored[0]!) : `these ${sponsored.length} triggers`}`}
              helper="Runs use your current permissions and create private tasks."
              checked={consent.sponsor}
              onCheckedChange={sponsor => setConsent(previous => ({ ...previous, sponsor }))}
            />
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
