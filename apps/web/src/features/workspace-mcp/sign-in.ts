import { useSyncExternalStore } from 'react';

const returnKey = 'tulipfarm:mcp-sign-in-return';
const connectedKey = 'tulipfarm:mcp-connected';

/** Sends this tab to the provider's sign-in, remembering the page to come back to afterwards. */
export function startMcpSignIn(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  if (url.protocol !== 'https:') throw new Error('MCP sign-in must use HTTPS');
  sessionStorage.setItem(returnKey, `${window.location.pathname}${window.location.search}${window.location.hash}`);
  window.location.assign(url.href);
}

/** The same-origin page that started sign-in, read once. */
export function takeMcpSignInReturn() {
  const path = sessionStorage.getItem(returnKey);
  sessionStorage.removeItem(returnKey);
  return path?.startsWith('/') && !path.startsWith('//') && !path.startsWith('/mcp/callback') ? path : null;
}

export function markMcpConnected(integrationId: string) {
  sessionStorage.setItem(connectedKey, integrationId);
}

/** The integration that just finished sign-in, read once so the success message shows a single time. */
export function takeMcpConnected() {
  const id = sessionStorage.getItem(connectedKey);
  sessionStorage.removeItem(connectedKey);
  return id;
}

// Paste sign-ins live outside components, so the page that opens one keeps it when the connection's view replaces it.
const pastes = new Map<string, string>();
const pasteListeners = new Set<() => void>();
const notifyPastes = () => pasteListeners.forEach(listener => listener());

/** Remembers the provider sign-in for a server whose sign-in ends on an address the member pastes back. */
export function startMcpPasteSignIn(integrationId: string, authorizationUrl: string) {
  if (new URL(authorizationUrl).protocol !== 'https:') throw new Error('MCP sign-in must use HTTPS');
  pastes.set(integrationId, authorizationUrl);
  notifyPastes();
}

export function endMcpPasteSignIn(integrationId: string) {
  if (pastes.delete(integrationId)) notifyPastes();
}

/** The sign-in link waiting for a pasted address for this connection, if any. */
export function useMcpPasteSignIn(integrationId: string | undefined) {
  return useSyncExternalStore(
    listener => {
      pasteListeners.add(listener);
      return () => pasteListeners.delete(listener);
    },
    () => (integrationId ? (pastes.get(integrationId) ?? null) : null),
  );
}
