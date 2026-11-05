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

function workspaceIdsKey(userId: string) {
  return `tulipfarm:workspace-ids:${userId}`;
}

function readWorkspaceIds(userId: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(workspaceIdsKey(userId)) ?? '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(entry => typeof entry[1] === 'string'))
      : {};
  } catch {
    return {};
  }
}

function writeWorkspaceIds(userId: string, ids: Record<string, string>) {
  try {
    if (Object.keys(ids).length) window.localStorage.setItem(workspaceIdsKey(userId), JSON.stringify(ids));
    else window.localStorage.removeItem(workspaceIdsKey(userId));
  } catch {
    /* Storage can be disabled by the browser. */
  }
}

/**
 * The workspace id a slug resolved to on this person's last admission. It only lets reads that
 * need the id start before the workspace read returns; admission still checks the id matches.
 */
export function workspaceIdHint(userId: string, slug: string): string | null {
  return readWorkspaceIds(userId)[slug] ?? null;
}

export function rememberWorkspaceId(userId: string, slug: string, workspaceId: string) {
  const ids = readWorkspaceIds(userId);
  if (ids[slug] === workspaceId) return;
  delete ids[slug];
  // Keep the most recent few; the oldest entry is the first key.
  const kept = Object.entries(ids).slice(-19);
  writeWorkspaceIds(userId, { ...Object.fromEntries(kept), [slug]: workspaceId });
}

export function forgetWorkspaceId(userId: string, slug: string) {
  const ids = readWorkspaceIds(userId);
  if (!(slug in ids)) return;
  delete ids[slug];
  writeWorkspaceIds(userId, ids);
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
