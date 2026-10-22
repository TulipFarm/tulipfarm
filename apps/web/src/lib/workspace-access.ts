import type { getWorkspace, listWorkspaces } from './workspaces';

type Authority = { userId: string; sessionId: string; slug: string };
type Read = {
  pathname: string;
  workspace: Awaited<ReturnType<typeof getWorkspace>>;
  workspaces: Awaited<ReturnType<typeof listWorkspaces>>;
};
type Snapshot =
  | { kind: 'empty'; revision: number }
  | { kind: 'admitted'; revision: number; read: Read; authority: Authority }
  | { kind: 'denied'; revision: number; status: number };

export function createWorkspaceAccess() {
  let authority: string | null = null;
  let snapshot: Snapshot = { kind: 'empty', revision: 0 };
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };
  const clear = () => {
    authority = null;
    publish({ kind: 'empty', revision: snapshot.revision + 1 });
  };
  const keyOf = (value: Authority) => JSON.stringify([value.userId, value.sessionId, value.slug]);
  const observe = (value: Authority) => {
    const key = keyOf(value);
    const revision = snapshot.revision;
    return (status: number) => {
      if (authority === key && snapshot.revision === revision)
        publish({ kind: 'denied', revision: revision + 1, status });
    };
  };
  return {
    clear,
    observe,
    subscribe: (listener: (snapshot: Snapshot) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    begin: (next: Authority) => {
      const key = keyOf(next);
      if (authority !== key) {
        clear();
        authority = key;
      }
      const revision = snapshot.revision;
      const current = () => authority === key && snapshot.revision === revision;
      return {
        revision,
        deny: observe(next),
        admit: (read: Read) => {
          if (!current()) throw new Error('Workspace access changed during this read. Try again.');
          publish({ kind: 'admitted', revision, read: structuredClone(read), authority: { ...next } });
        },
        retained: (pathname: string) =>
          current() && snapshot.kind === 'admitted' && snapshot.read.pathname === pathname
            ? structuredClone(snapshot.read)
            : null,
      };
    },
  };
}
