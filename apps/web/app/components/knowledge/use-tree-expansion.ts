import { useCallback, useState } from "react";

/**
 * Which tree branches are open, kept for the session rather than in component state.
 *
 * The sidebar remounts on every route change, so component state would collapse the whole tree the
 * moment a reader opened a Page — making the tree something you re-navigate on every hop instead of
 * something you navigate by.
 */

export interface ExpansionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "knowledge:tree-expansion";

function defaultStore(): ExpansionStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // Private-mode Safari and some embedded webviews throw on access rather than returning null.
    return null;
  }
}

function read(store: ExpansionStore | null): Record<string, boolean> {
  if (!store) return {};
  try {
    const raw = store.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function write(store: ExpansionStore | null, state: Record<string, boolean>): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(state));
  } catch {
    // A branch that will not persist is still worth expanding for this render.
  }
}

/** Forgets every remembered branch. Exported for tests and for a signed-out reset. */
export function clearTreeExpansion(store: ExpansionStore | null = defaultStore()): void {
  write(store, {});
}

/**
 * @param forceOpen the branch lies on the path to the active Page. It opens, but that is not
 * recorded — otherwise merely reading a deep Page would pin its whole ancestry open forever.
 */
export function useTreeExpansion(
  spaceId: string,
  path: string,
  opts: { forceOpen?: boolean; store?: ExpansionStore | null } = {}
): { open: boolean; toggle: () => void } {
  const store = opts.store === undefined ? defaultStore() : opts.store;
  const key = `${spaceId}\u0000${path}`;

  const [chosen, setChosen] = useState<boolean | undefined>(() => read(store)[key]);

  const toggle = useCallback(() => {
    setChosen((prev) => {
      const next = !(prev ?? opts.forceOpen ?? false);
      const state = read(store);
      state[key] = next;
      write(store, state);
      return next;
    });
  }, [store, key, opts.forceOpen]);

  return { open: chosen ?? opts.forceOpen ?? false, toggle };
}
