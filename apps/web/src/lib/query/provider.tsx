import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createFeatureClient, type FeatureClient } from './client';
import type { FeatureScope, SessionIdentity, WorkspaceScope } from './scope';

type ScopeContext = { runtime: FeatureClient; scope: FeatureScope; current: () => boolean };
type AdmissionEvent = { kind: 'admitted' | 'empty' | 'denied' };
const Context = createContext<ScopeContext | null>(null);

export function SessionQueryProvider({
  identity,
  onAuthorityLost,
  children,
}: {
  identity: SessionIdentity | null;
  onAuthorityLost?: ((scope: FeatureScope) => void) | undefined;
  children: ReactNode;
}) {
  return identity ? (
    <SessionQueries
      key={JSON.stringify([identity.userId, identity.sessionId])}
      identity={identity}
      onAuthorityLost={onAuthorityLost}
    >
      {children}
    </SessionQueries>
  ) : (
    children
  );
}

function SessionQueries({
  identity,
  onAuthorityLost,
  children,
}: {
  identity: SessionIdentity;
  onAuthorityLost: ((scope: FeatureScope) => void) | undefined;
  children: ReactNode;
}) {
  const authorityLost = useRef(onAuthorityLost);
  authorityLost.current = onAuthorityLost;
  const [runtime] = useState(() =>
    createFeatureClient(identity, {
      authorityLost: scope => authorityLost.current?.(scope),
    }),
  );
  const value = useMemo<ScopeContext>(() => {
    const scope: FeatureScope = { kind: 'account', userId: identity.userId };
    return { runtime, scope, current: () => runtime.isCurrent(scope) };
  }, [runtime, identity.userId]);
  useLayoutEffect(() => {
    runtime.start();
    return () => {
      runtime.stop();
      // StrictMode's setup/cleanup probe must not publish a real logout.
      queueMicrotask(() => runtime.retire());
    };
  }, [runtime, value, identity.userId]);
  return (
    <QueryClientProvider client={runtime.client}>
      <Context value={value}>{children}</Context>
    </QueryClientProvider>
  );
}

export function WorkspaceQueryProvider({
  scope,
  admitted,
  subscribe,
  children,
}: {
  scope: WorkspaceScope;
  admitted: () => boolean;
  subscribe: (listener: (event?: AdmissionEvent) => void) => () => void;
  children: ReactNode;
}) {
  const parent = useFeatureContext();
  const { runtime } = parent;
  const value = useMemo<ScopeContext>(
    () => ({ runtime, scope, current: () => runtime.isCurrent(scope) && admitted() }),
    [runtime, scope.userId, scope.workspaceId, scope.membershipId, admitted],
  );
  useLayoutEffect(() => {
    if (admitted()) runtime.admit(scope);
    let observing = admitted();
    const check = (event?: AdmissionEvent) => {
      if (admitted()) return;
      if (observing && event?.kind === 'denied') runtime.revoke(scope, true);
      else runtime.suspend(scope);
      observing = false;
    };
    check();
    const unsubscribe = subscribe(check);
    return () => {
      unsubscribe();
      check();
    };
  }, [runtime, scope.userId, scope.workspaceId, scope.membershipId, admitted, subscribe]);
  return <Context value={value}>{children}</Context>;
}

export function useFeatureContext() {
  const value = useContext(Context);
  if (!value) throw new Error('Feature reads require an admitted SessionQueryProvider.');
  return value;
}

export function useFeatureScope(): FeatureScope {
  return useFeatureContext().scope;
}
