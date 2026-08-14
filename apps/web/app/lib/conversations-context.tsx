import { useLocation, useNavigate } from "@remix-run/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ConversationSummary, listConversations } from "~/lib/conversations";

/* Route changes refetch; shallow chat id overrides survive index `history.replaceState`. */

type ConversationsContextValue = {
  conversations: ConversationSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** The conversation currently being viewed (`/chat/:id`), or null on the new-chat surface. */
  activeChatId: string | null;
  /** Shallow-set the active chat after a `replaceState` URL update (router location is unchanged). */
  setActiveChatId: (id: string) => void;
  /** Title of the on-screen conversation — the top bar names the chat, so it needs this. */
  activeChatTitle: string | null;
  /** Publish a title the list can't supply: the `/chat/:id` loader knows chats older than the list. */
  setActiveChatTitle: (id: string, title: string | null) => void;
  /** Remount key for the index chat surface — bumped by `startNewChat` to force a fresh transcript. */
  newChatNonce: number;
  /** Start a fresh chat from anywhere: clear active state, force a remount, and route to "/". */
  startNewChat: () => void;
};

const ConversationsContext = createContext<ConversationsContextValue | null>(null);

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Shallow override of the active chat id, set after a replaceState (router location stays "/").
  const [shallowId, setShallowId] = useState<string | null>(null);
  // Title published by the open chat's loader, kept with its id so it self-invalidates on navigation
  // (no reset effect to race with the route's own publish).
  const [loadedTitle, setLoadedTitle] = useState<{ id: string; title: string | null } | null>(null);
  // Guards against overlapping fetches; tracks mount so a late resolve skips writes after unmount.
  const inFlight = useRef(false);
  // A refresh requested while a fetch is in flight is coalesced into one trailing re-fetch — so the
  // turn-finish refresh (which picks up the async title) is never dropped just because the new-chat
  // refresh from `onMeta` is still running.
  const pending = useRef(false);
  const mounted = useRef(true);
  // Bumped by startNewChat to remount the index chat surface (so "+ new chat" always clears, even on a
  // shallow-routed chat where the router location is still "/").
  const [newChatNonce, setNewChatNonce] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.pathname;

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        pending.current = false;
        try {
          const items = await listConversations();
          if (mounted.current) {
            setConversations(items);
            setError(null);
          }
        } catch (err) {
          // Keep the last-known list on a transient failure (don't flash empty).
          if (mounted.current) {
            setError(err instanceof Error ? err.message : "failed to load conversations");
          }
        }
      } while (pending.current && mounted.current);
    } finally {
      if (mounted.current) setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Refetch on mount and whenever the route changes. `pathname` is the intentional trigger (opening a
  // chat / navigating refreshes the list) even though the effect body does not read it directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is a deliberate refetch trigger
  useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  // Any real router navigation (the location object changes even when the path is unchanged, e.g.
  // "+ new chat" → "/") supersedes a shallow override, so it can never go stale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: location is a deliberate reset trigger
  useEffect(() => {
    setShallowId(null);
  }, [location]);

  const setActiveChatId = useCallback((id: string) => setShallowId(id), []);
  const setActiveChatTitle = useCallback(
    (id: string, title: string | null) => setLoadedTitle({ id, title }),
    []
  );
  const startNewChat = useCallback(() => {
    setShallowId(null);
    setNewChatNonce((n) => n + 1);
    navigate("/");
  }, [navigate]);
  // A real /chat/:id route wins; otherwise fall back to the shallow override from a replaceState.
  const routeMatch = pathname.match(/^\/chat\/([^/]+)$/);
  const activeChatId = routeMatch ? decodeURIComponent(routeMatch[1]) : shallowId;
  // The list is the fresher source (it picks up renames and async-generated titles); the loader's
  // title only fills the gap before the list resolves, and for chats older than the list's window.
  const activeChatTitle = activeChatId
    ? (conversations.find((c) => c.id === activeChatId)?.title ??
      (loadedTitle?.id === activeChatId ? loadedTitle.title : null))
    : null;

  const value: ConversationsContextValue = {
    conversations,
    loading,
    error,
    refresh,
    activeChatId,
    setActiveChatId,
    activeChatTitle,
    setActiveChatTitle,
    newChatNonce,
    startNewChat,
  };
  return <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>;
}

// Inert fallback when no provider is mounted — lets the sidebar (and its isolated tests) render.
const INERT: ConversationsContextValue = {
  conversations: [],
  loading: false,
  error: null,
  refresh: async () => {},
  activeChatId: null,
  setActiveChatId: () => {},
  activeChatTitle: null,
  setActiveChatTitle: () => {},
  newChatNonce: 0,
  startNewChat: () => {},
};

export function useConversations(): ConversationsContextValue {
  return useContext(ConversationsContext) ?? INERT;
}
