const reloadedAtKey = 'tulipfarm:asset-reload-at';
// One reload fetches the current index.html and its chunk graph. The window stops a
// reload loop when the current deployment itself cannot serve a chunk.
const reloadWindowMs = 60_000;
const assetLoadErrors = new WeakSet<object>();

export function trackAssetLoadErrors() {
  window.addEventListener('vite:preloadError', event => {
    const { payload } = event as Event & { payload?: unknown };
    if (typeof payload === 'object' && payload !== null) assetLoadErrors.add(payload);
  });
}

export function isAssetLoadError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && assetLoadErrors.has(error);
}

export function reloadOnceForAssetError() {
  if (!navigator.onLine) return;
  try {
    const now = Date.now();
    if (Math.abs(now - Number(sessionStorage.getItem(reloadedAtKey))) < reloadWindowMs) return;
    sessionStorage.setItem(reloadedAtKey, String(now));
  } catch {
    return;
  }
  window.location.reload();
}
