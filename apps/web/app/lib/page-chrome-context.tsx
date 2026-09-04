import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

type PageChrome = {
  /** The name the current page wants in the header bar, or `null` to fall back to the route's. */
  readonly title: string | null;
  readonly setTitle: (title: string | null) => void;
  /** Where a page portals its header actions. `null` until the header has mounted. */
  readonly actionSlot: HTMLElement | null;
  readonly setActionSlot: (el: HTMLElement | null) => void;
};

/**
 * The channel a page uses to fill in the one header bar the app has.
 *
 * The bar is a sibling of the route outlet, not an ancestor, so a page cannot render into it
 * directly. Giving each page its own bar instead was the obvious fix and the wrong one — it
 * produced two stacked bars, and the lower one scrolled a title out of reach.
 *
 * The two halves travel differently on purpose:
 *
 * - The **title** is a string, so it goes through state. Strings compare by value, which is what
 *   makes the effect that publishes it settle after one pass.
 * - The **actions** are a `ReactNode`, so they go through a portal. A node is a fresh object on
 *   every render and never compares equal, so putting one in state re-renders forever. A portal
 *   sidesteps the comparison entirely: the nodes stay children of the page for state, context and
 *   events, and only their rendered output lands in the header.
 */
const PageChromeContext = createContext<PageChrome | null>(null);

export function PageChromeProvider({ children }: { readonly children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);

  const value = useMemo(
    () => ({ title, setTitle, actionSlot, setActionSlot }),
    [title, actionSlot]
  );

  return <PageChromeContext.Provider value={value}>{children}</PageChromeContext.Provider>;
}

function usePageChrome(): PageChrome | null {
  return useContext(PageChromeContext);
}

/** Read by the header. Falls back to the route's own name when no page has claimed the bar. */
export function usePageChromeTitle(): string | null {
  return usePageChrome()?.title ?? null;
}

/** Read by the header, to mount the element pages portal their actions into. */
export function useSetActionSlot(): (el: HTMLElement | null) => void {
  const chrome = usePageChrome();
  return chrome?.setActionSlot ?? noop;
}

/** Read by a page, to portal its actions into the header. */
export function useActionSlot(): HTMLElement | null {
  return usePageChrome()?.actionSlot ?? null;
}

/**
 * Publish a page's name to the header for as long as that page is mounted.
 *
 * Cleared on unmount so the next route falls back to its own name rather than inheriting the
 * previous page's — which is what made this a hook rather than a bare setter call.
 */
export function usePublishPageTitle(title: string): void {
  const chrome = usePageChrome();
  const setTitle = chrome?.setTitle;

  useEffect(() => {
    if (!setTitle) return;
    setTitle(title);
    return () => setTitle(null);
  }, [title, setTitle]);
}

function noop() {}
