import type { ReactElement, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Folder } from 'reicon-react/icons/Folder';
import type { FilePerson, LibraryItem, LibraryPage, LibraryQuery } from '@tulipfarm/files/contracts';
import { workspaceRoute } from '@/router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { useFeatureRead } from '@/lib/query';
import type { ReadState } from '@/features/tables/request-state';
import {
  fileKeys,
  filtered,
  libraryFilters,
  librarySort,
  modifiedText,
  place,
  useFilesApi,
  viewerSearchSchema,
  type FilesSearch,
} from './api';
import { FilterBar, type FilterChange } from './filters';
import { GoogleFileIcon } from './google-drive';
import {
  googleFileKeys,
  googleOwner,
  outcome,
  useDriveAccess,
  useGoogleFilesApi,
  type DriveAccess,
  type GoogleFileMetadata,
  type ListQuery,
} from './google-api';

const shown = 20;
type Section = 'mine' | 'shared';
const sectionLabels: Record<Section, string> = { mine: 'My files', shared: 'Shared with me' };
type Result = { id: string; name: string; icon: ReactNode; link: ReactElement; context: string[] };

/**
 * Name search across My files, Shared with me, and the connected Google Drive.
 * Each source loads and fails on its own: a slow or failing source never hides another source's results.
 */
export function AllSources({
  workspaceId,
  membershipId,
  search,
  change,
}: {
  workspaceId: string;
  membershipId: string;
  search: FilesSearch;
  change: FilterChange;
}) {
  const api = useFilesApi(workspaceId);
  const query = search.q ?? '';
  const library = (section: Section): LibraryQuery => ({
    section,
    query,
    location: { kind: 'root' },
    sort: librarySort(search),
    filters: libraryFilters(search),
  });
  const mine = useFeatureRead({
    key: fileKeys.library(library('mine')),
    staleTime: 0,
    load: signal => api.library(library('mine'), signal),
  });
  const shared = useFeatureRead({
    key: fileKeys.library(library('shared')),
    staleTime: 0,
    load: signal => api.library(library('shared'), signal),
  });
  const owners = new Map<string, FilePerson>();
  for (const read of [mine, shared])
    if (read.state.kind === 'ready')
      for (const person of read.state.data.owners) owners.set(person.membershipId, person);
  return (
    <div className="space-y-6">
      <FilterBar search={search} owners={[...owners.values()]} membershipId={membershipId} change={change} />
      <FilesSource section="mine" read={mine} search={search} membershipId={membershipId} />
      <FilesSource section="shared" read={shared} search={search} membershipId={membershipId} />
      <GoogleSource workspaceId={workspaceId} search={search} />
    </div>
  );
}

