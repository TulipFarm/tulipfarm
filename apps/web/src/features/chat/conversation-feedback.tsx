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
const quietCommands = new Set(['send', 'layout-action', 'retry', 'cancel', 'resume-maintenance']);

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
  if (state.kind === 'checking') return <p role="status">Checking whether your message was sent…</p>;
  if (state.kind === 'sending' && state.waiting)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {state.command.kind === 'send'
          ? 'TulipFarm is updating your workspace. Your message will send automatically when the update finishes.'
          : 'TulipFarm is updating your workspace. Your change will save automatically when the update finishes.'}
      </p>
    );
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
            ? state.unsent
              ? "Your message hasn't been sent. Try again."
              : uncertainCopy(state.command.kind === 'send', state.offline, state.updating)
            : state.message}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        {state.kind === 'uncertain' ? (
          state.command.kind === 'send' && !state.offline && !state.updating && !state.unsent ? (
            <Button variant="outline" onClick={() => void write.recover()}>
              Check message status
            </Button>
          ) : (
            <Button variant="outline" onClick={() => void write.submit(state.command)}>
              Try again
            </Button>
          )
        ) : (
          <>
            <Button variant="outline" onClick={state.command?.kind === 'send' ? () => void write.recover() : refresh}>
              Refresh before editing
            </Button>
            {refreshed && state.command?.kind !== 'send' && (
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

// Replaying the same command never applies it twice, so trying again is always safe.
function uncertainCopy(message: boolean, offline: boolean, updating = false) {
  if (updating)
    return message
      ? "Your workspace is still updating, so your message hasn't been sent. Try again in a few minutes. Trying again won't send it twice."
      : "Your workspace is still updating, so your change hasn't been saved. Try again in a few minutes. Trying again won't repeat the change.";
  if (offline)
    return message
      ? "You're offline, so your message hasn't been sent. It's kept here and will send when you're back online."
      : "You're offline, so your change hasn't been saved. Try again when you're back online.";
  return message
    ? "We couldn't confirm your message was sent. Check your connection, then try again. Trying again won't send it twice."
    : "We couldn't confirm your change was saved. Check your connection, then try again. Trying again won't repeat the change.";
}
