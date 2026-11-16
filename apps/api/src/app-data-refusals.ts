import type { AppId } from '@tulipfarm/apps';
import type { RequestHandle, SignedRequestHandle } from '@tulipfarm/apps/store';

/**
 * Remembers, per process, which apps and request handles are refused until when, so a refused caller is answered
 * without database work. An app is held once `refusals` of its calls are refused within `windowMs`, or until its call
 * limit resets; a handle until its own limit resets. Only handles the gateway signed reach here, so each map grows
 * with real apps and requests; at `entries` the expired ones are dropped first, then the oldest.
 */
export function createRefusalBudget({
  refusals,
  windowMs = 60_000,
  entries = 10_000,
  now = Date.now,
}: {
  refusals: number;
  windowMs?: number;
  entries?: number;
  now?: () => number;
}) {
  const windows = new Map<AppId, { refused: number; endsAt: number }>();
  const apps = new Map<AppId, number>();
  const handles = new Map<RequestHandle, number>();

  function remember<K, V extends number | { endsAt: number }>(map: Map<K, V>, key: K, value: V) {
    const ends = (held: V) => (typeof held === 'number' ? held : held.endsAt);
    map.delete(key);
    if (map.size >= entries) for (const [stale, held] of map) if (ends(held) <= now()) map.delete(stale);
    if (map.size >= entries) map.delete(map.keys().next().value!);
    map.set(key, value);
  }

  return {
    /** Milliseconds before a call with `signed` may be served, or 0 when it may be served now. */
    wait({ appId, handle }: SignedRequestHandle) {
      return Math.max(0, (apps.get(appId) ?? 0) - now(), (handles.get(handle) ?? 0) - now());
    },
    holdApp(appId: AppId, ms: number) {
      remember(apps, appId, now() + ms);
    },
    holdHandle(handle: RequestHandle, ms: number) {
      remember(handles, handle, now() + ms);
    },
    /** Counts one refused call against `appId`, holding the app until the window ends once it reaches `refusals`. */
    refuse(appId: AppId) {
      const current = windows.get(appId);
      const window = current && current.endsAt > now() ? current : { refused: 0, endsAt: now() + windowMs };
      window.refused++;
      remember(windows, appId, window);
      if (window.refused >= refusals) remember(apps, appId, window.endsAt);
    },
  };
}
