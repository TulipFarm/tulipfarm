import { useEffect, useSyncExternalStore } from 'react';

type SessionLayer = typeof import('@/session-layer');

let loaded: SessionLayer | null = null;
let loading: Promise<SessionLayer> | null = null;
const listeners = new Set<() => void>();

/**
 * The signed-in layer: session query providers and workspace admission. Signed-out pages never
 * load it, so sign-in starts without that code.
 */
export function loadSessionLayer() {
  loading ??= import('@/session-layer').then(
    module => {
      loaded = module;
      for (const listener of listeners) listener();
      return module;
    },
    error => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The loaded layer, starting the load once a session needs it. */
export function useSessionLayer(needed: boolean) {
  const layer = useSyncExternalStore(subscribe, () => loaded);
  useEffect(() => {
    if (needed && !layer) void loadSessionLayer().catch(() => {});
  }, [needed, layer]);
  return layer;
}
