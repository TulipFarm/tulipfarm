import { useEffect, useRef, useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
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
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { ToolbarStatus } from '@tulipfarm/sprout/toolbar-status';
import type { RecordMutation, TableApi, TableDataRow, TableDefinition } from './api';
import { UnsavedChanges } from './feedback';
import { RecordMutationFeedback, useRecordMutation } from './record-mutation';
import { exportSelectedCsv } from './table-export';
import type { TableView } from './table-view';

export function BulkRecordActions({
  records,
  api,
  table,
  view,
  disabled,
  canDelete,
  clear,
  remove,
  busy,
}: {
  records: TableDataRow[];
  api: TableApi;
  table: TableDefinition;
  view: TableView;
  disabled: boolean;
  canDelete: boolean;
  clear: () => void;
  remove: () => void;
  busy: (value: boolean) => void;
}) {
  const [state, setState] = useState<{ kind: 'idle' | 'loading' | 'success' | 'error'; message?: string }>({
    kind: 'idle',
  });
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      busy(false);
    },
    [busy],
  );
  const run = async () => {
    if (controller.current) return;
    const next = new AbortController();
    controller.current = next;
    busy(true);
    setState({ kind: 'loading' });
    try {
      const count = await exportSelectedCsv(
        api,
        table,
        view,
        records.map(record => record.id),
        next.signal,
      );
      if (!next.signal.aborted)
        setState({ kind: 'success', message: `Exported ${count} selected ${count === 1 ? 'row' : 'rows'}.` });
    } catch (error) {
      if (!next.signal.aborted)
        setState({ kind: 'error', message: `Export failed. ${error instanceof Error ? error.message : 'Try again.'}` });
    } finally {
      if (controller.current === next) {
        controller.current = null;
        busy(false);
      }
    }
  };
  const outcome = state.message ? (
    <ToolbarStatus
      label={state.kind === 'error' ? 'Export failed' : 'Exported'}
      message={state.message}
      error={state.kind === 'error'}
    >
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run()}>
        {state.kind === 'error' ? 'Retry export' : 'Export again'}
      </Button>
    </ToolbarStatus>
  ) : null;
  return (
    <div aria-label="Selected row actions" role="group" className="flex min-w-0 items-center gap-2">
      <span role="status" className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums">
        {records.length} selected<span className="sr-only"> on this page</span>
      </span>
      <div className="hidden items-center gap-2 @xl/selection:flex">
        {outcome ?? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-busy={state.kind === 'loading'}
            onClick={() => void run()}
          >
            <Download size={16} aria-hidden="true" />
            {state.kind === 'loading' ? 'Exporting...' : 'Export selected'}
          </Button>
        )}
        {canDelete && (
          <Button variant="destructive" size="sm" disabled={disabled} onClick={remove}>
            <Trash2 size={16} aria-hidden="true" />
            Delete selected
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2 @xl/selection:hidden">
        {outcome ?? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" disabled={disabled} aria-busy={state.kind === 'loading'} />}
            >
              {state.kind === 'loading' ? 'Exporting...' : 'Selected actions'}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={disabled} onClick={() => void run()}>
                  Export selected
                </DropdownMenuItem>
                {canDelete && (
                  <DropdownMenuItem variant="destructive" disabled={disabled} onClick={remove}>
                    Delete selected
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {outcome && canDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
              Actions
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" disabled={disabled} onClick={remove}>
                  Delete selected
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <Button variant="ghost" size="sm" disabled={disabled} aria-label="Clear selection" onClick={clear}>
        Clear
      </Button>
    </div>
  );
}

export function BulkRecordDelete({
  records,
  table,
  api,
  disabled,
  close,
  refresh,
}: {
  records: TableDataRow[];
  table: TableDefinition;
  api: TableApi;
  disabled: boolean;
  close: (count: number) => void;
  refresh: () => Promise<void>;
}) {
  const [requests] = useState<RecordMutation[]>(() =>
    records.map(record => ({
      kind: 'delete',
      requestId: crypto.randomUUID(),
      tableId: table.id,
      revision: table.revision,
      recordId: record.id,
      expectedToken: record.token,
    })),
  );
  const [started, setStarted] = useState(false);
  const [deleted, setDeleted] = useState(0);
  const [sending, setSending] = useState(false);
  const complete = deleted === requests.length;
  const current = requests[deleted];
  const blocked = disabled || current?.revision !== table.revision;
  const dismiss = () => {
    if (!sending) {
      close(deleted);
      if (started) void refresh();
    }
  };
  return (
    <>
      <UnsavedChanges dirty={started && !complete} />
      <AlertDialog
        open
        onOpenChange={open => {
          if (!open) dismiss();
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {complete
              ? 'Rows deleted'
              : `Delete ${requests.length} selected ${requests.length === 1 ? 'row' : 'rows'}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Only the selected rows on this page will be deleted. Restore them from Deleted rows within 30 days. Deletion
            stops if a row changed, is linked, or access was removed.
          </AlertDialogDescription>
          {started && (
            <p role="status" className="text-sm tabular-nums">
              {deleted} of {requests.length} rows deleted.
            </p>
          )}
          {started && !complete && current && (
            <BulkDeleteStep
              key={current.requestId}
              input={current}
              api={api}
              disabled={blocked}
              done={() => setDeleted(count => count + 1)}
              busy={setSending}
              refresh={refresh}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>
              {complete ? 'Done' : started ? 'Close and review rows' : 'Keep rows'}
            </AlertDialogCancel>
            {!started && (
              <Button variant="destructive" disabled={blocked} onClick={() => setStarted(true)}>
                Delete {requests.length} {requests.length === 1 ? 'row' : 'rows'}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BulkDeleteStep({
  input,
  api,
  disabled,
  done,
  busy,
  refresh,
}: {
  input: RecordMutation;
  api: TableApi;
  disabled: boolean;
  done: () => void;
  busy: (value: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const mutation = useRecordMutation(api, done);
  const started = useRef(false);
  useEffect(() => {
    if (disabled || started.current) return;
    started.current = true;
    void mutation.submit(input);
  }, [disabled, input, mutation]);
  const sending = mutation.state.kind === 'sending';
  useEffect(() => {
    busy(sending);
    return () => busy(false);
  }, [busy, sending]);
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Row {input.recordId.slice(0, 8)}</p>
      {disabled && mutation.state.kind === 'idle' && (
        <Alert>
          <AlertDescription>
            Deletion is paused while table access or fields are checked. Close and review the current rows if it does
            not resume.
          </AlertDescription>
        </Alert>
      )}
      {mutation.state.kind === 'rejected' && (
        <p className="text-sm">Deletion stopped. No further rows will be deleted.</p>
      )}
      <RecordMutationFeedback mutation={mutation} refresh={refresh} />
    </div>
  );
}
