import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { ReadState } from '@/features/tables/request-state';

export function ReadFeedback<T>({
  state,
  loading,
  unavailable,
  errorTitle,
  retry,
  refreshError,
  refreshing,
  thing,
  refresh,
  children,
}: {
  state: ReadState<T>;
  loading: ReactNode;
  unavailable: (status: number) => ReactNode;
  errorTitle: string;
  retry: ReactNode;
  refreshError: (message: string, refreshing: boolean) => ReactNode;
  refreshing?: ReactNode;
  /** Lowercase plural naming what loads, for the panel shown while the workspace updates. */
  thing?: string;
  refresh?: () => void;
  children: (data: T) => ReactNode;
}) {
  switch (state.kind) {
    case 'loading':
      return loading;
    case 'unavailable':
      return unavailable(state.status);
    case 'error':
      if (state.updating)
        return (
          <WorkspaceUpdatingPanel thing={thing} retrying={state.updating === 'retrying'} refresh={refresh}>
            {refresh ? null : retry}
          </WorkspaceUpdatingPanel>
        );
      return (
        <StatePanel kind="error" title={errorTitle} description={state.message}>
          {retry}
        </StatePanel>
      );
    case 'ready':
      return (
        <>
          {state.error && refreshError(state.error, state.refreshing)}
          {state.refreshing && <div className="sr-only">{refreshing}</div>}
          {children(state.data)}
        </>
      );
  }
}

export function ReadError({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <>
      <Alert variant="destructive">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
      {children}
    </>
  );
}

/** Shown instead of an error while a release updates the workspace; reads retry by themselves meanwhile. */
export function WorkspaceUpdatingPanel({
  thing,
  retrying,
  refresh,
  children,
}: {
  thing?: string | undefined;
  retrying: boolean;
  refresh?: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <StatePanel
      kind="loading"
      title="Updating your workspace"
      description={
        retrying
          ? `TulipFarm is updating your workspace. This usually takes a few minutes. ${
              thing ? `Your ${thing} will load` : 'This will load'
            } automatically when it finishes.`
          : 'TulipFarm is still updating your workspace. Try again in a few minutes.'
      }
    >
      {refresh && (
        <Button variant="outline" onClick={refresh}>
          Check again
        </Button>
      )}
      {children}
    </StatePanel>
  );
}
