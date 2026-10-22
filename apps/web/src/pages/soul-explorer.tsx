import { useCallback, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { workspaceRoute } from '@/router';
import { useFlag } from '@/lib/feature-flags';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { useWorkspaceSettings } from '@/features/settings/queries';
import { SoulExplorer } from '@/features/soul-explorer/explorer';

export function SoulExplorerPage() {
  const { workspace, user, membershipId } = workspaceRoute.useRouteContext();
  return (
    <WorkspaceSoul
      key={`${user.id}:${workspace.id}:${membershipId}`}
      workspaceId={workspace.id}
      slug={workspace.slug}
    />
  );
}

function WorkspaceSoul({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const enabled = useFlag('soul-repository-explorer');
  const settings = useWorkspaceSettings(workspaceId);
  const [denied, setDenied] = useState(false);
  const accessLost = useCallback(() => {
    setDenied(true);
    void settings.refresh();
  }, [settings.refresh]);
  const allowed =
    enabled &&
    !denied &&
    settings.state.kind === 'ready' &&
    !settings.state.error &&
    settings.state.data.settings.canManage &&
    settings.state.data.membership.role === 'admin';
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Soul repository"
        back={{ label: 'Settings', link: <Link to="/$workspaceSlug/settings" params={{ workspaceSlug: slug }} /> }}
      />
      {allowed ? (
        <SoulExplorer workspaceId={workspaceId} denied={accessLost} />
      ) : settings.state.kind === 'loading' ? (
        <StatePanel kind="loading" title="Checking access" description="Loading workspace settings." />
      ) : settings.state.kind === 'error' ? (
        <StatePanel kind="error" title="Could not check access" description="Retry to load workspace settings.">
          <Button onClick={() => void settings.refresh()}>Retry access check</Button>
        </StatePanel>
      ) : (
        <StatePanel
          kind="unavailable"
          title="Soul is unavailable"
          description="This screen requires workspace admin access and an enabled feature."
        />
      )}
    </div>
  );
}
