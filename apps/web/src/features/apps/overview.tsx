import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { workspaceRoute } from '@/router';
import { appFailureMessage, type AppDetail } from './api';
import { useWorkspaceAdmin } from './app-page';
import {
  approvalLabel,
  canEdit,
  creditPauseNote,
  creditsLabel,
  draftLabels,
  kindLabels,
  roleLabels,
  servingStatus,
  tulipfarmAddress,
} from './labels';

/** Versions and settings links for people who may open them. */
export function AppActions({ app, admin }: { app: AppDetail; admin: boolean }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const params = { workspaceSlug: workspace.slug, appSlug: app.slug };
  return (
    <>
      {canEdit(app) && (
        <Button nativeButton={false} render={<Link to="/$workspaceSlug/apps/$appSlug/edit" params={params} />}>
          Edit in chat
        </Button>
      )}
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

/** The app's details, with links to edit, versions and settings for those who may open them. */
export function AppOverview({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const admin = useWorkspaceAdmin(workspace.id);
  const serving = servingStatus(app);
  const approval = approvalLabel(app.approval);
  const rows: { label: string; description?: string; value: ReactNode }[] = [
    { label: 'Type', value: kindLabels[app.kind] },
    app.kind === 'public'
      ? {
          label: 'Web address',
          value: !app.webAddress ? (
            'Not set yet'
          ) : app.edgeStatus === 'active' && app.liveReleaseId ? (
            <a href={`https://${app.webAddress}`} target="_blank" rel="noreferrer" className="underline">
              {app.webAddress}
            </a>
          ) : (
            app.webAddress
          ),
        }
      : {
          label: 'TulipFarm address',
          description: 'Only people you share it with can open it.',
          value: tulipfarmAddress(workspace.slug, app.slug),
        },
    {
      label: 'Current version',
      value: app.liveRelease ? `Version ${app.liveRelease.number}` : 'Not published yet',
    },
    ...(serving
      ? [
          {
            label: 'Status',
            ...(app.stops.budgetPausedAt && !app.stops.disabledAt ? { description: creditPauseNote } : {}),
            value: <Badge variant={serving.tone}>{serving.label}</Badge>,
          },
        ]
      : []),
    {
      label: 'Draft',
      description: 'Changes from chat that aren’t published yet.',
      value: draftLabels[app.draft.state],
    },
    ...(app.kind === 'public'
      ? [
          {
            label: 'Approval',
            value: (
              <span className="flex flex-col items-end gap-1">
                <Badge variant={approval.tone}>{approval.label}</Badge>
                {app.approval.state === 'approved' && (
                  <span className="text-sm text-muted-foreground">
                    {app.approval.monthlyLimitUnits
                      ? `Up to ${creditsLabel(app.approval.monthlyLimitUnits)}`
                      : 'No monthly limit'}
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
              {appFailureMessage(app.draft.failure.code)}
              {app.draft.failure.retryable ? ' Ask in chat to try again.' : ''}
            </AlertDescription>
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
