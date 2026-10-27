import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { NoticeBanner } from '@tulipfarm/sprout/notice-banner';
import { onWindowReturn } from '@/lib/window-return';

const retryInterval = 30_000;

/** Shown while the workspace route serves its last loaded read because TulipFarm could not be reached. */
export function ReconnectBanner({ showMessage }: { showMessage: boolean }) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const retry = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void router.invalidate();
    };
    const timer = setInterval(retry, retryInterval);
    const stopReturn = onWindowReturn(retry);
    window.addEventListener('online', retry);
    return () => {
      clearInterval(timer);
      stopReturn();
      window.removeEventListener('online', retry);
    };
  }, [router]);
  if (!showMessage) return null;
  return (
    <NoticeBanner
      aria-label="Connection"
      actions={
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
          {retrying ? 'Reconnecting…' : 'Reconnect now'}
        </Button>
      }
    >
      <p role="status">
        <span className="font-medium text-warning">Reconnecting to TulipFarm.</span> You&apos;re seeing your last loaded
        workspace. We&apos;ll keep trying in the background.
      </p>
    </NoticeBanner>
  );
}
