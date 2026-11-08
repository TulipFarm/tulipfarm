import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MoreH } from 'reicon-react/icons/MoreH';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import { DeletedRecords } from './deleted-records';
import { DefinitionStatus, SchemaHistory } from './schema-history';
import { archiveMessage, type ArchiveKind, type ArchiveStatus, type DefinitionState, type TableApi } from './api';
import { useTableChanges } from './changes';
import { TableRequestError } from './request-state';
import type { TableWorkspace } from './references';

type Panel = 'deleted' | 'schema';

const wideHeaderQuery = '(min-width: 640px)';
const subscribeWideHeader = (changed: () => void) => {
  const media = window.matchMedia(wideHeaderQuery);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};
/** Below 640px the workspace header is too narrow for text buttons beside the table name. */
export function useWideTableHeader() {
  return useSyncExternalStore(
    subscribeWideHeader,
    () => window.matchMedia(wideHeaderQuery).matches,
    () => true,
  );
}

/** Table maintenance lives behind one menu so the page stays about rows. */
export function TableMore({
  state,
  api,
  workspace,
  disabled,
  changeFields = false,
}: {
  state: DefinitionState;
  api: TableApi;
  workspace: TableWorkspace;
  disabled: boolean;
  /** Offers "Change fields in chat" here when the header has no room for its button. */
  changeFields?: boolean;
}) {
  const navigate = useNavigate();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [archiving, setArchiving] = useState<ArchiveKind | null>(null);
  const applied = state.applied;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More table options" />}>
          <MoreH size={16} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {changeFields && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() =>
                    void navigate({
                      to: '/$workspaceSlug',
                      params: { workspaceSlug: workspace.slug },
                      search: { intent: 'edit-table', tableId: state.id },
                    })
                  }
                >
                  Change fields in chat
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuGroup>
            {applied && <DropdownMenuItem onClick={() => setPanel('deleted')}>Deleted rows</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => setPanel('schema')}>Schema history</DropdownMenuItem>
          </DropdownMenuGroup>
          {applied && state.canArchive && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" disabled={disabled} onClick={() => setArchiving('archive')}>
                  Archive table
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
          {applied && state.canRestore && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={disabled} onClick={() => setArchiving('restore')}>
                  Unarchive table
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Sheet
        open={panel !== null}
        onOpenChange={open => {
          if (!open) setPanel(null);
        }}
      >
        <SheetContent size="xl">
          <SheetHeader>
            <SheetTitle>{panel === 'deleted' ? 'Deleted rows' : 'Schema history'}</SheetTitle>
            <SheetDescription>
              {panel === 'deleted'
                ? 'Deleted rows stay recoverable for 30 days.'
                : 'Field definitions and the changes that produced them.'}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 pb-6">
            {panel === 'deleted' && applied && (
              <DeletedRecords
                table={{
                  id: state.id,
                  revision: applied.revision,
                  definition: applied.definition,
                  systemKind: state.systemKind,
                }}
                permissions={state.rowPermissions}
                api={api}
                workspace={workspace}
                disabled={disabled}
              />
            )}
            {panel === 'schema' && (
              <>
                <DefinitionStatus state={state} />
                <SchemaHistory tableId={state.id} api={api} workspaceSlug={workspace.slug} />
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      {archiving && applied && (
        <ArchiveTable
          kind={archiving}
          tableId={state.id}
          label={applied.definition.label}
          revision={applied.revision}
          api={api}
          workspaceSlug={workspace.slug}
          close={() => setArchiving(null)}
        />
      )}
    </>
  );
}

const archivePollMs = 1500;
const archiveWaitMs = 120_000;
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
const settled = new Set<ArchiveStatus['status']>([
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'expired',
  'partial',
]);

/** Unarchive offered on an archived table's page, next to the message that says it is archived. */
export function UnarchiveTable({
  state,
  api,
  workspaceSlug,
  disabled,
}: {
  state: DefinitionState;
  api: TableApi;
  workspaceSlug: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!state.canRestore || !state.applied) return null;
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)}>
        Unarchive table
      </Button>
      {open && (
        <ArchiveTable
          kind="restore"
          tableId={state.id}
          label={state.applied.definition.label}
          revision={state.applied.revision}
          api={api}
          workspaceSlug={workspaceSlug}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

const copy = {
  archive: {
    title: 'Archive',
    description:
      "Its rows are kept. It's removed from Tables and Table access. Agents and disabled workflows that use it can't use it until it's unarchived. To unarchive it, open it from Archived tables.",
    keep: 'Keep table',
    action: 'Archive table',
    pending: 'Archiving table…',
    slow: "Archiving is taking longer than usual. Check Tables later. If the table isn't listed, it was archived. It continues if you close this dialog.",
  },
  restore: {
    title: 'Unarchive',
    description:
      'It returns to Tables with its fields, rows and views. Workflows that were disabled stay disabled until you turn them on.',
    keep: 'Keep archived',
    action: 'Unarchive table',
    pending: 'Unarchiving table…',
    slow: 'Unarchiving is taking longer than usual. Reload this table later. It continues if you close this dialog.',
  },
} as const;

function ArchiveTable({
  kind,
  tableId,
  label,
  revision,
  api,
  workspaceSlug,
  close,
}: {
  kind: ArchiveKind;
  tableId: string;
  label: string;
  revision: string;
  api: TableApi;
  workspaceSlug: string;
  close: () => void;
}) {
  const navigate = useNavigate();
  const changes = useTableChanges();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const text = copy[kind];
  const stop = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    stop.current = controller;
    return () => controller.abort();
  }, []);
  const archive = async () => {
    const signal = stop.current?.signal;
    if (pending || !signal) return;
    setPending(true);
    setFailure(null);
    const requestId = crypto.randomUUID();
    try {
      let status = await api.archive(tableId, requestId, revision, kind);
      // The storage worker applies the change in the background; wait here for its outcome.
      const deadline = Date.now() + archiveWaitMs;
      while (!settled.has(status.status)) {
        if (Date.now() > deadline) {
          setFailure(text.slow);
          return;
        }
        await wait(archivePollMs, signal);
        status = await api.archiveStatus(
          tableId,
          requestId,
          AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          kind,
        );
      }
      if (status.status === 'completed') {
        if (kind === 'archive') {
          await navigate({ to: '/$workspaceSlug/tables', params: { workspaceSlug } });
          void changes.archived(tableId);
        } else {
          await changes.archived(tableId);
          close();
        }
        return;
      }
      const receipt = status.plans[0]?.receipt;
      if (!signal.aborted)
        setFailure(archiveMessage(receipt?.status === 'failed' ? receipt.code : status.status, 409, kind));
    } catch (error) {
      if (signal.aborted) return;
      setFailure(
        error instanceof TableRequestError ? error.message : archiveMessage('table-operation-failed', 0, kind),
      );
    } finally {
      if (!signal.aborted) setPending(false);
    }
  };
  return (
    <AlertDialog
      open
      onOpenChange={open => {
        if (!open && !pending) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>
          {text.title} {label || 'this table'}?
        </AlertDialogTitle>
        <AlertDialogDescription>{text.description}</AlertDialogDescription>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{text.keep}</AlertDialogCancel>
          <Button
            variant={kind === 'archive' ? 'destructive' : 'default'}
            disabled={pending}
            aria-busy={pending}
            onClick={() => void archive()}
          >
            {pending ? text.pending : text.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
