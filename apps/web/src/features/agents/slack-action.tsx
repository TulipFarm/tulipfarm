import { useMemo, useRef } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useSlackAction, useIntegrationChanges } from '@/features/integrations/queries';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { agentApi } from './api';
import { ResultCard, type ResultCardProps } from '@tulipfarm/sprout/result-card';
import { useOptionalCanvas } from '@/features/chat/canvas-state';
import { Disclosure } from '@/components/disclosure';
import { workspaceRoute } from '@/router';
import { failedWrite } from '@/features/tables/request-state';

export function SlackActionCanvas({ workspaceId, actionId }: { workspaceId: string; actionId: string }) {
  const api = useMemo(() => agentApi(workspaceId), [workspaceId]);
  const changes = useIntegrationChanges();
  return <SlackAction api={api} id={actionId} refresh={() => changes.content('slack')} variant="review" />;
}

export function SlackAction({
  api,
  id,
  refresh,
  variant = 'card',
}: {
  api: Pick<ReturnType<typeof agentApi>, 'slackAction' | 'slackDecision'>;
  id: string;
  refresh: () => Promise<void>;
  variant?: 'card' | 'review';
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const read = useSlackAction(api, id);
  const canvas = useOptionalCanvas();
  const changes = useIntegrationChanges();
  const heading = useRef<HTMLHeadingElement>(null);
  const mutationId = `slack-action:${id}`;
  const mutation = canvas?.actionMutations[mutationId];
  const write = useTableWrite(
    async (input: Parameters<typeof api.slackDecision>[1]) => {
      canvas?.setActionMutation(mutationId, 'pending');
      try {
        const result = await api.slackDecision(id, input);
        await changes.content('slack');
        canvas?.setActionMutation(mutationId, undefined);
        return result;
      } catch (error) {
        canvas?.setActionMutation(mutationId, failedWrite(input, error).kind === 'uncertain' ? 'uncertain' : undefined);
        throw error;
      }
    },
    () => {
      heading.current?.focus();
      void refresh();
    },
  );
  const busy = !!mutation || write.state.kind === 'sending' || write.state.kind === 'uncertain';
  const value = read.state.kind === 'ready' ? read.state.data : null;
  const outcome =
    mutation === 'uncertain' || write.state.kind === 'uncertain'
      ? 'unknown'
      : mutation === 'pending' || write.state.kind === 'sending'
        ? 'deciding'
        : value?.status;
  const card = value
    ? (action?: ResultCardProps['action']) => (
        <ResultCard
          title={
            value.action.tool === 'slack.reaction.add'
              ? 'Slack reaction'
              : value.action.tool === 'slack.thread.reply'
                ? 'Slack reply'
                : 'Slack message'
          }
          kind="Action"
          status={
            outcome === 'sent'
              ? 'Confirmed in Slack'
              : outcome === 'unknown'
                ? 'Action not confirmed'
                : outcome === 'approved'
                  ? 'Approved · Delivery not confirmed'
                  : outcome === 'pending'
                    ? 'Waiting for review'
                    : outcome === 'deciding'
                      ? 'Saving your decision'
                      : outcome === 'sending'
                        ? 'Sending'
                        : `Action ${outcome}`
          }
          state={
            outcome === 'sent'
              ? 'success'
              : outcome === 'unknown' || outcome === 'reauthorization-required'
                ? 'error'
                : outcome === 'sending' || outcome === 'deciding'
                  ? 'running'
                  : 'default'
          }
          apps={[
            {
              brand: 'slack',
              name: 'Slack',
              actions: [
                {
                  label:
                    value.action.tool === 'slack.reaction.add'
                      ? 'Add a reaction'
                      : value.action.tool === 'slack.thread.reply'
                        ? 'Reply to a thread'
                        : 'Send a message',
                  state:
                    outcome === 'sent'
                      ? 'completed'
                      : outcome === 'unknown'
                        ? 'unknown'
                        : outcome === 'sending'
                          ? 'running'
                          : outcome === 'reauthorization-required'
                            ? 'blocked'
                            : ['expired', 'stale', 'revoked', 'rejected'].includes(outcome ?? '')
                              ? 'cancelled'
                              : 'pending',
                },
              ],
            },
          ]}
          action={action}
        />
      )
    : null;
  if (canvas && variant === 'card' && card)
    return (
      <section aria-label="Slack action">
        {card({
          label: 'View Slack action',
          onClick: () =>
            canvas.show({
              id: `slack-action:${id}`,
              title: 'Slack action',
              content: { kind: 'slack-action', workspaceId: workspace.id, actionId: id },
            }),
        })}
        {read.state.kind === 'ready' && read.state.error && (
          <ReadError message="Could not refresh this Slack action. Open it to check its current status." />
        )}
      </section>
    );
  return (
    <section aria-label="Slack action" className="space-y-3">
      <h3 ref={heading} tabIndex={-1} className="sr-only">
        Slack action
      </h3>
      {card?.()}
      <ReadFeedback
        state={read.state}
        errorTitle="Could not load Slack action"
        retry={<Button onClick={() => void read.refresh()}>Try again</Button>}
        loading={
          <section role="status" aria-label="Loading Slack action">
            <Skeleton />
            <span className="sr-only">Loading Slack action…</span>
          </section>
        }
        unavailable={() => (
          <p className="text-sm text-muted-foreground">
            This Slack action is not available. Check your access. Delivery status cannot be confirmed here.
          </p>
        )}
        refreshError={message => <ReadError message={message} />}
        refreshing={<p role="status">Refreshing Slack action…</p>}
      >
        {value => (
          <>
            <p>
              Destination {value.channel}
              {value.action.tool === 'slack.thread.reply' ? `, thread ${value.action.threadTs}` : ''}
            </p>
            <Disclosure title="Delivery details">
              {value.status === 'sent' && value.sentMessageTs && <p>Sent message timestamp: {value.sentMessageTs}</p>}
            </Disclosure>
            <p>{value.sender === 'app' ? 'Posts as the TulipFarm app.' : 'Posts as your Slack account.'}</p>
            <p className="whitespace-pre-wrap break-words">
              {value.action.tool === 'slack.reaction.add'
                ? `Add ${value.action.reaction} to message ${value.action.messageTs}`
                : value.action.text}
            </p>
            {value.status === 'pending' && value.notificationStatus !== 'sent' && (
              <p role="status">
                The Slack approval notice{' '}
                {value.notificationStatus === 'retry'
                  ? 'is delayed'
                  : value.notificationStatus === 'sending'
                    ? 'is being delivered'
                    : 'has not been confirmed'}
                . You can review and approve or reject the message here.
              </p>
            )}
            <p role="status">
              {value.status === 'pending'
                ? 'Waiting for your approval. Nothing has been sent.'
                : value.status === 'approved'
                  ? 'Approved. Delivery has not been confirmed yet.'
                  : value.status === 'sent'
                    ? 'Slack confirmed this action.'
                    : value.status === 'unknown'
                      ? 'Delivery outcome is unknown. This action will not be sent again automatically. Check the destination in Slack. Only make a new request if you confirm the original action did not happen.'
                      : value.status === 'retry'
                        ? `Slack rejected this attempt due to its rate limit. Next check ${value.nextAttemptAt}.`
                        : value.status === 'reauthorization-required'
                          ? 'Slack rejected your credentials. Reconnect in workspace Integrations before starting a new action. Previous approvals will not be reused.'
                          : value.status === 'sending'
                            ? 'Delivery is in progress. Do not submit a duplicate.'
                            : `Action ${value.status}. Nothing further will be sent for this action.`}
            </p>
            {value.status === 'pending' && (
              <>
                <p>
                  Review the exact action above. Approval expires {new Date(value.expiresAt).toLocaleString()}. You can
                  leave this page while the original request waits.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy || read.state.kind !== 'ready' || read.state.refreshing || !!read.state.error}
                    aria-busy={write.state.kind === 'sending'}
                    onClick={() => void write.submit({ digest: value.digest, decision: 'approve' })}
                  >
                    Approve action
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void write.submit({ digest: value.digest, decision: 'reject' })}
                  >
                    Reject action
                  </Button>
                </div>
              </>
            )}
            {['expired', 'stale', 'revoked', 'rejected'].includes(value.status) && (
              <StatePanel
                kind="unavailable"
                title="This action is closed"
                description="Review current access and request a new action if it is still needed. This proposal cannot be changed or reused."
              />
            )}
          </>
        )}
      </ReadFeedback>
      <WriteFeedback
        state={write.state}
        retry={input => void write.submit(input)}
        checkStatus={() => void read.refresh()}
      />
      {mutation === 'uncertain' && (
        <p role="alert">The last decision is unconfirmed. Check status before taking another action.</p>
      )}
      <Button
        variant="outline"
        disabled={mutation === 'pending' || read.busy}
        onClick={() => {
          void read.refresh().then(result => {
            if (result && result.status !== 'pending') {
              canvas?.setActionMutation(mutationId, undefined);
              write.reset();
            }
          });
          void refresh();
        }}
      >
        Check Slack action status
      </Button>
    </section>
  );
}
