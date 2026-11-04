import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { FileVersion } from '@tulipfarm/files/contracts';
import { formatFileSize, renderableType } from '@/lib/file-viewer';
import { useFeatureRead } from '@/lib/query';
import { errorMessage, fileKeys, useFilesChanges, type FilesApi, type FileSummary } from './api';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
type Pending = { version: number; action: 'open' | 'download' | 'restore' };

/** Earlier versions of a file. Anyone who can open the file can open them; managers can restore one as the newest version. */
export function VersionsDialog({
  api,
  item,
  membershipId,
  onRestored,
  onClose,
}: {
  api: FilesApi;
  item: FileSummary;
  membershipId: string;
  onRestored: () => void;
  onClose: () => void;
}) {
  const { changed } = useFilesChanges();
  const versions = useFeatureRead({
    key: fileKeys.versions(item.id),
    staleTime: 0,
    load: signal => api.versions(item.id, signal),
  });
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function fetchVersion(version: FileVersion, action: 'open' | 'download') {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    // Opened before the transfer, so the browser treats it as part of the click instead of blocking a pop-up.
    const tab = action === 'open' ? window.open('', '_blank') : null;
    setPending({ version: version.version, action });
    setFailure(null);
    try {
      const bytes = await api.versionContent(item.id, version.version, controller.signal);
      const type = action === 'open' ? renderableType(item.name, version.mediaType) : 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      if (tab) tab.location.href = url;
      else {
        const link = document.createElement('a');
        link.href = url;
        link.download = item.name;
        link.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      tab?.close();
      if (!controller.signal.aborted) setFailure(errorMessage(error, `Version ${version.version} couldn’t be loaded.`));
    } finally {
      if (active.current === controller) active.current = null;
      setPending(null);
    }
  }

  async function restore(version: FileVersion) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending({ version: version.version, action: 'restore' });
    setFailure(null);
    setNotice(null);
    try {
      const restored = await api.restoreVersion(item.id, version.version);
      if (controller.signal.aborted) return;
      setNotice(
        restored.version === version.version
          ? `Version ${version.version} is already the current version.`
          : `Restored version ${version.version} as version ${restored.version}.`,
      );
      void changed();
      void versions.refresh();
      onRestored();
    } catch (error) {
      if (!controller.signal.aborted) setFailure(errorMessage(error, 'The version couldn’t be restored.'));
    } finally {
      if (active.current === controller) active.current = null;
      setPending(null);
    }
  }

  let body: ReactNode;
  if (versions.state.kind === 'loading')
    body = (
      <div role="status" aria-label="Loading versions" className="space-y-3 py-2">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading versions…</span>
      </div>
    );
  else if (versions.state.kind === 'unavailable')
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="Versions unavailable"
        description="This file was moved to Trash, or your access changed."
      />
    );
  else if (versions.state.kind === 'error')
    body = (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load versions"
        description="Check your connection and try again."
      >
        <Button variant="outline" onClick={() => void versions.refresh()}>
          Retry loading versions
        </Button>
      </StatePanel>
    );
  else if (versions.state.data.versions.length === 0)
    body = (
      <StatePanel
        kind="empty"
        heading="h3"
        title="No versions yet"
        description="Versions appear here when the file changes."
      />
    );
  else {
    const manager = versions.state.data.role === 'manager';
    body = (
      <ul className="divide-y rounded-lg border">
        {versions.state.data.versions.map(version => {
          const busy = pending?.version === version.version ? pending.action : null;
          const creator =
            version.createdBy.membershipId === membershipId
              ? `${version.createdBy.name} (you)`
              : version.createdBy.name;
          return (
            <li key={version.version} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  Version {version.version}
                  {version.current && <Badge variant="secondary">Current</Badge>}
                </p>
                <p className="text-sm text-muted-foreground">
                  {[formatFileSize(version.size), creator, when.format(new Date(version.createdAt))].join(' · ')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending !== null}
                  aria-busy={busy === 'open'}
                  aria-label={`Open version ${version.version}`}
                  onClick={() => void fetchVersion(version, 'open')}
                >
                  {busy === 'open' ? 'Opening…' : 'Open'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending !== null}
                  aria-busy={busy === 'download'}
                  aria-label={`Download version ${version.version}`}
                  onClick={() => void fetchVersion(version, 'download')}
                >
                  {busy === 'download' ? 'Downloading…' : 'Download'}
                </Button>
                {manager && !version.current && (
                  <Button
                    size="sm"
                    disabled={pending !== null}
                    aria-busy={busy === 'restore'}
                    aria-label={`Restore version ${version.version}`}
                    onClick={() => void restore(version)}
                  >
                    {busy === 'restore' ? 'Restoring…' : 'Restore'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Versions</DialogTitle>
          <DialogDescription>
            <span className="wrap-anywhere">{item.name}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 space-y-3 overflow-y-auto px-4 pb-1">
          {notice && (
            <p role="status" className="text-sm text-foreground">
              {notice}
            </p>
          )}
          {failure && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          {body}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
