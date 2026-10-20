import type { Workspace } from '@tulipfarm/workspaces/contracts';

function storageKey(userId: string) {
  return `tulipfarm:last-workspace:${userId}`;
}

export function rememberWorkspace(userId: string, workspaceId: string) {
  try {
    window.localStorage.setItem(storageKey(userId), workspaceId);
  } catch {
    /* Storage can be disabled by the browser. */
  }
}

export function forgetWorkspace(userId: string) {
  try {
    window.localStorage.removeItem(storageKey(userId));
  } catch {
    /* Storage can be disabled by the browser. */
  }
}

export function workspaceDestination(userId: string, workspaces: Workspace[]) {
  let lastWorkspaceId: string | null = null;
  try {
    lastWorkspaceId = window.localStorage.getItem(storageKey(userId));
  } catch {
    /* Memberships still provide a default. */
  }
  const workspace = workspaces.find(item => item.id === lastWorkspaceId) ?? workspaces[0];
  if (lastWorkspaceId && !workspaces.some(item => item.id === lastWorkspaceId)) forgetWorkspace(userId);
  return workspace ? `/${workspace.slug}` : '/create-workspace';
}
