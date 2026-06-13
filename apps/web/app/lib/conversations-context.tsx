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

/*
 * App-wide source of truth for the "Recent chats" sidebar list. Mounted once in the `_app` shell. It
 * fetches GET /api/v1/conversations on mount and on every route change (so opening a new chat or
 * navigating refreshes the list). The chat surface additionally calls `refresh()` when a brand-new
 * conversation id arrives and again on each turn's finish, so a freshly created chat appears
 * immediately and its async-generated title fills in. No polling — chats change on user action, not
 * out of band. Mirrors ApprovalsProvider's inert-fallback shape so the sidebar renders in isolation.
 *
 * It also tracks `activeChatId` — the conversation currently on screen — so the sidebar highlights the
 * right entry. This is derived from the router location for real navigations, plus a shallow override
 * (`setActiveChatId`) that survives the `history.replaceState` the index route uses to put a freshly
 * created chat's id in the URL without remounting the live stream. Any real navigation clears the
 * override, so it never goes stale.
 */

type ConversationsContextValue = {
  conversations: ConversationSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** The conversation currently being viewed (`/chat/:id`), or null on the new-chat surface. */
  activeChatId: string | null;
  /** Shallow-set the active chat after a `replaceState` URL update (router location is unchanged). */
  setActiveChatId: (id: string) => void;
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
  const startNewChat = useCallback(() => {
    setShallowId(null);
    setNewChatNonce((n) => n + 1);
    navigate("/");
  }, [navigate]);
  // A real /chat/:id route wins; otherwise fall back to the shallow override from a replaceState.
  const routeMatch = pathname.match(/^\/chat\/([^/]+)$/);
  const activeChatId = routeMatch ? decodeURIComponent(routeMatch[1]) : shallowId;

  const value: ConversationsContextValue = {
    conversations,
    loading,
    error,
    refresh,
    activeChatId,
    setActiveChatId,
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
  newChatNonce: 0,
  startNewChat: () => {},
};

export function useConversations(): ConversationsContextValue {
  return useContext(ConversationsContext) ?? INERT;
}
