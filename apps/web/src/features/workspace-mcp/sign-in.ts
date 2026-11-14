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
