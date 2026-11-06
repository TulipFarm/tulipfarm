import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';

type Entry = {
  id: string;
  title: string;
  status: string;
  order: number;
  /** The proposal's short version name, such as “Add priority field”. */
  label?: string | undefined;
  /** Whether the proposal changes a table schema, so it has a diagram. */
  schema?: boolean | undefined;
  /** The schema's fields as newline-separated `table/field` labels, to name a revision by what changed. */
  fields?: string | undefined;
};
type Dock = {
  target: HTMLDivElement | null;
  activeId: string | null;
  entries: Entry[];
  register: (entry: Entry) => void;
  remove: (id: string) => void;
  activate: (id: string) => void;
  dismiss: () => void;
  setTarget: (target: HTMLDivElement | null) => void;
};
const ApprovalDockContext = createContext<Dock | null>(null);
const activeStatuses = new Set(['pending', 'approved', 'running', 'partial']);
const statusLabels: Record<string, string> = {
  loading: 'Loading',
  pending: 'Needs approval',
  superseded: 'Replaced',
  approved: 'Approved',
  running: 'In progress',
  completed: 'Completed',
  partial: 'Partially completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  expired: 'Expired',
};

export function ApprovalDockProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const register = useCallback(
    (entry: Entry) =>
      setEntries(previous => {
        const current = previous.find(item => item.id === entry.id);
        if (
          current?.title === entry.title &&
          current.status === entry.status &&
          current.order === entry.order &&
          current.label === entry.label &&
          current.schema === entry.schema &&
          current.fields === entry.fields
        )
          return previous;
        return [...previous.filter(item => item.id !== entry.id), entry].sort(
          (a, b) => b.order - a.order || a.id.localeCompare(b.id),
        );
      }),
    [],
  );
  const remove = useCallback((id: string) => setEntries(previous => previous.filter(entry => entry.id !== id)), []);
  const [focusRequest, setFocusRequest] = useState(0);
  const activate = useCallback((id: string) => {
    setSelected(id);
    setFocusRequest(request => request + 1);
  }, []);
  // The dock is hidden until something is docked, so focus waits for the render that shows it.
  useEffect(() => {
    if (focusRequest) target?.focus({ preventScroll: true });
  }, [focusRequest, target]);
  const [lastActive, setLastActive] = useState<string | null>(null);
  const dismiss = useCallback(() => {
    setSelected(null);
    setLastActive(null);
  }, []);
  const waiting = entries.find(entry => activeStatuses.has(entry.status))?.id ?? null;
  useEffect(() => {
    if (waiting) setLastActive(waiting);
  }, [waiting]);
  // Proposals already settled when the chat opens stay inline. One that needs action, or that settled
  // while this chat was open, stays docked until hidden, so its result is still in view.
  const activeId =
    entries.find(entry => entry.id === selected)?.id ??
    waiting ??
    entries.find(entry => entry.id === lastActive)?.id ??
    null;
  const value = useMemo(
    () => ({ entries, activeId, target, register, remove, activate, dismiss, setTarget }),
    [entries, activeId, target, register, remove, activate, dismiss],
  );
  return <ApprovalDockContext value={value}>{children}</ApprovalDockContext>;
}

export function useApprovalDockEntry(entry: Entry) {
  const dock = useContext(ApprovalDockContext);
  const register = dock?.register,
    remove = dock?.remove;
  useEffect(() => {
    register?.(entry);
  }, [register, entry.id, entry.title, entry.status, entry.order, entry.label, entry.schema, entry.fields]);
  useEffect(() => () => remove?.(entry.id), [remove, entry.id]);
  return dock
    ? {
        target: dock.target,
        active: dock.activeId === entry.id,
        latest: dock.entries[0]?.id === entry.id,
        activate: () => dock.activate(entry.id),
      }
    : null;
}

/** Every proposal in this chat, newest first. */
export function useApprovalDockEntries() {
  return useContext(ApprovalDockContext)?.entries ?? [];
}

export const proposalStatusLabel = (status: string) => statusLabels[status] ?? status;

const entryName = (entry: Entry) => (entry.label ? `${entry.title} (${entry.label})` : entry.title);

export function ApprovalDock() {
  const dock = useContext(ApprovalDockContext);
  if (!dock) return null;
  // Replaced versions can't be approved; the schema canvas still lists them.
  const entries = dock.entries.filter(entry => entry.status !== 'superseded' || entry.id === dock.activeId);
  const docked = entries.find(entry => entry.id === dock.activeId);
  const settled = !!docked && !activeStatuses.has(docked.status) && docked.status !== 'loading';
  return (
    <div hidden={!docked} className="space-y-2">
      {(entries.length > 1 || settled) && (
        <div className="flex items-center gap-3">
          {entries.length > 1 && (
            <>
              <span className="shrink-0 text-xs text-muted-foreground">{entries.length} proposals</span>
              <Select
                value={dock.activeId}
                onValueChange={value => {
                  if (value) dock.activate(value);
                }}
                items={entries.map(entry => ({
                  value: entry.id,
                  label: `${entryName(entry)} · ${statusLabels[entry.status] ?? entry.status}`,
                }))}
              >
                <SelectTrigger width="full" size="sm" aria-label="Choose proposal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {entries.map(entry => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entryName(entry)} · {statusLabels[entry.status] ?? entry.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          {settled && (
            <span className="ms-auto shrink-0">
              <Button size="sm" variant="ghost" onClick={dock.dismiss}>
                Hide
              </Button>
            </span>
          )}
        </div>
      )}
      <div ref={dock.setTarget} tabIndex={-1} role="region" aria-label="Table approval" />
    </div>
  );
}
