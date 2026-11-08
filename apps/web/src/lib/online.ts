import { useSyncExternalStore } from 'react';

/** True only when the browser knows it has no network; an online browser can still fail to reach the API. */
export function browserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function onConnectionChange(changed: () => void): () => void {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

export function onReconnect(reconnected: () => void): () => void {
  window.addEventListener('online', reconnected);
  return () => window.removeEventListener('online', reconnected);
}

export function useOffline() {
  return useSyncExternalStore(onConnectionChange, browserOffline, () => false);
}
