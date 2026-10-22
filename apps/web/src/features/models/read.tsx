import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { ReadState } from '@/features/tables/request-state';

export function ModelRead<T>({
  state,
  refresh,
  label,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  const destination = useLocation({ select: location => location.href });
  return (
    <ReadFeedback
      state={state}
      errorTitle={`Could not load ${label}`}
      retry={
        <Button type="button" variant="outline" onClick={() => void refresh()}>
          Reload {label}
        </Button>
      }
      loading={
        <section role="status" aria-label={`Loading ${label}`} className="space-y-3">
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading {label}…</span>
        </section>
      }
      unavailable={status => (
        <StatePanel
          kind="unavailable"
          title={`${label} unavailable`}
          description={
            status === 401
              ? 'Your session has expired. Sign in again to access this workspace.'
              : status === 403
                ? `You no longer have access to ${label}. A workspace admin can manage permissions.`
                : `We could not find ${label}, or you no longer have access. A workspace admin can manage permissions.`
          }
        >
          <Button
            variant="outline"
            nativeButton={false}
            render={status === 401 ? <Link to="/login" search={{ redirect: destination }} /> : <Link to="/" />}
          >
            {status === 401 ? 'Sign in' : 'Back to workspaces'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => void refresh()}>
            Reload {label}
          </Button>
        </StatePanel>
      )}
      refreshError={(message, refreshing) => (
        <div className="space-y-3">
          <ReadError message={message}>
            <Button type="button" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
              Reload {label}
            </Button>
          </ReadError>
        </div>
      )}
      refreshing={<p role="status">Refreshing {label}…</p>}
    >
      {children}
    </ReadFeedback>
  );
}
