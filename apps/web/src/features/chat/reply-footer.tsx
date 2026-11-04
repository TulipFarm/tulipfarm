import { Link } from '@tanstack/react-router';
import { Danger } from 'reicon-react/icons/Danger';
import { Button } from '@tulipfarm/sprout/button';
import { MessageFooter } from '@tulipfarm/sprout/message';
import type { ConversationMessage } from './conversation-api';
import { compactsOnRetry, contextFailure } from './compaction-copy';
import {
  chatGptFailureAction,
  fallbackNote,
  proposalKeptNote,
  replyFailure,
  replyRetrying,
  retryHelps,
  retryLabel,
} from './reply-failure-copy';

export const turnLabels = {
  queued: 'Reply queued',
  processing: 'Reply in progress',
  waiting: 'Waiting for you',
  reconciling: 'Reply checking an earlier action',
  failed: 'Reply failed',
  completed: 'Reply completed',
  cancelled: 'You stopped this reply',
  blocked: 'Reply blocked',
};

/** A reply's status, why it stopped, and the actions that can continue or cancel it. */
export function ReplyFooter({
  turn,
  tools,
  skillName,
  disabled,
  control,
  modelName,
  workspaceSlug,
}: {
  turn: NonNullable<ConversationMessage['turn']>;
  tools: ConversationMessage['tools'];
  skillName?: string | undefined;
  disabled: boolean;
  control: (kind: 'retry' | 'cancel') => void;
  modelName?: ((id: string) => string) | undefined;
  workspaceSlug?: string | undefined;
}) {
  const retrying = replyRetrying(turn.status, turn.errorCode);
  const answeredBy = fallbackNote(turn.status, turn.errorCode, turn.stats?.model, modelName);
  const proposalKept = turn.status === 'failed' ? proposalKeptNote(tools) : null;
  const quiet = ['queued', 'processing', 'completed', 'cancelled'].includes(turn.status) && !retrying && !answeredBy;
  if (quiet) return null;
  return (
    <MessageFooter>
      <div className="space-y-2">
        {answeredBy && <p className="text-xs text-muted-foreground">{answeredBy}</p>}
        {retrying && (
          <p role="status" className="text-xs text-muted-foreground">
            {retrying}
          </p>
        )}
        {!answeredBy &&
          !retrying &&
          (turn.status === 'failed' && proposalKept ? (
            <p role="status" className="text-sm text-muted-foreground">
              {proposalKept}
            </p>
          ) : turn.status === 'failed' ? (
            <p role="status" className="flex items-center gap-1.5 text-sm text-destructive">
              <Danger size={14} aria-hidden="true" />
              {turnLabels.failed}
            </p>
          ) : (
            <p role="status" className="text-xs text-muted-foreground">
              {turnLabels[turn.status]}
            </p>
          ))}
        <div className="flex flex-wrap gap-2">
          {turn.errorCode === 'credits-exhausted' && (
            <p role="alert">
              Not enough available workspace credits for this reply. Ask a workspace admin to check credits.
            </p>
          )}
          {turn.errorCode === 'plan-budget' && (
            <p role="alert">The plan reached its budget. Review the plan before adding budget and resuming.</p>
          )}
          {turn.status === 'failed' && contextFailure(turn.errorCode) && (
            <p role="alert">{contextFailure(turn.errorCode)}</p>
          )}
          {turn.status === 'failed' && !contextFailure(turn.errorCode) && replyFailure(turn.errorCode) && (
            <p role="alert">{replyFailure(turn.errorCode)}</p>
          )}
          {turn.status === 'failed' && <ChatGptFailureAction code={turn.errorCode} slug={workspaceSlug} />}
          {turn.status === 'failed' && turn.errorCode === 'skill-unavailable' && (
            <p role="alert">
              {skillName ? `“${skillName}”` : 'The skill'} is no longer available, so this reply didn’t run. Ask a
              workspace admin to enable it, then retry, or send a new message without it.
            </p>
          )}
          {turn.status === 'failed' && retryHelps(turn.errorCode) && (
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => control('retry')}>
              {retryLabel(
                turn.errorCode,
                tools.some(tool => tool.status === 'completed'),
                compactsOnRetry(turn.errorCode),
              )}
            </Button>
          )}
          {turn.status === 'failed' && (
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => control('cancel')}>
              Cancel reply
            </Button>
          )}
        </div>
      </div>
    </MessageFooter>
  );
}

function ChatGptFailureAction({ code, slug }: { code: string | null | undefined; slug: string | undefined }) {
  const action = chatGptFailureAction(code);
  if (!action) return null;
  if (action.kind === 'manage-usage')
    return (
      <Button size="sm" nativeButton={false} render={<a href={action.href} target="_blank" rel="noopener noreferrer" />}>
        {action.label}
      </Button>
    );
  if (!slug) return null;
  return (
    <Button
      size="sm"
      nativeButton={false}
      render={<Link to="/$workspaceSlug/settings/models" params={{ workspaceSlug: slug }} />}
    >
      {action.label}
    </Button>
  );
}
