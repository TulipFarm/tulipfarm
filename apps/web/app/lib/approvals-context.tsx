import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listPendingApprovals, type PendingApproval } from "~/lib/approvals";

/* Single V1 approval source: poll every ~4s; decisions call `refresh()` to reconcile. */

const POLL_INTERVAL_MS = 4000;

type ApprovalsContextValue = {
  approvals: PendingApproval[];
  count: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const ApprovalsContext = createContext<ApprovalsContextValue | null>(null);

function sameApprovals(a: PendingApproval[], b: PendingApproval[]): boolean {
  return (
    a.length === b.length && a.every((item, i) => JSON.stringify(item) === JSON.stringify(b[i]))
  );
}

export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against overlapping polls (a slow request still outstanding when the next tick fires).
  const inFlight = useRef(false);
  // Tracks whether the provider is still mounted, so a poll that resolves after unmount (e.g. the
  // user navigated away) skips its state writes instead of touching a dead component.
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const items = await listPendingApprovals();
      if (mounted.current) {
        // The poll returns a fresh array every 4s. Writing it unconditionally would give every
        // consumer a new reference and re-render the whole app on a tick that changed nothing.
        setApprovals((prev) => (sameApprovals(prev, items) ? prev : items));
        setError(null);
      }
    } catch (err) {
      // Keep the last-known list on a transient failure (don't flash empty); retry next tick.
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "failed to load approvals");
      }
    } finally {
      if (mounted.current) setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  const value: ApprovalsContextValue = useMemo(
    () => ({ approvals, count: approvals.length, loading, error, refresh }),
    [approvals, loading, error, refresh]
  );
  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}

// Inert fallback when no provider is mounted — lets the sidebar (and its isolated tests) render
// without the polling provider rather than throwing.
const INERT: ApprovalsContextValue = {
  approvals: [],
  count: 0,
  loading: false,
  error: null,
  refresh: async () => {},
};

export function useApprovals(): ApprovalsContextValue {
  return useContext(ApprovalsContext) ?? INERT;
}
