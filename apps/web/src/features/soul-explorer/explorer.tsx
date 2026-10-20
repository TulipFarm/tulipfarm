import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, ArrowLeft, RefreshCw } from 'lucide-react';
import type { SoulEntry, SoulFile } from '@tulipfarm/workspaces/soul-explorer-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { CodeBlock } from '@tulipfarm/sprout/code-block';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@tulipfarm/sprout/resizable';
import { useIsMobile } from '@/hooks/use-mobile';
import { GovernanceRequestError } from '@/lib/governance';
import { soulApi } from './api';
import { useSoulRead } from './queries';

type Failure = 'changed' | 'denied' | null;
type TreeProps = { entries: SoulEntry[]; selected: string | null; select: (path: string) => void };

function ReadError({ retry, error }: { retry: () => void; error: unknown }) {
  if (error instanceof GovernanceRequestError && error.code === 'soul-not-ready') {
    return (
      <StatePanel
        kind="unavailable"
        title="Soul is not ready"
        description="This workspace does not have a ready saved repository yet."
      >
        <Button onClick={retry}>Check again</Button>
      </StatePanel>
    );
  }
  if (error instanceof GovernanceRequestError && error.code === 'soul-snapshot-too-large') {
    return (
      <StatePanel
        kind="unavailable"
        title="Soul is too large to display"
        description="The full read exceeds the 32 MiB or 10,000-file limit. No files were loaded."
      >
        <Button onClick={retry}>Check again</Button>
      </StatePanel>
    );
  }
  return (
    <StatePanel kind="error" title="Could not read Soul" description="The read failed. Retry to load the saved files.">
      <Button onClick={retry}>Retry read</Button>
    </StatePanel>
  );
}

function Directory({
  entries,
  directory = '',
  search = '',
  selected,
  select,
  depth = 1,
}: TreeProps & { directory?: string; search?: string; depth?: number }) {
  const [limit, setLimit] = useState(100);
  const matches = useMemo(
    () =>
      entries
        .filter(entry =>
          search
            ? entry.kind === 'file' && entry.path.toLowerCase().includes(search.toLowerCase())
            : entry.path.slice(0, entry.path.lastIndexOf('/') + 1) === (directory ? `${directory}/` : ''),
        )
        .sort((a, b) =>
          a.kind === b.kind ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.kind === 'directory' ? -1 : 1,
        ),
    [entries, directory, search],
  );
  return (
    <>
      {!matches.length && (
        <li role="none">
          <p className="px-3 py-2 text-sm text-muted-foreground">
            {search ? 'No matching paths.' : 'This folder is empty.'}
          </p>
        </li>
      )}
      {matches.slice(0, limit).map(entry => (
        <TreeEntry key={entry.path} entry={entry} depth={depth} entries={entries} selected={selected} select={select} />
      ))}
      {matches.length > limit && (
        <li role="none">
          <Button variant="ghost" onClick={() => setLimit(value => value + 100)}>
            Load more files
          </Button>
        </li>
      )}
    </>
  );
}

function TreeEntry({ entry, depth, ...props }: TreeProps & { entry: SoulEntry; depth: number }) {
  const [open, setOpen] = useState(false);
  const folder = entry.kind === 'directory';
  return (
    <li role="none">
      <div className={`grid min-w-0 grid-cols-1 rounded-md ${props.selected === entry.path ? 'bg-accent' : ''}`}>
        <Button
          variant="ghost"
          size="nav"
          role="treeitem"
          aria-level={depth}
          aria-selected={props.selected === entry.path}
          aria-expanded={folder ? open : undefined}
          data-path={entry.path}
          data-parent={entry.path.split('/').slice(0, -1).join('/')}
          onClick={() => (folder ? setOpen(!open) : props.select(entry.path))}
        >
          {folder ? (
            <>
              {open ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
              <Folder aria-hidden="true" size={14} />
            </>
          ) : (
            <FileText aria-hidden="true" size={14} />
          )}
          <span className="min-w-0 flex-1 truncate text-left" title={entry.path}>
            {entry.path.split('/').at(-1)}
          </span>
        </Button>
      </div>
      {folder && open && (
        <ul role="group" className="ml-3 border-l pl-2">
          <Directory
            entries={props.entries}
            selected={props.selected}
            select={props.select}
            directory={entry.path}
            depth={depth + 1}
          />
        </ul>
      )}
    </li>
  );
}

function treeKeys(event: KeyboardEvent<HTMLUListElement>) {
  if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'treeitem') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const item = event.target;
  const index = items.indexOf(item);
  let target: HTMLElement | undefined;
  if (event.key === 'ArrowDown') target = items[index + 1];
  else if (event.key === 'ArrowUp') target = items[index - 1];
  else if (event.key === 'Home') target = items[0];
  else if (event.key === 'End') target = items.at(-1);
  else if (event.key === 'ArrowRight') {
    if (item.getAttribute('aria-expanded') === 'false') item.click();
    else if (item.getAttribute('aria-expanded') === 'true') target = items[index + 1];
  } else if (event.key === 'ArrowLeft') {
    if (item.getAttribute('aria-expanded') === 'true') item.click();
    else target = items.find(candidate => candidate.dataset.path === item.dataset.parent);
  } else return;
  event.preventDefault();
  target?.focus();
}

