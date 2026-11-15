import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Window } from 'reicon-react/icons/Window';
import { workspaceRoute } from '@/router';
import { useOwnMembership } from '@/features/governance/queries';
import type { AppDetail } from './api';
import { useApp, useApps } from './queries';

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <Skeleton />
      <Skeleton />
    </div>
  );
}

export function AppsUnavailable() {
  return (
    <StatePanel
      kind="unavailable"
      heading="h2"
      icon={Window}
      title="Apps aren’t available in this workspace"
      description="They haven’t been turned on for this workspace yet."
    />
  );
}

export function LoadFailed({ title, message, retry }: { title: string; message: string; retry: () => void }) {
  return (
    <StatePanel kind="error" heading="h2" title={title} description={message}>
      <Button variant="outline" onClick={retry}>
        Try again
      </Button>
    </StatePanel>
  );
}

export function useWorkspaceAdmin(workspaceId: string) {
  const membership = useOwnMembership(workspaceId);
  return membership.state.kind === 'ready' && membership.state.data.role === 'admin';
}

/** Finds the app at this address, then loads its details, showing each state on the way. */
export function AppGate({ children }: { children: (app: AppDetail) => ReactNode }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const appSlug = useParams({ strict: false }).appSlug;
  const list = useApps(workspace.id);
  const found = list.state.kind === 'ready' ? list.state.data.find(app => app.slug === appSlug) : undefined;
  const detail = useApp(workspace.id, found?.id);
  if (list.state.kind === 'unavailable') return <AppsUnavailable />;
  if (list.state.kind === 'error')
    return (
      <LoadFailed title="Could not load this app" message={list.state.message} retry={() => void list.refresh()} />
    );
  if (list.state.kind === 'loading') return <Loading label="Loading app" />;
  if (!found)
    return (
      <StatePanel
        kind="unavailable"
        heading="h2"
        icon={Window}
        title="App not found"
        description="It may have moved to a new address, or you may not have access to it."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/apps" params={{ workspaceSlug: workspace.slug }} />}
        >
          See all apps
        </Button>
      </StatePanel>
    );
  if (detail.state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        heading="h2"
        icon={Window}
        title="You no longer have access to this app"
        description="Ask an editor of this app to share it with you."
      />
    );
  if (detail.state.kind === 'error')
    return (
      <LoadFailed title="Could not load this app" message={detail.state.message} retry={() => void detail.refresh()} />
    );
  if (detail.state.kind === 'loading') return <Loading label="Loading app" />;
  return children(detail.state.data);
}
