import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import type { ReadState } from '@/features/tables/request-state';
import type { useConversationCommand } from './conversation-state';

export function ConversationRead<T>({
  state,
  refresh,
  quiet = false,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  quiet?: boolean;
  children: (data: T) => ReactNode;
}) {
  return (
    <ReadFeedback
      state={state}
      errorTitle="Could not load chats"
      retry={
        <Button variant="outline" onClick={() => void refresh()}>
          Retry loading chats
        </Button>
      }
      loading={
        <div role="status" aria-label="Loading chats" className="space-y-4 py-4">
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading chats…</span>
        </div>
      }
      unavailable={() => null}
      refreshError={message =>
        quiet ? null : (
          <div className="space-y-2">
            <ReadError message={`${message} Previously loaded content is still shown.`}>
              <Button variant="outline" onClick={() => void refresh()}>
                Retry refresh
              </Button>
            </ReadError>
          </div>
        )
      }
    >
      {children}
    </ReadFeedback>
  );
}

// The timeline already shows the result of these commands.
const quietCommands = new Set(['send', 'retry', 'cancel', 'resume-maintenance']);

export function CommandFeedback({
  write,
  refresh,
  refreshed,
  review,
}: {
  write: ReturnType<typeof useConversationCommand>;
  refresh: () => void;
  refreshed: boolean;
  review?: () => void;
}) {
  const state = write.state;
  if (state.kind === 'idle') return null;
  if (state.kind === 'sending')
    return quietCommands.has(state.command.kind) ? null : <p role="status">Saving your change…</p>;
  if (state.kind === 'accepted')
    return quietCommands.has(state.operation) ? null : (
      <p role="status" className="text-sm text-muted-foreground">
        Change saved.
      </p>
    );
  return (
    <div className="space-y-2">
      <Alert variant="destructive">
        <AlertDescription>
          {state.kind === 'uncertain'
            ? 'We could not confirm whether this was saved. Your exact submission is kept in this tab. Retry the same operation to confirm it without duplicating it.'
            : state.message}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        {state.kind === 'uncertain' ? (
          <Button variant="outline" onClick={() => void write.submit(state.command)}>
            Retry same operation
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={refresh}>
              Refresh before editing
            </Button>
            {refreshed && (
              <Button
                variant="outline"
                onClick={() => {
                  review?.();
                  write.reset();
                }}
              >
                Review retained input
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
