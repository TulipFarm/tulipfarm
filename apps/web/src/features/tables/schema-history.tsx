import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Disclosure } from '@/components/disclosure';
import { useCursorPages } from '@/lib/use-cursor-pages';
import { DefinitionView } from './definition-view';
import { TableRead } from './feedback';
import { useTableSchemaHistory } from './hooks';
import { memberMessages, type DefinitionState, type SchemaHistoryEntry, type TableApi } from './api';

const phaseLabels = {
  publishing: 'Publishing definition',
  copying: 'Migrating rows',
  reconciling: 'Reconciling row changes',
  completed: 'Migration completed',
  blocked: 'Migration blocked',
};

function ExecutionDetails({ entry }: { entry: SchemaHistoryEntry }) {
  return (
    <div className="space-y-2 text-sm">
      <p>{phaseLabels[entry.phase]}</p>
      <dl className="space-y-1">
        <div>
          <dt className="inline">Started: </dt>
          <dd className="inline">{new Date(entry.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="inline">Saved: </dt>
          <dd className="inline">{entry.savedAt ? new Date(entry.savedAt).toLocaleString() : 'Not saved yet'}</dd>
        </div>
        <div>
          <dt className="inline">Applied: </dt>
          <dd className="inline">{entry.appliedAt ? new Date(entry.appliedAt).toLocaleString() : 'Not applied'}</dd>
        </div>
        {entry.revision && (
          <div className="break-all">
            <dt className="inline">Revision: </dt>
            <dd className="inline font-mono text-xs">{entry.revision}</dd>
          </div>
        )}
      </dl>
      {entry.receipt?.status === 'failed' && (
        <p role="alert">
          Execution failed. {memberMessages[entry.receipt.code] ?? `Reference: ${entry.receipt.code}.`} Review the
          proposal in its originating chat.
        </p>
      )}
      {entry.phase === 'blocked' && (
        <p>Review the proposal in its originating chat for the blocking condition and available recovery actions.</p>
      )}
      {['publishing', 'copying', 'reconciling'].includes(entry.phase) && (
        <p>Work continues on the server when you leave. Check status again to see progress.</p>
      )}
    </div>
  );
}

export function DefinitionStatus({ state }: { state: DefinitionState }) {
  return (
    <section aria-label="Definition status" className="space-y-4">
      <h2 className="text-sm font-medium">Current fields</h2>
      <p className="text-sm">
        {state.saved && state.applied?.revision === state.saved.revision
          ? 'The latest saved definition is active.'
          : state.saved
            ? 'The latest saved definition is not active. Rows use the applied definition until migration completes.'
            : 'No saved schema revision is available.'}
      </p>
      {state.applied && (
        <Disclosure title="Applied fields">
          <DefinitionView definition={state.applied.definition} title="Active definition" />
          <p className="mt-3 break-all text-sm">
            Applied revision <span className="font-mono text-xs">{state.applied.revision}</span>
          </p>
          {state.applied.appliedAt && (
            <p className="text-sm">Applied {new Date(state.applied.appliedAt).toLocaleString()}</p>
          )}
        </Disclosure>
      )}
      {state.saved && (
        <Disclosure title="Latest saved fields">
          <ExecutionDetails entry={state.saved} />
          {state.saved.definition ? (
            <DefinitionView definition={state.saved.definition} title="Saved definition" />
          ) : (
            <p className="mt-3 text-sm">
              Saved fields are hidden because their source is unavailable to you. Execution status remains visible.
            </p>
          )}
        </Disclosure>
      )}
    </section>
  );
}

export function SchemaHistory({ tableId, api }: { tableId: string; api: TableApi }) {
  const pages = useCursorPages();
  const read = useTableSchemaHistory(api, tableId, pages.after);
  const busy = read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing);
  return (
    <section aria-label="Schema history" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Changes</h2>
        <Button variant="outline" disabled={busy} aria-busy={busy} onClick={() => void read.refresh()}>
          Check schema history
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Executions are paged by identifier. Use their dates to compare when changes happened.
      </p>
      <TableRead state={read.state} refresh={read.refresh}>
        {data => (
          <>
            {!data.entries.length ? (
              <StatePanel
                kind="empty"
                title="No schema executions on this page"
                description="Schema changes appear here once execution starts. Approved changes may still be waiting to start."
              />
            ) : (
              <ol className="space-y-4">
                {data.entries.map(entry => (
                  <li key={entry.id} className="space-y-3 border-t border-border pt-4">
                    <p className="break-all font-mono text-xs">Execution {entry.id}</p>
                    <ExecutionDetails entry={entry} />
                    {entry.definition ? (
                      <Disclosure title={`Fields for revision ${entry.revision?.slice(0, 12) ?? 'not yet saved'}`}>
                        <DefinitionView definition={entry.definition} title="Historical definition" />
                      </Disclosure>
                    ) : (
                      <p className="text-sm">
                        Historical fields are hidden because their source is unavailable to you. Execution status
                        remains visible.
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {(pages.after || data.nextCursor) && (
              <nav aria-label="Schema history pages" className="flex gap-2">
                <Button variant="outline" disabled={busy || !pages.after} onClick={pages.previous}>
                  Previous schema history
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) pages.next(data.nextCursor);
                  }}
                >
                  Next schema history
                </Button>
              </nav>
            )}
          </>
        )}
      </TableRead>
    </section>
  );
}
