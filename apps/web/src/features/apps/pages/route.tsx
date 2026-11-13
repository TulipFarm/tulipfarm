import { Link, useParams, useSearch } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Window } from 'reicon-react/icons/Window';
import { useFlag } from '@/lib/feature-flags';
import { workspaceRoute } from '@/router';
import type { AppDetail } from '../api';
import { AppGate, AppsUnavailable, useWorkspaceAdmin } from '../app-page';
import { AppActions, AppOverview } from '../overview';
import { AppPageView } from './page-view';

/** Whether the app's address opens its pages: a private app with a published version that is running. */
export const opensPages = (app: AppDetail) =>
  app.kind === 'private' && app.liveRelease !== null && !app.stops.disabledAt;

/** A private app page at `/<workspace>/apps/<app>/<page>`, or its home page at the app's own address. */
export function LivePage({ app, slug }: { app: AppDetail; slug: string | undefined }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const admin = useWorkspaceAdmin(workspace.id);
  const { row } = useSearch({ strict: false }) as { row?: string };
  if (app.kind !== 'private')
    return (
      <StatePanel
        kind="unavailable"
        heading="h2"
        icon={Window}
        title="Page not found"
        description="This app has no page at this address."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={
            <Link to="/$workspaceSlug/apps/$appSlug" params={{ workspaceSlug: workspace.slug, appSlug: app.slug }} />
          }
        >
          Back to app
        </Button>
      </StatePanel>
    );
  return <AppPageView app={app} slug={slug} row={row} draft={false} actions={<AppActions app={app} admin={admin} />} />;
}

/** The app's own address: a running private app opens its home page, and any other app shows its details. */
export function AppHomePage() {
  const enabled = useFlag('app-hosting');
  return (
    <PageContent>
      <AppGate>
        {app => (enabled && opensPages(app) ? <LivePage app={app} slug={undefined} /> : <AppOverview app={app} />)}
      </AppGate>
    </PageContent>
  );
}

export function AppPagePage() {
  const enabled = useFlag('app-hosting');
  const { page } = useParams({ strict: false }) as { page?: string };
  return (
    <PageContent>
      {enabled ? <AppGate>{app => <LivePage app={app} slug={page} />}</AppGate> : <AppsUnavailable />}
    </PageContent>
  );
}
