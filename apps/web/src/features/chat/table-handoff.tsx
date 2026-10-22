import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { tableApi } from '@/features/tables/api';
import { failedRead, type ReadState } from '@/features/tables/request-state';
import { requestSignal } from '@/lib/http';

export type TableHandoffIntent = 'edit-table' | 'add-rows';
export type TableHandoffTarget = { id: string; label: string | null; revision: string | null };

export function tableHandoffPrompt(intent: TableHandoffIntent, table: TableHandoffTarget) {
  const name = table.label ? `the “${table.label}” table` : 'this table';
  const identity = table.revision ? `table ID ${table.id}, current revision ${table.revision}` : `table ID ${table.id}`;
  return intent === 'edit-table'
    ? `Help me change the fields of ${name} (${identity}). Read its current fields first, ask what I want to change, then propose the schema change for my review.`
    : `Help me add rows to ${name} (${identity}). Read its current fields first, ask which rows I want to add, then prepare them for my review.`;
}

/**
 * A handoff writes its prompt only after the table read succeeds, or after the person
 * chooses to continue with the ID alone. Until then the request stays in the link.
 */
export type TableHandoff =
  | { kind: 'loading' }
  | { kind: 'ready'; prompt: string }
  | {
      kind: 'failed';
      intent: TableHandoffIntent;
      attempt: number;
      retrying: boolean;
      retry: () => void;
      continueWithId: () => void;
    }
  | { kind: 'unavailable' };

type Session = {
  key: string | null;
  attempt: number;
  settled: { attempt: number; state: ReadState<TableHandoffTarget> } | null;
  idOnly: boolean;
};

export function useTableHandoff(
  workspaceId: string,
  intent: TableHandoffIntent | null,
  tableId: string | null,
): TableHandoff | null {
  const key = intent && tableId ? `${intent}:${tableId}` : null;
  const [stored, setSession] = useState<Session>({ key, attempt: 0, settled: null, idOnly: false });
  const session = stored.key === key ? stored : { key, attempt: 0, settled: null, idOnly: false };
  if (session !== stored) setSession(session);
  const { attempt } = session;
  useEffect(() => {
    if (!intent || !tableId) return;
    const controller = new AbortController(),
      handoff = `${intent}:${tableId}`;
    const settle = (state: ReadState<TableHandoffTarget>) => {
      if (!controller.signal.aborted)
        setSession(current => (current.key === handoff ? { ...current, settled: { attempt, state } } : current));
    };
    tableApi(workspaceId)
      .detail(tableId, requestSignal(controller.signal))
      .then(
        table =>
          settle({
            kind: 'ready',
            refreshing: false,
            error: null,
            data: {
              id: tableId,
              label: table.applied?.definition.label ?? table.saved?.definition?.label ?? null,
              revision: table.applied?.revision ?? null,
            },
          }),
        error => settle(failedRead({ kind: 'loading' }, error)),
      );
    return () => controller.abort();
  }, [workspaceId, intent, tableId, attempt]);
  if (!intent || !tableId) return null;
  if (session.idOnly)
    return { kind: 'ready', prompt: tableHandoffPrompt(intent, { id: tableId, label: null, revision: null }) };
  const { settled } = session;
  if (!settled || settled.state.kind === 'loading') return { kind: 'loading' };
  if (settled.state.kind === 'ready') return { kind: 'ready', prompt: tableHandoffPrompt(intent, settled.state.data) };
  if (settled.state.kind === 'unavailable') return { kind: 'unavailable' };
  return {
    kind: 'failed',
    intent,
    attempt: settled.attempt,
    retrying: settled.attempt !== attempt,
    retry: () => setSession(current => (current.key === key ? { ...current, attempt: current.attempt + 1 } : current)),
    continueWithId: () => setSession(current => (current.key === key ? { ...current, idOnly: true } : current)),
  };
}

export function TableHandoffNotice({ handoff, workspaceSlug }: { handoff: TableHandoff; workspaceSlug: string }) {
  if (handoff.kind === 'unavailable')
    return (
      <div className="space-y-2">
        <Alert variant="destructive">
          <AlertTitle>This table is unavailable</AlertTitle>
          <AlertDescription>
            It was deleted, or your access to it changed. A workspace admin can review your access.
          </AlertDescription>
        </Alert>
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/tables" params={{ workspaceSlug }} />}
        >
          Open tables
        </Button>
      </div>
    );
  if (handoff.kind !== 'failed') return null;
  const request = handoff.intent === 'edit-table' ? 'change this table’s fields' : 'add rows to this table';
  return (
    <div className="space-y-2">
      <Alert key={handoff.attempt}>
        <AlertTitle>Table details didn’t load</AlertTitle>
        <AlertDescription>
          Your request to {request} is kept. Load the details again, or continue and the message will name the table
          only by its ID.
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={handoff.retrying} aria-busy={handoff.retrying} onClick={handoff.retry}>
          {handoff.retrying ? 'Loading table details…' : 'Load table details again'}
        </Button>
        <Button size="sm" variant="outline" disabled={handoff.retrying} onClick={handoff.continueWithId}>
          Continue without table details
        </Button>
      </div>
    </div>
  );
}
