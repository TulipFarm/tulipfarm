import type { ReactNode } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import type { ReadState } from '@/features/tables/request-state';

export function AgentRead<T>({
  state,
  refresh,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  children: (data: T) => ReactNode;
}) {
  const retry = <Button onClick={() => void refresh()}>Check access again</Button>;
  return (
    <ReadFeedback
      state={state}
      errorTitle="Could not load agents"
      retry={retry}
      loading={
        <section role="status" aria-label="Loading agents" className="space-y-4">
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading agents…</span>
        </section>
      }
      unavailable={() => (
        <StatePanel
          kind="unavailable"
          title="Agent unavailable"
          description="This agent is missing or you no longer have access. An authorized manager can share access."
        >
          {retry}
        </StatePanel>
      )}
      refreshError={message => <ReadError message={message} />}
      refreshing={<p role="status">Refreshing agents…</p>}
    >
      {children}
    </ReadFeedback>
  );
}
