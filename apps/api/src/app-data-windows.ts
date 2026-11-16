/**
 * A map in this process whose entries expire `ttlMs` after they are set. Every entry lives equally long, so the order
 * entries were set in is the order they expire in. Setting one drops the expired entries at the front, then the oldest
 * while the map holds `entries`, so it touches only the entries it drops.
 */
export function createExpiringMap<Value>({
  ttlMs,
  entries,
  now = () => Date.now(),
}: {
  ttlMs: number;
  entries: number;
  now?: () => number;
}) {
  const held = new Map<string, { value: Value; endsAt: number }>();
  return {
    get(key: string) {
      const entry = held.get(key);
      return entry && entry.endsAt > now() ? entry.value : undefined;
    },
    set(key: string, value: Value) {
      held.delete(key);
      for (const [front, entry] of held) {
        if (held.size < entries && entry.endsAt > now()) break;
        held.delete(front);
      }
      held.set(key, { value, endsAt: now() + ttlMs });
    },
    delete(key: string) {
      held.delete(key);
    },
  };
}

/**
 * Counts calls per key in fixed windows, in this process only. Keys are app ids and request handle digests, which
 * only a signed handle can name, so the map grows with real apps and requests. A full map drops the window that ends
 * soonest.
 */
export function createWindows({
  max,
  windowMs,
  entries = 10_000,
  now = () => Date.now(),
}: {
  max: number;
  windowMs: number;
  entries?: number;
  now?: () => number;
}) {
  const windows = createExpiringMap<{ count: number; endsAt: number }>({ ttlMs: windowMs, entries, now });
  return {
    /** Milliseconds until `key` may be counted again, or 0 when it is under `max`. */
    wait(key: string) {
      const window = windows.get(key);
      return window && window.count >= max ? window.endsAt - now() : 0;
    },
    /** Counts one call for `key`. Returns 0 when it was within `max`, else the milliseconds until the window ends. */
    spend(key: string) {
      let window = windows.get(key);
      if (!window) windows.set(key, (window = { count: 0, endsAt: now() + windowMs }));
      window.count++;
      return window.count > max ? window.endsAt - now() : 0;
    },
  };
}
