import { Fragment, type ReactNode } from 'react';
import { Folder } from 'reicon-react/icons/Folder';
import type { LibraryQuery } from '@tulipfarm/files/contracts';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@tulipfarm/sprout/breadcrumb';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureRead } from '@/lib/query';
import { fileKeys, roleLabels, type FilesApi } from './api';

type Section = 'mine' | 'shared';
export type FolderPlace = { section: Section; folder: string | null; after?: string };
export type FolderDestination = { parentId: string | null; label: string };
const sections: Record<Section, string> = { mine: 'My files', shared: 'Shared with me' };

/** Reads one browser location. Its destination is that location when the person can add to it: My files, or a loaded folder they can edit. */
export function useFolderPlace(api: FilesApi, place: FolderPlace) {
  const query: LibraryQuery = {
    section: place.section,
    query: '',
    sort: { key: 'name', direction: 'asc' },
    filters: {},
    location: place.folder ? { kind: 'folder', id: place.folder } : { kind: 'root' },
    ...(place.after ? { after: place.after } : {}),
  };
  const read = useFeatureRead({ key: fileKeys.library(query), load: signal => api.library(query, signal) });
  const page = read.state.kind === 'ready' ? read.state.data : null;
  const current = place.folder ? page?.breadcrumbs.at(-1) : undefined;
  const destination: FolderDestination | null =
    place.folder === null
      ? place.section === 'mine'
        ? { parentId: null, label: 'My files' }
        : null
      : current && current.role !== 'viewer'
        ? { parentId: current.id, label: `“${current.name}”` }
        : null;
  return { read, page, current, destination };
}

export function FolderBrowser({
  place,
  setPlace,
  location,
  exclude,
  disabled = false,
  unchanged,
}: {
  place: FolderPlace;
  setPlace: (place: FolderPlace) => void;
  location: ReturnType<typeof useFolderPlace>;
  exclude?: ReadonlySet<string>;
  disabled?: boolean;
  unchanged: string;
}) {
  const { read, page } = location;
  const open = (folder: string | null) => setPlace({ section: place.section, folder });
  let list: ReactNode;
  if (read.state.kind === 'loading')
    list = (
      <div role="status" aria-label="Loading folders" className="space-y-3 py-2">
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading folders…</span>
      </div>
    );
  else if (read.state.kind === 'unavailable')
    list = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="Folder unavailable"
        description="It was moved to Trash, or your access changed."
      >
        <Button variant="outline" disabled={disabled} onClick={() => open(null)}>
          Back to {sections[place.section]}
        </Button>
      </StatePanel>
    );
  else if (read.state.kind === 'error')
    list = (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load folders"
        description={`${unchanged} Check your connection and try again.`}
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry loading folders
        </Button>
      </StatePanel>
    );
  else {
    const folders = read.state.data.items.filter(item => item.kind === 'folder' && !exclude?.has(item.id));
    const more = read.state.data.next && read.state.data.items.at(-1)?.kind === 'folder' ? read.state.data.next : null;
    list = folders.length ? (
      <ul aria-label="Folders" className="space-y-0.5">
        {folders.map(folder => (
          <li key={folder.id}>
            <Button variant="ghost" size="nav" disabled={disabled} onClick={() => open(folder.id)}>
              <Folder size={16} aria-hidden="true" />
              <span className="min-w-0 truncate" title={folder.name}>
                {folder.name}
              </span>
              {folder.role === 'viewer' && (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{roleLabels.viewer}</span>
              )}
            </Button>
          </li>
        ))}
        {more && (
          <li>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setPlace({ ...place, after: more })}>
              Show more folders
            </Button>
          </li>
        )}
      </ul>
    ) : (
      <p className="py-4 text-sm text-muted-foreground">No folders here.</p>
    );
  }
  return (
    <>
      <div role="group" aria-label="Location" className="flex flex-wrap gap-1">
        {(['mine', 'shared'] as const).map(section => (
          <Button
            key={section}
            variant={place.section === section ? 'secondary' : 'ghost'}
            size="sm"
            disabled={disabled}
            aria-pressed={place.section === section}
            onClick={() => setPlace({ section, folder: null })}
          >
            {sections[section]}
          </Button>
        ))}
      </div>
      <Breadcrumb aria-label="Destination path">
        <BreadcrumbList>
          <BreadcrumbItem>
            {place.folder === null ? (
              <BreadcrumbPage>{sections[place.section]}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink
                render={<Button variant="ghost" size="xs" disabled={disabled} onClick={() => open(null)} />}
              >
                {sections[place.section]}
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {page?.breadcrumbs.map((crumb, index) => (
            <Fragment key={crumb.id}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {index === page.breadcrumbs.length - 1 ? (
                  <BreadcrumbPage>
                    <span className="block max-w-40 truncate" title={crumb.name}>
                      {crumb.name}
                    </span>
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    render={<Button variant="ghost" size="xs" disabled={disabled} onClick={() => open(crumb.id)} />}
                  >
                    <span className="block max-w-40 truncate" title={crumb.name}>
                      {crumb.name}
                    </span>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {list}
    </>
  );
}
