import { lazy, Suspense } from 'react';
import { workspaceRoute } from '@/router';

// The chat code is most of the first download; the workspace sidebar should not wait for it.
const PrivateConversations = lazy(() =>
  import('@/features/chat/private-conversations').then(module => ({ default: module.PrivateConversations })),
);
const ResultCardsMock = import.meta.env.DEV ? lazy(() => import('@/features/chat/result-cards-mock')) : null;

export function WorkspaceHomePage() {
  const { workspace, user, sessionId } = workspaceRoute.useRouteContext();
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
  return (
    <Suspense
      fallback={
        <p role="status" className="sr-only">
          Loading chat…
        </p>
      }
    >
      <PrivateConversations key={`${sessionId}:${user.id}:${workspace.id}`} workspaceId={workspace.id} />
    </Suspense>
  );
}
