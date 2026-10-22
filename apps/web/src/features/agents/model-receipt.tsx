import { useEffect, useRef, useState } from 'react';
import { retryModelSchema } from '@tulipfarm/agents/chat-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { TableRequestError } from '@/features/tables/request-state';
import type { agentApi } from './api';
import { SlackAction } from './slack-action';
import { ToolActivity, type ToolActivityStatus } from '@tulipfarm/sprout/tool-activity';
import { toolPresentation, toolOutcomeStatus } from '@tulipfarm/conversations/tool-activity';
import { toolVisual } from '@/features/chat/tool-labels';

type Api = ReturnType<typeof agentApi>;
type Turn = Awaited<ReturnType<Api['turn']>>;
type Command = Parameters<Api['retryModel']>[2];
type RetryState =
  | { kind: 'idle' }
  | { kind: 'sending' | 'uncertain'; command: Command }
  | { kind: 'accepted'; generation: number }
  | { kind: 'conflict' | 'denied' | 'rejected' };

function retainedCommand(key: string): RetryState {
  try {
    const command = retryModelSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
    return command.success ? { kind: 'uncertain', command: command.data } : { kind: 'idle' };
  } catch {
    return { kind: 'idle' };
  }
}

export function ModelReceipt({
  api,
  agentId,
  turn,
  refresh,
  refreshing,
}: {
  api: Api;
  agentId: string;
  turn: Turn;
  refresh: () => Promise<void>;
  refreshing: boolean;
}) {
  const key = `agent-model-retry:${turn.id}`;
  const [retry, setRetry] = useState<RetryState>(() => retainedCommand(key));
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const model = turn.model;
  const winner = model?.attempts.find(attempt => attempt.id === model.winner);
  const advanced = retry.kind === 'uncertain' && model && model.generation > retry.command.expectedGeneration;
  const awaitingStatus = retry.kind === 'accepted' && (!model || model.generation < retry.generation);
  const eligible =
    turn.status === 'failed' && model?.status === 'failed' && !model.winner && !turn.call && !turn.execution;
  const locked = refreshing || retry.kind === 'sending' || awaitingStatus;
  const presentation = turn.call ? (turn.presentation ?? toolPresentation(turn.call.tool, turn.call)) : null;
  const toolStatus: ToolActivityStatus =
    turn.activityStatus ??
    (turn.execution?.status === 'pending'
      ? 'queued'
      : turn.execution?.status === 'completed'
        ? toolOutcomeStatus(turn.execution.result)
        : (turn.execution?.status ?? (turn.status === 'failed' ? 'failed' : 'queued')));
  function forget() {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Storage may be disabled. The in-memory command remains authoritative. */
    }
  }
  async function send(command: Command) {
    if (busy.current) return;
    busy.current = true;
    try {
      sessionStorage.setItem(key, JSON.stringify(command));
    } catch {
      /* Retry still retains its command for this mounted turn. */
    }
    setRetry({ kind: 'sending', command });
    try {
      const receipt = await api.retryModel(agentId, turn.id, command);
      forget();
      if (mounted.current) {
        setRetry({ kind: 'accepted', generation: receipt.generation });
        await refresh();
      }
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof TableRequestError && [401, 403, 404].includes(error.status)) {
        forget();
        setRetry({ kind: 'denied' });
      } else if (error instanceof TableRequestError && error.status === 409) {
        forget();
        setRetry({ kind: 'conflict' });
      } else if (error instanceof TableRequestError && [400, 422].includes(error.status)) {
        forget();
        setRetry({ kind: 'rejected' });
      } else setRetry({ kind: 'uncertain', command });
    } finally {
      busy.current = false;
    }
  }
  if (retry.kind === 'denied')
    return (
      <StatePanel
        kind="unavailable"
        title="Request unavailable"
        description="Your access could not be confirmed. No model details are shown. Reload to check current access before continuing."
      >
        <Button onClick={() => window.location.reload()}>Reload and check access</Button>
      </StatePanel>
    );
  return (
    <div className="space-y-3">
      <p role="status">
        Request {turn.status}. {turn.execution ? `Tool ${turn.execution.status}.` : ''}
      </p>
      {turn.text && <p className="whitespace-pre-wrap">{turn.text}</p>}
      {turn.call && presentation && (
        <ToolActivity
          items={[
            {
              id: turn.id,
              label: presentation.label,
              visual: toolVisual(turn.call.tool, presentation.brand),
              status: toolStatus,
            },
          ]}
        />
      )}
      {turn.call && !turn.call.tool.startsWith('slack.') && (
        <pre className="overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(turn.call, null, 2)}</pre>
      )}
      {turn.execution && turn.call?.tool.startsWith('slack.') ? (
        <SlackAction api={api} id={turn.id} refresh={refresh} />
      ) : (
        turn.execution && (
          <pre className="overflow-auto whitespace-pre-wrap break-all text-sm">
            {JSON.stringify(turn.execution.result, null, 2)}
          </pre>
        )
      )}
      {!model ? (
        <p>Model attribution unavailable for this request.</p>
      ) : (
        <section aria-label="Model attribution" className="space-y-3 text-base">
          <h3 className="text-base font-medium">Model step</h3>
          <p>
            Preferred family {model.preferred.familyId}. Version {model.preferred.modelId}. Provider{' '}
            {model.preferred.route.provider}.
          </p>
          <p>
            {winner
              ? `Actual family ${winner.resolution.familyId}. Version ${winner.resolution.modelId}. Provider ${winner.resolution.route.provider}. Reported model ${winner.outcome?.actualModel ?? 'unknown'}.`
              : 'No model result committed yet.'}
          </p>
          {model.attempts.some(attempt => attempt.role === 'fallback') && (
            <p>
              Fallback reason. Primary attempts did not complete successfully.{' '}
              {model.attempts
                .filter(attempt => attempt.role === 'primary')
                .map(attempt => `Attempt ${attempt.ordinal}: ${attempt.outcome?.reason ?? attempt.status}.`)
                .join(' ')}
            </p>
          )}
          {model.status === 'failed' && (
            <Alert variant="destructive">
              <AlertDescription>
                Model step failed. {model.failure ?? 'Reason unavailable'}. No model result was committed. A retry
                rechecks current access and model policy.
              </AlertDescription>
            </Alert>
          )}
          {model.attempts.length === 0 ? (
            <p>No provider attempt recorded. Usage unknown.</p>
          ) : (
            <ol aria-label="Model attempts" className="space-y-2">
              {model.attempts.map(attempt => (
                <li key={attempt.id} className="space-y-1">
                  <p>
                    Attempt {attempt.ordinal}, {attempt.role}, {attempt.status}. Family {attempt.resolution.familyId}.
                    Version {attempt.resolution.modelId}. Provider {attempt.resolution.route.provider}. Reported model{' '}
                    {attempt.outcome?.actualModel ?? 'unknown'}.
                  </p>
                  <p>
                    {attempt.usage.kind === 'unknown'
                      ? `Usage unknown (${attempt.usage.reason}). This does not mean zero usage.`
                      : `Usage: input ${attempt.usage.tokens.input}, output ${attempt.usage.tokens.output}, cache read ${attempt.usage.tokens.cacheRead}, cache write ${attempt.usage.tokens.cacheWrite}, 5-minute cache write ${attempt.usage.tokens.cacheWrite5m}, 1-hour cache write ${attempt.usage.tokens.cacheWrite1h} tokens.`}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <p className="text-muted-foreground">
            Generation {model.generation}. Provider usage is not a billing settlement.
          </p>
        </section>
      )}
      {retry.kind === 'sending' && <p role="status">Retrying model step…</p>}
      {retry.kind === 'accepted' && (
        <p role="status">
          Retry accepted. {awaitingStatus ? 'Check status to load the new generation.' : 'Current generation loaded.'}
        </p>
      )}
      {retry.kind === 'uncertain' && (
        <Alert>
          <AlertDescription>
            {advanced
              ? 'A newer generation is visible. This does not identify which request started it. Review current status before another retry.'
              : 'Retry outcome unconfirmed. Check request status. Repeating this retry keeps the same request ID and expected generation.'}
          </AlertDescription>
        </Alert>
      )}
      {retry.kind === 'conflict' && (
        <Alert variant="destructive">
          <AlertDescription>
            The model generation changed or cannot be retried. Reload request status and review it before another retry.
          </AlertDescription>
        </Alert>
      )}
      {retry.kind === 'rejected' && (
        <Alert variant="destructive">
          <AlertDescription>The retry was rejected. Reload request status before continuing.</AlertDescription>
        </Alert>
      )}
      {retry.kind === 'conflict' || retry.kind === 'rejected' || advanced ? (
        <Button
          variant="outline"
          disabled={locked}
          onClick={async () => {
            await refresh();
            if (mounted.current) {
              forget();
              setRetry({ kind: 'idle' });
            }
          }}
        >
          Reload request status
        </Button>
      ) : retry.kind === 'uncertain' ? (
        <Button disabled={locked} onClick={() => void send(retry.command)}>
          Repeat same retry
        </Button>
      ) : (
        eligible && (
          <Button
            disabled={locked}
            aria-busy={retry.kind === 'sending'}
            onClick={() => {
              if (model) void send({ requestId: crypto.randomUUID(), expectedGeneration: model.generation });
            }}
          >
            {retry.kind === 'sending' ? 'Retrying model step…' : 'Retry model step'}
          </Button>
        )
      )}
    </div>
  );
}
