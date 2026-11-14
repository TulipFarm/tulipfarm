import { Link, useNavigate } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { Window } from 'reicon-react/icons/Window';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { RecordList } from '@tulipfarm/sprout/record-list';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { workspaceRoute } from '@/router';
import { AppsUnavailable } from './app-page';
import { useApps } from './queries';
import { approvalLabel, kindLabels, roleLabels, servingStatus, tulipfarmAddress } from './labels';

export function AppsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const read = useApps(workspace.id);
  const newApp = (
    <Button
      nativeButton={false}
      render={<Link to="/$workspaceSlug/apps/new" params={{ workspaceSlug: workspace.slug }} />}
    >
      <Add size={16} aria-hidden="true" />
      New app
    </Button>
  );
  if (read.state.kind === 'unavailable')
    return (
      <PageContent>
        <PageHeader titleId="apps-heading" focusable title="Apps" />
        <AppsUnavailable />
      </PageContent>
    );
  const apps = read.state.kind === 'ready' ? read.state.data : [];
  return (
    <PageContent>
      <PageHeader
        titleId="apps-heading"
        focusable
        title="Apps"
        description="Tools your workspace builds in chat. Private apps stay inside TulipFarm. Public apps get their own web address."
        actions={read.state.kind === 'ready' && apps.length === 0 ? undefined : newApp}
      />
      <RecordList
        items={apps}
        label="Apps"
        status={read.state.kind === 'loading' ? 'loading' : read.state.kind === 'error' ? 'error' : 'ready'}
        error={read.state.kind === 'error' ? read.state.message : undefined}
        onRetry={() => void read.refresh()}
        onItemOpen={app =>
          void navigate({
            to: '/$workspaceSlug/apps/$appSlug',
            params: { workspaceSlug: workspace.slug, appSlug: app.slug },
          })
        }
        badges={app => {
          const serving = servingStatus(app);
          const approval = approvalLabel(app.approval);
          return (
            <>
              <Badge variant="outline">{kindLabels[app.kind]}</Badge>
              {serving && <Badge variant={serving.tone}>{serving.label}</Badge>}
              {app.kind === 'public' && app.approval.state !== 'approved' && (
                <Badge variant={approval.tone}>{approval.label}</Badge>
              )}
            </>
          );
        }}
        values={app => [
          {
            label: 'Address',
            value:
              app.kind === 'public'
                ? (app.webAddress ?? 'No web address yet')
                : tulipfarmAddress(workspace.slug, app.slug),
          },
          { label: 'Your access', value: app.role ? roleLabels[app.role] : 'Workspace admin' },
        ]}
        empty={
          <StatePanel
            kind="empty"
            heading="h2"
            icon={Window}
            title="No apps yet"
            description="Create an app here, then describe what it should do in chat. TulipFarm builds it for you."
          >
            {newApp}
          </StatePanel>
        }
      />
    </PageContent>
  );
}
