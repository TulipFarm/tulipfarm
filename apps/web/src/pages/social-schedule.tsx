import { useMemo } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { workspaceRoute } from '@/router';
import { useFlag } from '@/lib/feature-flags';
import { useFeatureRead } from '@/lib/query';
import { socialApi } from '@/lib/social';
import { SocialScheduleView, type ScheduleActions } from '@/features/social/schedule';

const moving = new Set(['scheduled', 'sending', 'processing']);

export function SocialSchedulePage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const enabled = useFlag('social-publishing');
  const read = useFeatureRead({
    key: ['social', 'schedule'],
    load: signal => socialApi.schedule(workspace.id, {}, signal),
    enabled,
    pollWhile: data => data.channels.some(channel => channel.variants.some(({ variant }) => moving.has(variant.state))),
    interval: 10_000,
  });
  const actions = useMemo<ScheduleActions>(() => {
    const after =
      <A extends unknown[], T>(action: (...args: A) => Promise<T>) =>
      async (...args: A) => {
        try {
          return await action(...args);
        } finally {
          await read.refresh();
        }
      };
    return {
      resume: after((variantId: string) => socialApi.resume(workspace.id, variantId)),
      cancel: after((variantId: string) => socialApi.cancel(workspace.id, variantId)),
      candidates: variantId => socialApi.candidates(workspace.id, variantId),
      settle: after((variantId: string, settlement: Parameters<typeof socialApi.settle>[2]) =>
        socialApi.settle(workspace.id, variantId, settlement),
      ),
    };
  }, [workspace.id, read.refresh]);
  if (!enabled)
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <PageContent>
          <StatePanel kind="unavailable" title="Page not found" description="This page is not available." />
        </PageContent>
      </div>
    );
  const state = read.state;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="Social schedule"
          description="Scheduled, blocked, published, failed and unknown-outcome variants on channels you can publish to. Prepare posts in chat."
        />
        {state.kind === 'loading' && (
          <StatePanel kind="loading" title="Loading the schedule" description="Checking your channels." />
        )}
        {state.kind === 'unavailable' && (
          <StatePanel
            kind="unavailable"
            title="Social schedule unavailable"
            description="You need a publish grant on a channel to see its schedule."
          />
        )}
        {state.kind === 'error' && (
          <StatePanel kind="error" title="The schedule could not load" description={state.message}>
            <Button variant="outline" onClick={() => void read.refresh()}>
              Retry loading
            </Button>
          </StatePanel>
        )}
        {state.kind === 'ready' && (
          <>
            {state.error && (
              <Alert variant="destructive">
                <AlertDescription>The schedule could not refresh. It shows the last loaded state.</AlertDescription>
              </Alert>
            )}
            <SocialScheduleView schedule={state.data} actions={actions} />
          </>
        )}
      </PageContent>
    </div>
  );
}
