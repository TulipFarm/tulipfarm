import { useLocation } from "@remix-run/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { dismissTask, listTasks, type Task } from "~/lib/tasks";

/* The Companion's Task queue. The poll is a slow backstop, not the primary path: a Task usually
   closes within seconds of the action that satisfied it — connecting a provider, finishing setup —
   so polling alone would spend up to a minute telling the user to do something they just did.
   Navigating and returning to the tab refetch instead, which is when they are actually looking. */

const POLL_INTERVAL_MS = 60_000;

type CompanionContextValue = {
  tasks: Task[];
  loading: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
};

const CompanionContext = createContext<CompanionContextValue | null>(null);

export function CompanionProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const lastPath = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const items = await listTasks();
      if (mounted.current) setTasks(items);
    } catch {
      // Keep the last-known list on a transient failure; retry next tick.
    } finally {
      if (mounted.current) setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    // A hidden tab renders no Companion, so ticking on it only spends request budget and battery.
    // Returning refreshes at once rather than waiting out a tick, so the list is never stale at the
    // moment it is looked at. `start` is guarded because `focus` and `visibilitychange` both fire.
    const onWake = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      void refresh();
      start();
    };
    if (document.visibilityState !== "hidden") start();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      mounted.current = false;
      stop();
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [refresh]);

  // Settings pages are where a Task's gap actually gets closed, so arriving somewhere new is the
  // moment the list is most likely stale. The mount effect above already fetched for the first
  // pathname, so only a genuine change refetches.
  useEffect(() => {
    const previous = lastPath.current;
    lastPath.current = pathname;
    if (previous !== null && previous !== pathname) void refresh();
  }, [pathname, refresh]);

  const dismiss = useCallback(async (id: string) => {
    setTasks((current) => current.filter((t) => t.id !== id));
    await dismissTask(id).catch(() => {});
  }, []);

  const value: CompanionContextValue = { tasks, loading, open, setOpen, refresh, dismiss };
  return <CompanionContext.Provider value={value}>{children}</CompanionContext.Provider>;
}

const INERT: CompanionContextValue = {
  tasks: [],
  loading: false,
  open: false,
  setOpen: () => {},
  refresh: async () => {},
  dismiss: async () => {},
};

export function useCompanion(): CompanionContextValue {
  return useContext(CompanionContext) ?? INERT;
}
