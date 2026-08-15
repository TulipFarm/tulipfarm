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

/* The Companion's Task queue: poll every ~60s (low-urgency, unlike Approvals) so a Task closed
   elsewhere (chat, Settings, the reconciler) clears itself out within a minute without a hard
   refresh. */

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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);

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
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

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
