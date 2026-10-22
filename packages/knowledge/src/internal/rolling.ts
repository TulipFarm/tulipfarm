import type { Clock } from '@tulipfarm/memory-core/ports/runtime';

const day = 86_400_000;
export const rollingWindowDays = 90;
const date = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Automatic sources store `window: 'rolling-90d'`; every read uses a window that ends at the current clock. */
export function effectiveSelection<T>(selection: T, now: number): T {
  if (!selection || typeof selection !== 'object' || (selection as { window?: unknown }).window !== 'rolling-90d')
    return selection;
  const value = { ...selection, after: date(now - rollingWindowDays * day) } as T & { before?: string };
  if ('before' in (selection as object)) value.before = date(now + day);
  return value;
}

/**
 * Returns the automatic source IDs whose owner cannot use the feature now. Engines exclude them before applying
 * their dispatch limit, so held work never starves manual sources. Manual sources are never held.
 */
export type KnowledgeSourceGate = (workspaceId: string) => Promise<string[]>;
export type EngineClock = { now?: () => number; clock?: Clock; gate?: KnowledgeSourceGate };
