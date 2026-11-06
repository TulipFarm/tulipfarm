import type { Workspace } from '@tulipfarm/workspaces/contracts';
import { persistedReads } from './query/persisted-reads';
import type { SessionIdentity } from './query/scope';

const sessionKey = 'tulipfarm:last-session';

/**
 * The session this browser last confirmed. A fresh page load uses it to start workspace reads, and to
 * show persisted reads, before the session check returns; both are checked against the real session.
 */
export function lastSession(): SessionIdentity | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(sessionKey) ?? 'null');
    return typeof value === 'object' &&
      value !== null &&
      'userId' in value &&
      'sessionId' in value &&
      typeof value.userId === 'string' &&
      typeof value.sessionId === 'string' &&
      value.userId &&
      value.sessionId
      ? { userId: value.userId, sessionId: value.sessionId }
      : null;
  } catch {
    return null;
  }
}

export function rememberSession(identity: SessionIdentity) {
  const previous = lastSession();
  if (previous?.userId === identity.userId && previous.sessionId === identity.sessionId) return;
  // Another person signed in on this browser: nothing the previous one saved may be shown to them.
  if (previous && previous.userId !== identity.userId) void persistedReads.clear(previous.userId);
  try {
    window.localStorage.setItem(sessionKey, JSON.stringify(identity));
  } catch {
    /* Storage can be disabled by the browser. */
  }
}

/** Drops the remembered session and everything persisted for its user. */
export function forgetSession() {
  const previous = lastSession();
  try {
    window.localStorage.removeItem(sessionKey);
  } catch {
    /* Storage can be disabled by the browser. */
  }
  return previous ? persistedReads.clear(previous.userId) : Promise.resolve();
}

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
