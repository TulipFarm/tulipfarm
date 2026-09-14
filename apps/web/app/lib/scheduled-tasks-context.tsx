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
import { listOperationalRuns } from "~/lib/operations";
import { listRoutines } from "~/lib/routines";
import { type ScheduledTaskRow, scheduledTaskRows } from "~/lib/routines/facts";

/* Powers the sidebar's pinned "Scheduled" section: poll every 30s, well under the 4s approvals
 * cadence since a schedule slipping by half a minute costs nothing a reader would notice. */

const POLL_INTERVAL_MS = 30000;
const RUN_PAGE_SIZE = 100;
const MAX_TASKS = 5;

type ScheduledTasksContextValue = {
  tasks: ScheduledTaskRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const ScheduledTasksContext = createContext<ScheduledTasksContextValue | null>(null);

function sameTasks(a: ScheduledTaskRow[], b: ScheduledTaskRow[]): boolean {
  return (
    a.length === b.length && a.every((item, i) => JSON.stringify(item) === JSON.stringify(b[i]))
  );
}

export function ScheduledTasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<ScheduledTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [routines, runs] = await Promise.all([
        listRoutines(),
        // Health is a nicety; a sidebar that goes blank because the Run feed is down is a worse
        // answer than one that renders without it.
        listOperationalRuns(undefined, RUN_PAGE_SIZE).catch(() => ({
          items: [],
          nextCursor: null,
        })),
      ]);
      if (mounted.current) {
        const next = scheduledTaskRows(routines, runs.items, MAX_TASKS);
        setTasks((prev) => (sameTasks(prev, next) ? prev : next));
        setError(null);
      }
    } catch (err) {
      // Keep the last-known list on a transient failure (don't flash empty); retry next tick.
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "failed to load scheduled tasks");
      }
    } finally {
      if (mounted.current) setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const value: ScheduledTasksContextValue = useMemo(
    () => ({ tasks, loading, error, refresh }),
    [tasks, loading, error, refresh]
  );
  return <ScheduledTasksContext.Provider value={value}>{children}</ScheduledTasksContext.Provider>;
}

// Inert fallback when no provider is mounted — lets the sidebar (and its isolated tests) render
// without the polling provider rather than throwing.
const INERT: ScheduledTasksContextValue = {
  tasks: [],
  loading: false,
  error: null,
  refresh: async () => {},
};

export function useScheduledTasks(): ScheduledTasksContextValue {
  return useContext(ScheduledTasksContext) ?? INERT;
}
