import { useState } from 'react';
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

const summaryLimit = 10;

function ChangeSummary({ entry }: { entry: SchemaHistoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  if (!entry.changes)
    return entry.definitionWithheld ? null : <p className="text-sm">A summary of this change is not available.</p>;
  const shown = expanded ? entry.changes : entry.changes.slice(0, summaryLimit);
  const more = entry.changes.length - shown.length;
  return (
    <div className="space-y-1 text-sm">
      {entry.phase === 'blocked' && <p>Nothing was applied. The proposed change was:</p>}
      <ul aria-label="What changed" className="list-disc space-y-1 pl-5">
        {shown.map((line, index) => (
          <li key={index} className="break-words">
            {line}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Button variant="link" onClick={() => setExpanded(true)}>
          and {more} more {more === 1 ? 'change' : 'changes'}
        </Button>
      )}
    </div>
  );
}

function ExecutionDetails({ entry }: { entry: SchemaHistoryEntry }) {
  return (
    <div className="space-y-2 text-sm">
      <dl className="space-y-1">
        <div>
          <dt className="inline">Approved by: </dt>
          <dd className="inline">
            {entry.approval
              ? `${entry.approval.name}${entry.approval.formerMember ? ' (former member)' : ''}, ${new Date(entry.approval.approvedAt).toLocaleString()}`
              : 'No approval recorded'}
          </dd>
        </div>
        <div>
          <dt className="inline">Applied: </dt>
          <dd className="inline">{entry.appliedAt ? new Date(entry.appliedAt).toLocaleString() : 'Not applied'}</dd>
        </div>
        <div>
          <dt className="inline">Status: </dt>
          <dd className="inline">{phaseLabels[entry.phase]}</dd>
        </div>
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

const withheldMessages = {
  'blocked-before-save': 'This change was blocked before its definition was saved, so there are no fields to show.',
  retention: 'The fields for this change were removed after their retention period.',
  'source-access':
    'The fields for this change come from a source you can’t access. The person who approved the change can review it in their originating chat.',
};

function WithheldDefinition({ entry }: { entry: SchemaHistoryEntry }) {
  return (
    <p className="mt-3 text-sm">
      {withheldMessages[entry.definitionWithheld ?? 'source-access']} Execution status remains visible.
    </p>
  );
}

function ExecutionReference({ entry }: { entry: SchemaHistoryEntry }) {
  return (
    <dl className="space-y-1 text-sm">
      <div>
        <dt className="inline">Started: </dt>
        <dd className="inline">{new Date(entry.createdAt).toLocaleString()}</dd>
      </div>
      <div>
        <dt className="inline">Saved: </dt>
        <dd className="inline">{entry.savedAt ? new Date(entry.savedAt).toLocaleString() : 'Not saved yet'}</dd>
      </div>
      {entry.revision && (
        <div className="break-all">
          <dt className="inline">Revision: </dt>
          <dd className="inline select-all font-mono text-xs">{entry.revision}</dd>
        </div>
      )}
      <div className="break-all">
        <dt className="inline">Execution: </dt>
        <dd className="inline select-all font-mono text-xs">{entry.id}</dd>
      </div>
    </dl>
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
          <ExecutionReference entry={state.saved} />
          {state.saved.definition ? (
            <DefinitionView definition={state.saved.definition} title="Saved definition" />
          ) : (
            <WithheldDefinition entry={state.saved} />
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
      <p className="text-sm text-muted-foreground">Newest changes first, by when they started.</p>
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
                    <ChangeSummary entry={entry} />
                    <ExecutionDetails entry={entry} />
                    {!entry.definition && <WithheldDefinition entry={entry} />}
                    <Disclosure title="Change details">
                      <ExecutionReference entry={entry} />
                      {entry.definition && (
                        <DefinitionView definition={entry.definition} title="Fields after this change" />
                      )}
                    </Disclosure>
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
