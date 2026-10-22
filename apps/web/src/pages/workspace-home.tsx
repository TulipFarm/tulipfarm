import { lazy, Suspense } from 'react';
import { workspaceRoute } from '@/router';
import { PrivateConversations } from '@/features/chat/private-conversations';

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
  return <PrivateConversations key={`${sessionId}:${user.id}:${workspace.id}`} workspaceId={workspace.id} />;
}
