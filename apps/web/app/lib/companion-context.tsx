import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { dismissQuest, listQuests, type Quest } from "~/lib/onboarding";

/* The Companion's quest ladder: poll every ~60s (low-urgency, unlike Approvals) so a quest
   answered elsewhere (chat, Settings) clears itself out within a minute without a hard refresh. */

const POLL_INTERVAL_MS = 60_000;

type CompanionContextValue = {
  quests: Quest[];
  loading: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
};

const CompanionContext = createContext<CompanionContextValue | null>(null);

export function CompanionProvider({ children }: { children: ReactNode }) {
  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const items = await listQuests();
      if (mounted.current) setQuests(items);
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
    setQuests((current) => current.filter((q) => q.id !== id));
    await dismissQuest(id).catch(() => {});
  }, []);

  const value: CompanionContextValue = { quests, loading, open, setOpen, refresh, dismiss };
  return <CompanionContext.Provider value={value}>{children}</CompanionContext.Provider>;
}

const INERT: CompanionContextValue = {
  quests: [],
  loading: false,
  open: false,
  setOpen: () => {},
  refresh: async () => {},
  dismiss: async () => {},
};

export function useCompanion(): CompanionContextValue {
  return useContext(CompanionContext) ?? INERT;
}
