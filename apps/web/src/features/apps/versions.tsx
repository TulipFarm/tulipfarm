import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { RecordList } from '@tulipfarm/sprout/record-list';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useConfirmation } from '@/features/access/confirm';
import { workspaceRoute } from '@/router';
import { failureMessage, type AppDetail, type AppRelease } from './api';
import { AppGate } from './app-page';
import { useAppApi, useAppChanges, useAppOperation, useAppReleases } from './queries';
import { formatDay, shortCommit } from './labels';

export function AppVersionsPage() {
  return (
    <PageContent>
      <AppGate>{app => <Versions app={app} />}</AppGate>
    </PageContent>
  );
}

function Versions({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const editor = app.role === 'edit';
  const read = useAppReleases(workspace.id, app.id, editor);
  const confirm = useConfirmation();
  const [operationId, setOperationId] = useState<string | null>(null);
  const operation = useAppOperation(workspace.id, app.id, operationId);
  const outcome = operation.state.kind === 'ready' ? operation.state.data : null;
  const restoring = outcome !== null && (outcome.status === 'admitted' || outcome.status === 'staging');
  useEffect(() => {
    if (outcome && !restoring) void changes.app(app.id);
  }, [outcome?.status]);
  const releases = read.state.kind === 'ready' ? read.state.data : [];
  return (
    <>
      <PageHeader
        titleId="versions-heading"
        focusable
        title="Versions"
        description="Each time you publish, TulipFarm keeps that version. Restore one to put it live again. Your data stays as it is."
        parent={{
          label: app.title,
          link: (
            <Link to="/$workspaceSlug/apps/$appSlug" params={{ workspaceSlug: workspace.slug, appSlug: app.slug }} />
          ),
        }}
      />
      {confirm.element}
      <div className="space-y-4">
        {outcome && (
          <Alert
            variant={outcome.status === 'failed' ? 'destructive' : 'default'}
            role={restoring ? 'status' : 'alert'}
          >
            <AlertDescription>
              {restoring
                ? 'Restoring. The current version stays live until the restored one is ready.'
                : outcome.status === 'switched'
                  ? 'Restored. That version is live now.'
                  : outcome.status === 'superseded'
                    ? 'A newer change finished first, so this restore was not applied.'
                    : (outcome.failure?.message ?? 'The restore failed. The current version is still live.')}
            </AlertDescription>
          </Alert>
        )}
        {!editor ? (
          <StatePanel
            kind="unavailable"
            heading="h2"
            title="Only editors can see versions"
            description="Ask an editor of this app for edit access."
          />
        ) : (
          <RecordList
            items={releases.map(release => ({ ...release, title: `Version ${release.number}` }))}
            label="Versions"
            status={read.state.kind === 'loading' ? 'loading' : read.state.kind === 'ready' ? 'ready' : 'error'}
            error={
              read.state.kind === 'error'
                ? read.state.message
                : read.state.kind === 'unavailable'
                  ? 'You no longer have edit access to this app.'
                  : undefined
            }
            onRetry={() => void read.refresh()}
            badges={release => <VersionBadge release={release} />}
            values={release => [
              { label: 'Published', value: formatDay(release.createdAt) },
              {
                label: 'Source',
                value: <span className="font-mono">{shortCommit(release.commit)}</span>,
                text: release.commit,
              },
            ]}
            renderActions={release =>
              release.live || !release.staged ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restoring}
                  aria-label={`Restore version ${release.number}`}
                  onClick={() =>
                    confirm.open({
                      title: `Restore version ${release.number}?`,
                      description:
                        'It replaces the live version once it is ready. Data, permissions and limits stay as they are now.',
                      action: 'Restore',
                      destructive: false,
                      run: async () => {
                        try {
                          const started = await api.rollback(app.id, release.id);
                          setOperationId(started.id);
                          return null;
                        } catch (error) {
                          return failureMessage(error);
                        }
                      },
                    })
                  }
                >
                  Restore
                </Button>
              )
            }
            empty={
              <StatePanel
                kind="empty"
                heading="h2"
                title="No versions yet"
                description="A version appears here each time you publish this app."
              />
            }
          />
        )}
      </div>
    </>
  );
}

function VersionBadge({ release }: { release: AppRelease }) {
  if (release.live) return <Badge variant="success">Live</Badge>;
  if (!release.staged) return <Badge variant="secondary">Not ready</Badge>;
  return null;
}