function FilePane({ file }: { file: SoulFile }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [file.path]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <h2 ref={heading} tabIndex={-1} className="sr-only">
        {file.path}
      </h2>
      {file.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          title="File cannot be displayed"
          description={
            file.reason === 'too-large'
              ? 'This file is larger than the 1 MiB display limit.'
              : 'Binary files cannot be displayed.'
          }
        />
      ) : (
        <>
          <CodeBlock
            key={`${file.revision}:${file.path}`}
            code={file.content}
            language="text"
            filename={file.path}
            variant="file"
          />
          {file.content === '' && <p className="p-4 text-sm text-muted-foreground">This file is empty.</p>}
        </>
      )}
    </div>
  );
}

export function SoulExplorer({ workspaceId, denied }: { workspaceId: string; denied: () => void }) {
  const [version, setVersion] = useState(0);
  return (
    <ExplorerSession
      key={version}
      workspaceId={workspaceId}
      refresh={() => setVersion(value => value + 1)}
      denied={denied}
    />
  );
}

function ExplorerSession({
  workspaceId,
  refresh,
  denied,
}: {
  workspaceId: string;
  refresh: () => void;
  denied: () => void;
}) {
  const api = useMemo(() => soulApi(workspaceId), [workspaceId]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [failure, setFailure] = useState<Failure>(null);
  const mobile = useIsMobile();
  const session = useId();
  const root = useSoulRead(['snapshot', session], signal => api.snapshot(signal));
  const files = useMemo(() => new Map(root.data?.files.map(file => [file.path, file])), [root.data]);
  const failed = useCallback(
    (error: unknown) => {
      if (error instanceof GovernanceRequestError && [401, 403, 404].includes(error.status)) {
        setSelected(null);
        setFailure('denied');
        denied();
      } else if (error instanceof GovernanceRequestError && error.status === 409) {
        setSelected(null);
        setFailure('changed');
      }
    },
    [denied],
  );
  useEffect(() => {
    if (root.error) failed(root.error);
  }, [root.error, failed]);
  const revision = root.data?.revision ?? '';
  const tree = (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={event => {
          event.preventDefault();
          setFilter(search.trim());
        }}
      >
        <div className="min-w-0 flex-1">
          <Label htmlFor="soul-path-search">Find a file</Label>
          <Input
            id="soul-path-search"
            value={search}
            maxLength={120}
            placeholder="Search paths"
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
      </form>
      {filter && (
        <Button
          variant="ghost"
          onClick={() => {
            setSearch('');
            setFilter('');
          }}
        >
          Clear search
        </Button>
      )}
      <ul role="tree" aria-label="Soul files" onKeyDown={treeKeys} className="min-h-0 flex-1 overflow-auto">
        <Directory
          key={filter}
          entries={root.data?.entries ?? []}
          selected={selected}
          select={setSelected}
          search={filter}
        />
      </ul>
    </div>
  );
  const selectedFile = selected ? files.get(selected) : undefined;
  const file = selectedFile ? (
    <FilePane key={selected} file={selectedFile} />
  ) : (
    <StatePanel
      kind="empty"
      title="Select a file"
      description="Open a file from the tree to read its saved contents. Files cannot be edited here."
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="min-w-0 truncate text-xs text-muted-foreground">
          {revision ? (
            <>
              Accepted revision <code title={revision}>{revision.slice(0, 12)}</code>
            </>
          ) : (
            'Soul repository'
          )}
        </div>
        <div className="flex items-center gap-2">
          {mobile && selected && (
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(null);
                requestAnimationFrame(() => document.getElementById('soul-path-search')?.focus());
              }}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Back
            </Button>
          )}
          <Button variant="outline" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </div>
      {failure === 'changed' ? (
        <StatePanel
          kind="unavailable"
          title="Soul changed"
          description="The saved revision or your file access changed. Refresh before opening another file."
        >
          <Button onClick={refresh}>Refresh Soul</Button>
        </StatePanel>
      ) : failure === 'denied' ? (
        <StatePanel
          kind="unavailable"
          title="Soul is unavailable"
          description="Your access or this feature's availability changed."
        />
      ) : root.error ? (
        <ReadError error={root.error} retry={() => void root.refetch()} />
      ) : !revision ? (
        <StatePanel kind="loading" title="Loading Soul" description="Checking access and reading the saved files." />
      ) : (
        <div className="min-h-80 min-w-0 flex-1 overflow-hidden">
          {mobile ? (
            <div className="h-full overflow-auto">{selected ? file : tree}</div>
          ) : (
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize="28%" minSize="220px">
                <div className="h-full overflow-auto bg-muted/20">{tree}</div>
              </ResizablePanel>
              <ResizableHandle aria-label="Resize file tree" />
              <ResizablePanel minSize="35%">
                <div className="h-full overflow-auto">{file}</div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      )}
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        Read-only saved files, not live state or table rows. Only supported files you can access are shown.
      </p>
    </div>
  );
}
