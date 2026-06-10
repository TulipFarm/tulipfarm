import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type PendingApproval, listPendingApprovals } from "~/lib/approvals";

/*
 * Single source of truth for app-wide pending approvals. Mounted once in the `_app` shell, it polls
 * GET /api/v1/chat/approvals every ~4s; the sidebar badge and the Approvals page both read this one
 * context (`count = approvals.length`), and decide handlers call `refresh()` to reconcile after a
 * decision. Ephemeral, single-instance V1 — no global SSE channel, no durable store.
 */

const POLL_INTERVAL_MS = 4000;

type ApprovalsContextValue = {
  approvals: PendingApproval[];
  count: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const ApprovalsContext = createContext<ApprovalsContextValue | null>(null);

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
        setApprovals(items);
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

  const value: ApprovalsContextValue = {
    approvals,
    count: approvals.length,
    loading,
    error,
    refresh,
  };
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
