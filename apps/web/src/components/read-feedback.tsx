import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
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
  children,
}: {
  state: ReadState<T>;
  loading: ReactNode;
  unavailable: (status: number) => ReactNode;
  errorTitle: string;
  retry: ReactNode;
  refreshError: (message: string, refreshing: boolean) => ReactNode;
  refreshing?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  switch (state.kind) {
    case 'loading':
      return loading;
    case 'unavailable':
      return unavailable(state.status);
    case 'error':
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
