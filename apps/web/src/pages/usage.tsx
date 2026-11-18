import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { workspaceRoute } from '@/router';
import { UsageExplorer } from '@/features/usage/usage-explorer';

export function UsagePage() {
  const { workspace } = workspaceRoute.useRouteContext();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="Usage"
          description="Which models your workspace uses, how much, and what pays for it: credits, members’ plans, or API keys."
        />
        <UsageExplorer key={workspace.id} workspaceId={workspace.id} />
      </PageContent>
    </div>
  );
}
