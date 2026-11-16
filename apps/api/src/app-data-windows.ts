/**
 * Counts calls per key in fixed windows, in this process only. Keys are app ids and request handle digests, which
 * only a signed handle can name, so the map grows with real apps and requests; at `entries` the expired windows are
 * dropped first, then the oldest.
 */
export function createWindows({
  max,
  windowMs,
  entries = 10_000,
  now = Date.now,
}: {
  max: number;
  windowMs: number;
  entries?: number;
  now?: () => number;
}) {
  const windows = new Map<string, { count: number; endsAt: number }>();
  const current = (key: string) => {
    const window = windows.get(key);
    return window && window.endsAt > now() ? window : undefined;
  };
  return {
    /** Milliseconds until `key` may be counted again, or 0 when it is under `max`. */
    wait(key: string) {
      const window = current(key);
      return window && window.count >= max ? window.endsAt - now() : 0;
    },
    /** Counts one call for `key`. Returns 0 when it was within `max`, else the milliseconds until the window ends. */
    spend(key: string) {
      const window = current(key) ?? { count: 0, endsAt: now() + windowMs };
      window.count++;
      windows.delete(key);
      if (windows.size >= entries) for (const [stale, held] of windows) if (held.endsAt <= now()) windows.delete(stale);
      if (windows.size >= entries) windows.delete(windows.keys().next().value!);
      windows.set(key, window);
      return window.count > max ? window.endsAt - now() : 0;
    },
  };
}
