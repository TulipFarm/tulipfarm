import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { SoulFile } from '@tulipfarm/workspaces/soul-explorer-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { FileExplorer, type FileExplorerFile } from '@tulipfarm/sprout/file-explorer';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { GovernanceRequestError } from '@/lib/governance';
import { soulApi } from './api';
import { useSoulRead } from './queries';

type Failure = 'changed' | 'denied' | null;

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

const unavailable = {
  'too-large': 'This file is larger than the 1 MiB display limit.',
  binary: 'Binary files cannot be displayed.',
} as const;

const explorerFile = (file: SoulFile): FileExplorerFile =>
  file.kind === 'text'
    ? { path: file.path, content: file.content }
    : { path: file.path, unavailable: unavailable[file.reason] };

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
  const [failure, setFailure] = useState<Failure>(null);
  const session = useId();
  const root = useSoulRead(['snapshot', session], signal => api.snapshot(signal));
  const files = useMemo(() => root.data?.files.map(explorerFile) ?? [], [root.data]);
  const failed = useCallback(
    (error: unknown) => {
      if (error instanceof GovernanceRequestError && [401, 403, 404].includes(error.status)) {
        setFailure('denied');
        denied();
      } else if (error instanceof GovernanceRequestError && error.status === 409) {
        setFailure('changed');
      }
    },
    [denied],
  );
  useEffect(() => {
    if (root.error) failed(root.error);
  }, [root.error, failed]);
  const revision = root.data?.revision ?? '';
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
        <div className="grid min-h-80 min-w-0 flex-1">
          <FileExplorer files={files} label="Soul" />
        </div>
      )}
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        Read-only saved files, not live state or table rows. Only supported files you can access are shown.
      </p>
    </div>
  );
}
