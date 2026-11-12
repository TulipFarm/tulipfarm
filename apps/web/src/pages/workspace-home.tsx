import { lazy, Suspense, useEffect, useState } from 'react';
import { workspaceRoute } from '@/router';

type Chat = typeof import('@/features/chat/private-conversations');

// The chat code is most of the first download; the workspace sidebar should not wait for it.
// It loads through state, not React.lazy: React holds content that resolves after a Suspense
// fallback for 300 ms, which delayed the composer on every cached load.
let chat: Chat | undefined;
let loading: Promise<Chat> | undefined;
const loadChat = () => (loading ??= import('@/features/chat/private-conversations').then(module => (chat = module)));
const ResultCardsMock = import.meta.env.DEV ? lazy(() => import('@/features/chat/result-cards-mock')) : null;

export function WorkspaceHomePage() {
  const { workspace, user, sessionId } = workspaceRoute.useRouteContext();
  const [loaded, setLoaded] = useState(chat);
  const [failure, setFailure] = useState<unknown>();
  useEffect(() => {
    if (loaded) return;
    let stopped = false;
    loadChat().then(
      module => !stopped && setLoaded(module),
      (error: unknown) => {
        loading = undefined;
        if (!stopped) setFailure(() => error);
      },
    );
    return () => {
      stopped = true;
    };
  }, [loaded]);
  if (failure) throw failure;
  if (
    ResultCardsMock &&
    workspace.slug === 'bud-mock' &&
    new URLSearchParams(window.location.search).get('start') === 'result-cards'
  ) {
    return (
      <Suspense fallback={<p role="status">Loading result cards...</p>}>
        <ResultCardsMock />
      </Suspense>
    );
  }
  if (!loaded)
    return (
      <p role="status" className="sr-only">
        Loading chat…
      </p>
    );
  return <loaded.PrivateConversations key={`${sessionId}:${user.id}:${workspace.id}`} workspaceId={workspace.id} />;
}