function Group({
  label,
  more,
  children,
}: {
  label: string;
  more?: ReactElement | false | undefined;
  children: ReactNode;
}) {
  const id = `all-sources-${label.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-1.5">
        <h3 id={id} className="text-sm font-medium text-foreground">
          {label}
        </h3>
        {more}
      </div>
      {children}
    </section>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={`Searching ${label}`} className="space-y-3 py-1">
      <Skeleton />
      <Skeleton />
      <span className="sr-only">Searching {label}…</span>
    </div>
  );
}

function Failed({ text, retry }: { text: string; retry: () => Promise<unknown> }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Alert variant="destructive">
        <AlertDescription>{text}</AlertDescription>
      </Alert>
      <Button variant="outline" size="sm" onClick={() => void retry()}>
        Retry
      </Button>
    </div>
  );
}

function Results({ label, results, empty }: { label: string; results: Result[]; empty: string }) {
  if (!results.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul aria-label={`${label} results`} className="divide-y">
      {results.map(result => (
        <li key={result.id} className="flex min-w-0 items-center gap-3 py-1.5">
          <span aria-hidden="true" className="flex w-8 shrink-0 justify-center text-muted-foreground">
            {result.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="grid min-w-0 grid-cols-1">
              <Button variant="link" size="md" nativeButton={false} role="link" render={result.link}>
                <span className="min-w-0 flex-1 truncate text-start" title={result.name}>
                  {result.name}
                </span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{result.context.filter(Boolean).join(' · ')}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function FilesSource({
  section,
  read,
  search,
  membershipId,
}: {
  section: Section;
  read: { state: ReadState<LibraryPage>; refresh: () => Promise<void> };
  search: FilesSearch;
  membershipId: string;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const label = sectionLabels[section];
  const { state } = read;
  if (state.kind === 'loading')
    return (
      <Group label={label}>
        <Loading label={label} />
      </Group>
    );
  if (state.kind !== 'ready')
    return (
      <Group label={label}>
        <Failed
          text={
            state.kind === 'unavailable'
              ? `${label} isn’t available right now. Your access may have changed.`
              : `Couldn’t search ${label}. Other results are still shown.`
          }
          retry={read.refresh}
        />
      </Group>
    );
  const page = state.data;
  const owner = (item: LibraryItem) =>
    item.creatorMembershipId === membershipId
      ? 'You'
      : (page.owners.find(person => person.membershipId === item.creatorMembershipId)?.name ?? 'Former member');
  const results = page.items.slice(0, shown).map(item => ({
    id: item.id,
    name: item.name,
    icon:
      item.kind === 'folder' ? (
        <Folder size={20} />
      ) : (
        <FileTypeIcon name={item.name} mediaType={item.mediaType ?? 'application/octet-stream'} />
      ),
    link:
      item.kind === 'folder' ? (
        <Link
          to="/$workspaceSlug/files"
          params={{ workspaceSlug }}
          search={{ ...(section === 'mine' ? {} : { section }), folder: item.id }}
        />
      ) : (
        <Link
          to="/$workspaceSlug/files/$fileId"
          params={{ workspaceSlug, fileId: item.id }}
          search={viewerSearchSchema.parse(search)}
        />
      ),
    context: [
      label,
      item.parentId === null ? '' : (place(item, membershipId) ?? ''),
      owner(item),
      `Modified ${modifiedText(item.modifiedAt)}`,
    ],
  }));
  const more = (page.items.length > shown || page.next !== null) && (
    <Button
      variant="link"
      size="sm"
      nativeButton={false}
      role="link"
      render={
        <Link
          to="/$workspaceSlug/files"
          params={{ workspaceSlug }}
          search={{ ...search, scope: undefined, after: undefined, section: section === 'mine' ? undefined : section }}
        />
      }
    >
      Show all in {label}
    </Button>
  );
  return (
    <Group label={label} more={more}>
      {state.error && (
        <Failed text={`Couldn’t refresh ${label}. The last results are still shown.`} retry={read.refresh} />
      )}
      <Results label={label} results={results} empty={`No matches in ${label}.`} />
    </Group>
  );
}

function Recover({ text }: { text: string }) {
  const { workspaceSlug } = workspaceRoute.useParams();
  return (
    <p className="text-sm text-muted-foreground">
      {text}{' '}
      <Button
        variant="link"
        size="sm"
        nativeButton={false}
        role="link"
        render={<Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={{ section: 'google' }} />}
      >
        Open Google Drive
      </Button>
    </p>
  );
}

function GoogleSource({ workspaceId, search }: { workspaceId: string; search: FilesSearch }) {
  const drive = useDriveAccess(workspaceId);
  const { access } = drive;
  if (access.kind === 'loading')
    return (
      <Group label="Google Drive">
        <Loading label="Google Drive" />
      </Group>
    );
  if (access.kind === 'error' || access.kind === 'unavailable')
    return (
      <Group label="Google Drive">
        <Failed
          text="Couldn’t check your Google Drive integration. Other results are still shown."
          retry={drive.refresh}
        />
      </Group>
    );
  if (access.kind !== 'ready')
    return (
      <Group label="Google Drive">
        <Recover text={notReady(access.kind)} />
      </Group>
    );
  return (
    <GoogleResults
      key={`${access.binding.integrationId}:${access.binding.accountId}:${access.binding.generation}`}
      workspaceId={workspaceId}
      access={access}
      search={search}
    />
  );
}

function notReady(kind: DriveAccess['kind']) {
  if (kind === 'reconnect') return 'Reconnect Google Drive to include it in search.';
  if (kind === 'grant') return 'Allow Drive access to include Google Drive in search.';
  return 'Google Drive isn’t connected, so it isn’t searched.';
}

function GoogleResults({
  workspaceId,
  access,
  search,
}: {
  workspaceId: string;
  access: Extract<DriveAccess, { kind: 'ready' }>;
  search: FilesSearch;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const api = useGoogleFilesApi(workspaceId, access.binding, access.scopes);
  const query: ListQuery = { name: search.q ?? '', pageSize: shown };
  const list = useFeatureRead({
    key: googleFileKeys.list(access.binding, query),
    staleTime: 0,
    load: signal => outcome(() => api.list(query, signal)),
  });
  const label = 'Google Drive';
  const note = filtered(search) && (
    <p className="text-xs text-muted-foreground">
      Google Drive results match names only. Filters apply to TulipFarm files.
    </p>
  );
  const more = (
    <Button
      variant="link"
      size="sm"
      nativeButton={false}
      role="link"
      render={
        <Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={{ section: 'google', q: search.q }} />
      }
    >
      Show all in Google Drive
    </Button>
  );
  const { state } = list;
  if (state.kind === 'loading')
    return (
      <Group label={label}>
        <Loading label={label} />
      </Group>
    );
  if (state.kind !== 'ready')
    return (
      <Group label={label}>
        <Failed
          text={
            state.kind === 'error' && state.busy
              ? 'Google Drive is busy. Other results are still shown.'
              : 'Couldn’t search Google Drive. Other results are still shown.'
          }
          retry={list.refresh}
        />
      </Group>
    );
  if (state.data.kind === 'blocked') {
    const { block } = state.data;
    return (
      <Group label={label}>
        {block === 'reconnect' || block === 'grant' ? (
          <Recover text={notReady(block)} />
        ) : (
          <Failed
            text={
              block === 'denied'
                ? 'Google denied this search for your account. Other results are still shown.'
                : 'Google rejected this search. Other results are still shown.'
            }
            retry={list.refresh}
          />
        )}
      </Group>
    );
  }
  const page = state.data.value;
  const results = page.files.map((file: GoogleFileMetadata) => ({
    id: file.id,
    name: file.name,
    icon: <GoogleFileIcon file={file} />,
    link:
      file.mimeType === 'application/vnd.google-apps.folder' ? (
        <Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={{ section: 'google', drive: file.id }} />
      ) : (
        <Link
          to="/$workspaceSlug/files/google/$fileId"
          params={{ workspaceSlug, fileId: file.id }}
          search={viewerSearchSchema.parse(search)}
        />
      ),
    context: [label, googleOwner(file), file.modifiedTime ? `Modified ${modifiedText(file.modifiedTime)}` : ''],
  }));
  return (
    <Group label={label} more={(page.nextPageToken !== undefined || page.incompleteSearch) && more}>
      {note}
      {state.error && (
        <Failed text="Couldn’t refresh Google Drive. The last results are still shown." retry={list.refresh} />
      )}
      <Results label={label} results={results} empty="No matches in Google Drive." />
    </Group>
  );
}
