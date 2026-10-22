import { createContext, use, type ReactNode } from 'react';
import { Link, useBlocker, useLocation } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@tulipfarm/sprout/alert-dialog';
import type { ReadState, WriteState } from './request-state';
import { ReadFeedback, ReadError } from '@/components/read-feedback';

export function TableRead<T>({
  state,
  refresh,
  loading,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  loading?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const destination = useLocation({ select: location => location.href });
  return (
    <ReadFeedback
      state={state}
      errorTitle="Could not load tables"
      retry={
        <Button variant="outline" onClick={() => void refresh()}>
          Try again
        </Button>
      }
      loading={
        loading ?? (
          <div aria-label="Loading tables" role="status" className="space-y-4 py-6">
            <Skeleton />
            <Skeleton />
            <Skeleton />
            <span className="sr-only">Loading tables…</span>
          </div>
        )
      }
      unavailable={status => (
        <StatePanel
          kind="unavailable"
          title={status === 401 ? 'Sign in to continue' : 'Table unavailable'}
          description={
            status === 401
              ? 'Your session has expired. Sign in again to access this workspace.'
              : 'This table is missing or you no longer have access. A workspace admin can manage permissions.'
          }
        >
          <Button
            variant="outline"
            nativeButton={false}
            render={status === 401 ? <Link to="/login" search={{ redirect: destination }} /> : <Link to="/" />}
          >
            {status === 401 ? 'Sign in' : 'Back to workspaces'}
          </Button>
          <Button variant="ghost" onClick={() => void refresh()}>
            Check access again
          </Button>
        </StatePanel>
      )}
      refreshError={message => (
        <div className="space-y-2">
          <ReadError message={`${message} The last loaded data is still shown.`}>
            <Button variant="outline" onClick={() => void refresh()}>
              Retry refresh
            </Button>
          </ReadError>
        </div>
      )}
      refreshing={
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing status…
        </p>
      }
    >
      {children}
    </ReadFeedback>
  );
}

type BlockedLocation = { pathname: string; search: object };
export type KeepsEdits = (current: BlockedLocation, next: BlockedLocation) => boolean;
export const samePage: KeepsEdits = (current, next) => current.pathname === next.pathname;
// A page whose views stay mounted across URL changes declares it once for every nested edit blocker.
export const KeepsEditsContext = createContext<KeepsEdits | undefined>(undefined);

export function UnsavedChanges({
  dirty,
  allowNavigation,
  keepsEdits: own,
}: {
  dirty: boolean;
  allowNavigation?: { current: boolean };
  keepsEdits?: KeepsEdits;
}) {
  const keepsEdits = own ?? use(KeepsEditsContext);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty && !allowNavigation?.current && !keepsEdits?.(current, next),
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  return (
    <AlertDialog
      open={blocker.status === 'blocked'}
      onOpenChange={open => {
        if (!open) blocker.reset?.();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Leave these edits?</AlertDialogTitle>
        <AlertDialogDescription>
          Your input will be lost if you leave. Any submitted operation continues on the server, even if its result has
          not been confirmed here.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => blocker.reset?.()}>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => blocker.proceed?.()}>
            Leave editor
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function WriteFeedback<T>({
  state,
  retry,
  checkStatus,
}: {
  state: WriteState<T>;
  retry?: ((input: T) => void) | undefined;
  checkStatus: () => void;
}) {
  if (state.kind === 'idle' || state.kind === 'accepted') return null;
  if (state.kind === 'sending')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Submitting your operation…
      </p>
    );
  return (
    <div className="space-y-3">
      <Alert variant="destructive">
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={checkStatus}>
          Check status again
        </Button>
        {state.kind === 'uncertain' && retry && (
          <Button variant="outline" onClick={() => retry(state.input)}>
            Retry same operation
          </Button>
        )}
      </div>
    </div>
  );
}
