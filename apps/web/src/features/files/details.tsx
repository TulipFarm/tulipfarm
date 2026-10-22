import type { ReactNode } from 'react';
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
import { fileKind, formatFileSize, type FileKind } from '@/lib/file-viewer';
import { useFeatureRead } from '@/lib/query';
import { fileKeys, roleLabels, type FilesApi, type FileSummary } from './api';
import type { FinalFocus } from './sharing';

const kinds: Record<FileKind, string> = {
  image: 'Image',
  pdf: 'PDF',
  json: 'JSON',
  text: 'Text',
  markdown: 'Markdown',
  sheet: 'Spreadsheet',
  document: 'Document',
  slides: 'Presentation',
  google: 'Google shortcut',
  unsupported: 'File',
};
export const typeLabel = (item: Pick<FileSummary, 'kind' | 'name' | 'mediaType'>) =>
  item.kind === 'folder' ? 'Folder' : kinds[fileKind(item.name, item.mediaType ?? '')];

export function DetailsDialog({
  api,
  item,
  membershipId,
  finalFocus,
  share,
  onClose,
}: {
  api: FilesApi;
  item: FileSummary;
  membershipId: string;
  finalFocus?: FinalFocus;
  share: () => void;
  onClose: () => void;
}) {
  const details = useFeatureRead({
    key: fileKeys.details(item.id),
    staleTime: 0,
    load: signal => api.details(item.id, signal),
  });
  const manager = item.role === 'manager';
  const sharing = useFeatureRead({
    key: fileKeys.sharing(item.id),
    enabled: manager,
    staleTime: 0,
    load: signal => api.sharing(item.id, signal),
  });
  let body: ReactNode;
  if (details.state.kind === 'loading')
    body = (
      <div role="status" aria-label="Loading details" className="space-y-3 py-2">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading details…</span>
      </div>
    );
  else if (details.state.kind === 'unavailable')
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="Details unavailable"
        description="This item was moved to Trash, or your access changed."
      />
    );
  else if (details.state.kind === 'error')
    body = (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load details"
        description="Check your connection and try again."
      >
        <Button variant="outline" onClick={() => void details.refresh()}>
          Retry loading details
        </Button>
      </StatePanel>
    );
  else {
    const { item: current, owner, path, pathRestricted } = details.state.data;
    const top = path[0] ?? current;
    const root = pathRestricted
      ? 'A folder you can’t open'
      : top.creatorMembershipId === membershipId
        ? 'My files'
        : 'Shared with me';
    const audience = sharing.state.kind === 'ready' ? sharing.state.data.effectiveAudience.length : null;
    const rows: [string, ReactNode][] = [
      ['Type', typeLabel(current)],
      ...(current.size === null ? [] : [['Size', formatFileSize(current.size)] as [string, ReactNode]]),
      ['Owner', owner.membershipId === membershipId ? `${owner.name} (you)` : owner.name],
      ['Location', [root, ...path.map(folder => folder.name)].join(' / ')],
      ['Your access', current.creatorMembershipId === membershipId ? 'Owner' : roleLabels[current.role]],
      [
        'Who has access',
        !manager
          ? 'Only owners and people who can manage this item see who has access.'
          : audience === null
            ? sharing.state.kind === 'loading'
              ? 'Checking access…'
              : 'Couldn’t load access. Open Share to retry.'
            : audience === 1
              ? 'Only 1 person'
              : `${audience} people, counting teams and folders`,
      ],
    ];
    body = (
      <dl className="divide-y rounded-lg border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 px-3 py-2 sm:grid-cols-3 sm:gap-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-sm text-foreground sm:col-span-2">{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="form" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>
            <span className="wrap-anywhere">{item.name}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 overflow-y-auto px-4 pb-1">{body}</div>
        <DialogFooter>
          {manager && details.state.kind === 'ready' && (
            <Button variant="outline" onClick={share}>
              Manage access
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
