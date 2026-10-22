import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { workflowSchema } from '@tulipfarm/workflows/contracts';
import { ActionButton, type ActionState } from '@/components/action-button';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { DataList, DataListCell, DataListRow, DataListSecondary } from '@/components/data-list';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useWebhookDeliveries } from './queries';
import { byteSize, deliveryOutcome, deliveryRun } from './webhook-status';

type Workflow = z.infer<typeof workflowSchema>;

export function WebhookDeliveries({
  workspaceId,
  workflow,
  test,
  testRun,
  onTest,
  onOpenRun,
  onDenied,
}: {
  workspaceId: string;
  workflow: Workflow;
  test: ActionState;
  testRun: string | null;
  onTest: () => void;
  onOpenRun: (runId: string) => void;
  onDenied: () => void;
}) {
  const read = useWebhookDeliveries(workspaceId, workflow.id);
  const state = read.state;
  useEffect(() => {
    if (state.kind === 'unavailable') onDenied();
  }, [state.kind, onDenied]);
  const [retrying, setRetrying] = useState(false);
  const checking = retrying || state.kind === 'loading' || (state.kind === 'ready' && state.refreshing);
  const check = async () => {
    setRetrying(true);
    try {
      await read.refresh();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <section aria-labelledby="webhook-deliveries" className="space-y-3">
      <h3 id="webhook-deliveries" className="font-medium">
        Recent deliveries
      </h3>
      <p className="text-sm text-muted-foreground">
        Every call to this endpoint appears here, including rejected ones, so you can see whether a sender reached it
        and why a call failed. The newest 50 calls from the last 30 days are kept. Request bodies and keys are never
        stored.
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <ActionButton variant="outline" state={test} pendingLabel="Sending test event…" onClick={onTest}>
          Send test event
        </ActionButton>
        <Button variant="ghost" disabled={checking} aria-busy={checking} onClick={() => void check()}>
          {checking ? 'Checking deliveries…' : 'Check deliveries'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A test event is a sample shaped for the active trigger. It starts a real run as the sponsor without using a key,
        and the log marks it as a test.
      </p>
      {testRun && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">Your last test event was admitted as a run.</p>
          <Button variant="link" size="xs" onClick={() => onOpenRun(testRun)}>
            Open test run
          </Button>
        </div>
      )}
      {state.kind === 'loading' && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            Loading deliveries…
          </p>
          <div aria-hidden="true" className="space-y-2">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        </div>
      )}
      {state.kind === 'error' && (
        <StatePanel
          kind="error"
          heading="h4"
          title="Deliveries could not load"
          description={
            retrying
              ? 'Checking the delivery log again.'
              : 'The delivery log could not be read. The endpoint keeps receiving calls. Retry the read.'
          }
        >
          <Button variant="outline" disabled={retrying} aria-busy={retrying} onClick={() => void check()}>
            {retrying ? 'Retrying…' : 'Retry loading deliveries'}
          </Button>
        </StatePanel>
      )}
      {state.kind === 'ready' && (
        <>
          {state.error && (
            <p role="alert" className="text-sm">
              Deliveries could not refresh. The list below is from the last successful check.
            </p>
          )}
          {!state.data.available ? (
            <StatePanel
              kind="unavailable"
              heading="h4"
              title="Delivery log not available yet"
              description="This workspace starts recording deliveries after its storage update finishes. Test events still start runs."
            />
          ) : !state.data.deliveries.length ? (
            <StatePanel
              kind="empty"
              heading="h4"
              title="No deliveries yet"
              description="No call has reached this endpoint in the last 30 days. Send a test event, or call it from your sender with the example above."
            />
          ) : (
            <DataList
              aria-label="Webhook deliveries"
              columns="four"
              headings={['Received', 'Outcome', 'Request ID', 'Run']}
            >
              {state.data.deliveries.map(delivery => {
                const outcome = deliveryOutcome(delivery),
                  runId = delivery.runId,
                  size = byteSize(delivery.bodyBytes);
                return (
                  <DataListRow key={delivery.id}>
                    <DataListCell>
                      {formatTime(delivery.receivedAt)}
                      {size ? ` · ${size}` : ''}
                    </DataListCell>
                    <DataListCell>
                      <Badge variant={outcome.tone}>{outcome.label}</Badge>
                      {delivery.test && <Badge variant="outline">Test</Badge>}
                      <span className="text-xs text-muted-foreground">HTTP {delivery.status}</span>
                    </DataListCell>
                    <DataListSecondary>{delivery.requestId ?? 'None sent'}</DataListSecondary>
                    <DataListCell>
                      {runId ? (
                        <Button variant="link" size="task-link" onClick={() => onOpenRun(runId)}>
                          Open run
                        </Button>
                      ) : (
                        deliveryRun(delivery)
                      )}
                    </DataListCell>
                  </DataListRow>
                );
              })}
            </DataList>
          )}
        </>
      )}
    </section>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}
