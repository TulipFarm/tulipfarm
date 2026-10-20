/**
 * Calls `refreshIfStale` when the person returns to a visible window. A single return can
 * fire both `focus` and `visibilitychange`, and DevTools toggles focus repeatedly, so the
 * callback must itself skip data that is still fresh.
 */
export function onWindowReturn(refreshIfStale: () => void): () => void {
  const returned = () => {
    if (document.visibilityState === 'visible') refreshIfStale();
  };
  window.addEventListener('focus', returned);
  document.addEventListener('visibilitychange', returned);
  return () => {
    window.removeEventListener('focus', returned);
    document.removeEventListener('visibilitychange', returned);
  };
}
