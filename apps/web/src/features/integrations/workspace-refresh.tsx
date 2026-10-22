import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { workspaceRoute } from '@/router';

export function WorkspaceRefreshNotice() {
  const { workspaceStale } = workspaceRoute.useRouteContext();
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  if (!workspaceStale) return null;
  return (
    <section aria-label="Workspace access check" className="space-y-3">
      <Alert variant="destructive">
        <AlertDescription>
          Could not refresh workspace access. Your last loaded information and review are still here. Integration
          controls are paused until access is confirmed.
        </AlertDescription>
      </Alert>
      <Button
        variant="outline"
        disabled={retrying}
        aria-busy={retrying}
        onClick={async () => {
          setRetrying(true);
          try {
            await router.invalidate({ sync: true });
          } finally {
            setRetrying(false);
          }
        }}
      >
        {retrying ? 'Checking workspace access…' : 'Check workspace access again'}
      </Button>
    </section>
  );
}
