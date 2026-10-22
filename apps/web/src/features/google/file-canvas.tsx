import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Refresh } from 'reicon-react/icons/Refresh';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { FileContent, LoadingFile } from '@tulipfarm/sprout/file-viewer';
import { fileRenderers } from '@/features/files/viewer/renderers';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  googleFileKeys,
  googleWebLink,
  outcome,
  useDriveAccess,
  useGoogleFilesApi,
  type DriveAccess,
} from '@/features/files/google-api';
import { GoogleRecoveryPanel } from '@/features/files/google-recovery';
import { GoogleSheet } from '@/features/files/google-sheet';
import { renderableType } from '@/lib/file-viewer';
import { useFeatureRead } from '@/lib/query';
import { workspaceRoute } from '@/router';
import { loadView, unreadable } from './file-view';

export function GoogleFileCanvas({ workspaceId, fileId }: { workspaceId: string; fileId: string }) {
  const drive = useDriveAccess(workspaceId);
  if (drive.access.kind === 'loading') return <LoadingFile />;
  if (drive.access.kind !== 'ready')
    return (
      <CanvasSection>
        <GoogleRecoveryPanel
          recovery={
            drive.access.kind === 'grant' ? { kind: 'grant', app: 'drive', email: drive.access.email } : drive.access
          }
          connect={drive.connect}
          retry={drive.refresh}
        />
      </CanvasSection>
    );
  return (
    <Opened
      key={`${drive.access.binding.integrationId}:${drive.access.binding.accountId}:${drive.access.binding.generation}`}
      workspaceId={workspaceId}
      fileId={fileId}
      access={drive.access}
      drive={drive}
    />
  );
}

function Opened({
  workspaceId,
  fileId,
  access,
  drive,
}: {
  workspaceId: string;
  fileId: string;
  access: Extract<DriveAccess, { kind: 'ready' }>;
  drive: ReturnType<typeof useDriveAccess>;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useGoogleFilesApi(workspaceId, access.binding, access.scopes);
  const read = useFeatureRead({
    key: googleFileKeys.item(access.binding, fileId),
    staleTime: 0,
    load: signal => outcome(() => loadView(api, access.scopes, fileId, signal)),
  });
  const data = read.state.kind === 'ready' ? read.state.data : null;
  const binary = data?.kind === 'ok' && data.value.view.kind === 'binary' ? data.value.view : null;
  const [rendered, setRendered] = useState<{ source: typeof binary; url: string } | null>(null);
  useEffect(() => {
    if (!binary) {
      setRendered(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([binary.bytes], { type: renderableType(binary.filename, binary.mediaType) }),
    );
    setRendered({ source: binary, url });
    return () => URL.revokeObjectURL(url);
  }, [binary]);
  const refreshing = read.state.kind === 'ready' && read.state.refreshing;
  const retry = () => {
    if (!refreshing) void read.refresh();
  };
  const back = (
    <Button
      variant="outline"
      size="sm"
      nativeButton={false}
      render={<Link to="/$workspaceSlug/files/google/$fileId" params={{ workspaceSlug: workspace.slug, fileId }} />}
    >
      Open Google file page
    </Button>
  );
  if (read.state.kind === 'loading') return <LoadingFile />;
  if (read.state.kind === 'unavailable')
    return (
      <CanvasSection>
        <StatePanel
          kind="unavailable"
          title="Google file unavailable"
          description="This file is missing or you no longer have access."
        >
          {back}
        </StatePanel>
      </CanvasSection>
    );
  if (read.state.kind === 'error')
    return (
      <CanvasSection>
        <StatePanel kind="error" title="Couldn’t load Google file" description="Check the file again.">
          <Button variant="outline" onClick={retry}>
            Retry file
          </Button>
          {back}
        </StatePanel>
      </CanvasSection>
    );
  if (!data) return null;
  if (data.kind === 'blocked')
    return (
      <CanvasSection>
        <StatePanel
          kind="unavailable"
          title="Google file unavailable"
          description={
            data.block === 'not-found'
              ? 'This file is missing from your Google account.'
              : data.block === 'denied'
                ? 'You do not have permission to read this file.'
                : 'Open the Google file page to check your integration and access.'
          }
        >
          <Button variant="outline" onClick={retry}>
            Check file again
          </Button>
          {back}
        </StatePanel>
      </CanvasSection>
    );
  const { file, view } = data.value;
  const link = googleWebLink(file.webViewLink);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 space-y-3 border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-lg font-medium">{file.name}</h3>
            <p className="text-sm text-muted-foreground">Current Google file</p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh Google file"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={retry}
          >
            <Refresh size={16} />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {link && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<a href={link} target="_blank" rel="noopener noreferrer" />}
            >
              Open in Google
            </Button>
          )}
          {back}
        </div>
        {read.state.error && (
          <Alert variant="destructive">
            <AlertDescription>Couldn’t refresh this file. The last loaded file is still shown.</AlertDescription>
          </Alert>
        )}
      </header>
      {view.kind === 'binary' ? (
        rendered?.source === binary ? (
          <FileContent
            name={view.filename}
            mediaType={view.mediaType}
            bytes={view.bytes}
            url={rendered.url}
            onRetry={retry}
            renderers={fileRenderers}
          />
        ) : (
          <LoadingFile />
        )
      ) : view.kind === 'sheet' ? (
        <GoogleSheet
          api={api}
          binding={access.binding}
          fileId={file.id}
          tabs={view.tabs}
          connect={drive.connect}
          refreshIntegration={drive.refresh}
        />
      ) : view.kind === 'grant-sheets' ? (
        <CanvasSection>
          <GoogleRecoveryPanel
            recovery={{ kind: 'grant', app: 'sheets', email: access.email }}
            connect={drive.connect}
            retry={drive.refresh}
          />
        </CanvasSection>
      ) : (
        <CanvasSection>
          <StatePanel
            kind="unavailable"
            title={view.kind === 'folder' ? 'This is a Google Drive folder' : unreadable[view.reason][0]}
            description={
              view.kind === 'folder' ? 'Open the Google file page to browse this folder.' : unreadable[view.reason][1]
            }
          >
            <Button variant="outline" onClick={retry}>
              Check file again
            </Button>
          </StatePanel>
        </CanvasSection>
      )}
    </div>
  );
}
