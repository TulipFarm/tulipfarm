import { QueryCache, QueryClient, hashKey, type QueryKey } from '@tanstack/react-query';
import { modelCatalogSchema } from '@tulipfarm/config/model-catalog';
import { createCatalogPersistence } from './catalog-persistence';
import { queryNotifications, type QueryNotice } from './notifications';
import { createPolling } from './polling';
import { deniedStatus, freshness, retryDelay, retryRead } from './policy';
import { featureKey, scopeKey, type FeatureScope, type SessionIdentity, type WorkspaceScope } from './scope';

export type FeatureChange = { kind?: 'change' | 'conceal'; keys: readonly QueryKey[] };

export function createFeatureClient(
  identity: SessionIdentity,
  environment: {
    visible?: () => boolean;
    online?: () => boolean;
    authorityLost?: (scope: FeatureScope) => void;
  } = {},
) {
  const visible =
    environment.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const online =
    environment.online ??
    (() => typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' || navigator.onLine);
  let active = true;
  let generation = 0;
  let authorityRevision = 0;
  const authorityListeners = new Set<() => void>();
  const authorityChanged = () => {
    authorityRevision++;
    for (const listener of authorityListeners) listener();
  };
  const denied = new Set<string>();
  const revisions = new Map<string, number>();
  const memberships = new Map<string, WorkspaceScope>();
  const catalogs = new Map<string, { scope: WorkspaceScope; current: () => boolean; ready: Promise<void> }>();
  const account: FeatureScope = { kind: 'account', userId: identity.userId };
  const catalog = createCatalogPersistence();
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError(error, query) {
        const status = deniedStatus(error);
        if (status === undefined) return;
        // Keep the error observable, but remove the protected result from the cache itself.
        query.setState({ data: undefined, dataUpdatedAt: 0 });
        const entry = catalogs.get(query.queryHash);
        if (entry) {
          catalogs.delete(query.queryHash);
          void catalog.clear(entry.scope.userId, entry.scope.workspaceId);
        }
        if (status === 401) revoke(account, true);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: freshness.ordinary,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: (count, error) => active && visible() && online() && retryRead(count, error),
        retryDelay,
        networkMode: 'always',
      },
      mutations: { retry: false, networkMode: 'always' },
    },
  });
  const polling = createPolling(client, visible, online);
  let notifications: ReturnType<typeof queryNotifications> | undefined;
  const isCurrent = (scope: FeatureScope) =>
    active &&
    scope.userId === identity.userId &&
    !denied.has(hashKey(scopeKey(account))) &&
    !denied.has(hashKey(scopeKey(scope)));
  const pending = new Map<string, QueryKey>();
  let changeTask: Promise<void> | undefined;

  function applyChange(scope: FeatureScope, input: FeatureChange) {
    if (!isCurrent(scope)) return Promise.resolve();
    const keys = input.keys.map(key => featureKey(scope, key));
    if (input.kind === 'conceal') {
      const queries = new Set(keys.flatMap(queryKey => client.getQueryCache().findAll({ queryKey })));
      for (const query of queries) {
        void client.cancelQueries({ queryKey: query.queryKey, exact: true });
        query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending', fetchStatus: 'idle' });
        polling.revalidate(query.queryKey);
      }
    }
    return invalidate(keys);
  }

  function invalidate(keys: readonly QueryKey[]) {
    for (const key of keys) pending.set(hashKey(key), key);
    changeTask ??= Promise.resolve().then(async () => {
      const batch = [...pending.values()];
      pending.clear();
      // Coalesce only until dispatch; later changes must not wait for this batch's network reads.
      changeTask = undefined;
      if (!active) return;
      const hashes = new Set(
        batch.flatMap(key =>
          client
            .getQueryCache()
            .findAll({ queryKey: key })
            .map(query => query.queryHash),
        ),
      );
      const predicate = (query: { queryHash: string }) => hashes.has(query.queryHash);
      // Cancel even an initial request, where invalidateQueries alone would reuse the old fetch.
      await client.cancelQueries({ predicate });
      await client.invalidateQueries({ predicate, refetchType: 'none' });
      if (active && visible() && online()) await client.refetchQueries({ predicate, type: 'active' });
    });
    return changeTask;
  }

  function revoke(scope: FeatureScope, broadcast = false) {
    if (scope.userId !== identity.userId) return;
    const hash = hashKey(scopeKey(scope));
    if (denied.has(hash)) return;
    denied.add(hash);
    revisions.set(hash, (revisions.get(hash) ?? 0) + 1);
    const key = scopeKey(scope);
    void client.cancelQueries({ queryKey: key });
    for (const query of client.getQueryCache().findAll({ queryKey: key })) {
      query.setState({
        data: undefined,
        dataUpdatedAt: 0,
        error: Object.assign(new Error('Access changed'), { status: 403 }),
        status: 'error',
        fetchStatus: 'idle',
      });
    }
    void catalog.clear(scope.userId, scope.kind === 'workspace' ? scope.workspaceId : undefined);
    authorityChanged();
    if (broadcast) notifications?.send(scope, scope.kind === 'account' ? 'logout' : 'denied');
    environment.authorityLost?.(scope);
  }

  const receive = (event: QueryNotice) => {
    if (event.scope.userId !== identity.userId) return;
    if (event.kind === 'logout') {
      if (event.sessionId === identity.sessionId) revoke(account);
      return;
    }
    if (!isCurrent(event.scope)) return;
    if (event.kind === 'denied') {
      revoke(event.scope);
      return;
    }
    void applyChange(event.scope, { kind: event.kind, keys: event.keys });
  };
  const visibilityChanged = () => {
    polling.pause();
    if (visible()) polling.sync();
  };
  const reconnected = () => {
    if (!active || !online()) return;
    if (visible()) void client.refetchQueries({ type: 'active', stale: true }, { cancelRefetch: false });
    else void client.invalidateQueries({ stale: true, refetchType: 'none' });
    polling.sync();
  };
  let detach: (() => void) | undefined;

  return {
    client,
    polling,
    catalog,
    identity,
    isCurrent,
    revoke,
    receive,
    visibilityChanged,
    reconnected,
    applyChange,
    suspend(scope: FeatureScope) {
      const key = scopeKey(scope),
        hash = hashKey(key);
      revisions.set(hash, (revisions.get(hash) ?? 0) + 1);
      void client.cancelQueries({ queryKey: key });
    },
    subscribeAuthority(listener: () => void) {
      authorityListeners.add(listener);
      return () => {
        authorityListeners.delete(listener);
      };
    },
    authoritySnapshot: () => authorityRevision,
    fence(scope: FeatureScope, admission: () => boolean = () => true) {
      const revision = generation;
      const hash = hashKey(scopeKey(scope));
      const scopeRevision = revisions.get(hash);
      const admitted = isCurrent(scope) && admission();
      return () =>
        admitted && revision === generation && scopeRevision === revisions.get(hash) && isCurrent(scope) && admission();
    },
    admit(scope: WorkspaceScope) {
      const previous = memberships.get(scope.workspaceId);
      if (previous && previous.membershipId !== scope.membershipId) revoke(previous, true);
      memberships.set(scope.workspaceId, scope);
      if (denied.delete(hashKey(scopeKey(scope)))) authorityChanged();
    },
    prepareCatalog(scope: WorkspaceScope, key: QueryKey, admitted: () => boolean): Promise<void> {
      const fullKey = featureKey(scope, key);
      const hash = hashKey(fullKey);
      const previous = catalogs.get(hash);
      if (previous?.current()) return previous.ready;
      const revision = generation;
      const scopeHash = hashKey(scopeKey(scope));
      const scopeRevision = revisions.get(scopeHash);
      const authority = () =>
        revision === generation && scopeRevision === revisions.get(scopeHash) && isCurrent(scope) && admitted();
      const current = () => authority() && catalogs.get(hash)?.current === current;
      const ready = catalog.restore(scope, current).then(snapshot => {
        if (!snapshot || !current()) return;
        const existing = client.getQueryState(fullKey);
        if (
          !existing ||
          (!existing.error && existing.fetchStatus === 'idle' && existing.dataUpdatedAt < snapshot.updatedAt)
        ) {
          client.setQueryData(fullKey, snapshot.data, { updatedAt: snapshot.updatedAt });
          // Show the stored catalog at once, but re-read it once per page load: a feature flag or operator
          // change since it was stored must not wait for the catalog's freshness window.
          void client.invalidateQueries({ queryKey: fullKey, exact: true, refetchType: 'none' });
        }
      });
      catalogs.set(hash, { scope, current, ready });
      return ready;
    },
    change(scope: FeatureScope, input: FeatureChange) {
      if (!isCurrent(scope)) return Promise.resolve();
      notifications?.send(scope, input.kind ?? 'change', input.keys);
      return applyChange(scope, input);
    },
    start() {
      if (detach) return;
      active = true;
      const unsubscribe = client.getQueryCache().subscribe(event => {
        if (event.type === 'removed') polling.remove(event.query.queryKey);
        if (event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
          polling.settled(event.query.queryKey);
        if (event.type === 'updated' && event.action.type === 'success') {
          const entry = catalogs.get(event.query.queryHash);
          const parsed = modelCatalogSchema.safeParse(event.query.state.data);
          if (entry?.current() && parsed.success)
            void catalog.save(entry.scope, parsed.data, event.query.state.dataUpdatedAt, entry.current);
        }
        polling.sync();
      });
      notifications = queryNotifications(receive, identity.sessionId);
      if (typeof window !== 'undefined') {
        window.addEventListener('online', reconnected);
        window.addEventListener('offline', visibilityChanged);
        document.addEventListener('visibilitychange', visibilityChanged);
      }
      detach = () => {
        unsubscribe();
        notifications?.close();
        notifications = undefined;
        if (typeof window !== 'undefined') {
          window.removeEventListener('online', reconnected);
          window.removeEventListener('offline', visibilityChanged);
          document.removeEventListener('visibilitychange', visibilityChanged);
        }
      };
    },
    stop() {
      active = false;
      generation++;
      pending.clear();
      detach?.();
      detach = undefined;
      polling.clear();
      catalogs.clear();
      void client.cancelQueries();
      client.clear();
    },
    logout() {
      revoke(account, true);
    },
    retire() {
      if (active) return;
      const channel = queryNotifications(() => {}, identity.sessionId);
      channel.send(account, 'logout');
      channel.close();
      void catalog.clear(identity.userId);
    },
  };
}

export type FeatureClient = ReturnType<typeof createFeatureClient>;
