import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { workspaceRoute } from '@/router';
import type { AppDetail } from './api';
import { AppGate, useWorkspaceAdmin } from './app-page';
import { approvalLabel, canEdit, creditsLabel, draftLabels, kindLabels, roleLabels, servingStatus } from './labels';

/** Versions and settings links for people who may open them. */
export function AppActions({ app, admin }: { app: AppDetail; admin: boolean }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const params = { workspaceSlug: workspace.slug, appSlug: app.slug };
  return (
    <>
      {canEdit(app) && (
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/apps/$appSlug/versions" params={params} />}
        >
          Versions
        </Button>
      )}
      {(canEdit(app) || admin) && (
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/apps/$appSlug/settings" params={params} />}
        >
          Settings
        </Button>
      )}
    </>
  );
}

export function AppOverviewPage() {
  return (
    <PageContent>
      <AppGate>{app => <Overview app={app} />}</AppGate>
    </PageContent>
  );
}

function Overview({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const admin = useWorkspaceAdmin(workspace.id);
  const serving = servingStatus(app);
  const approval = approvalLabel(app.approval);
  const rows: { label: string; description?: string; value: ReactNode }[] = [
    { label: 'Kind', value: kindLabels[app.kind] },
    app.kind === 'public'
      ? {
          label: 'Public name',
          description: 'The name in this app’s web address.',
          value: app.publicName ?? 'Not chosen yet',
        }
      : {
          label: 'Address',
          description: 'Only people you share it with can open it.',
          value: `/${workspace.slug}/apps/${app.slug}`,
        },
    {
      label: 'Live version',
      value: app.liveRelease ? `Version ${app.liveRelease.number}` : 'Not published yet',
    },
    ...(serving ? [{ label: 'Status', value: <Badge variant={serving.tone}>{serving.label}</Badge> }] : []),
    {
      label: 'Draft',
      description: 'Changes made in chat that are not live yet.',
      value: draftLabels[app.draft.state],
    },
    ...(app.kind === 'public'
      ? [
          {
            label: 'Approval',
            value: (
              <span className="flex flex-col items-end gap-1">
                <Badge variant={approval.tone}>{approval.label}</Badge>
                {app.approval.state === 'approved' && app.approval.monthlyLimitUnits && (
                  <span className="text-sm text-muted-foreground">
                    Up to {creditsLabel(app.approval.monthlyLimitUnits)}
                  </span>
                )}
              </span>
            ),
          },
        ]
      : []),
    { label: 'Your access', value: app.role ? roleLabels[app.role] : 'Workspace admin' },
  ];
  return (
    <>
      <PageHeader
        titleId="app-heading"
        focusable
        title={app.title}
        parent={{ label: 'Apps', link: <Link to="/$workspaceSlug/apps" params={{ workspaceSlug: workspace.slug }} /> }}
        actions={<AppActions app={app} admin={admin} />}
      />
      <div className="space-y-6">
        {app.draft.state === 'failed' && (
          <Alert variant="destructive">
            <AlertTitle>The last build failed</AlertTitle>
            <AlertDescription>
              {app.draft.failure.message}
              {app.draft.failure.retryable ? ' You can try again.' : ''}
            </AlertDescription>
          </Alert>
        )}
        {app.kind === 'private' && (
          <Alert>
            <AlertDescription>The pages of private apps will open here.</AlertDescription>
          </Alert>
        )}
        <SettingsGroup title="About this app" titleId="app-about">
          {rows.map(row => (
            <SettingsRow key={row.label} label={row.label} description={row.description}>
              {row.value}
            </SettingsRow>
          ))}
        </SettingsGroup>
      </div>
    </>
  );
}
