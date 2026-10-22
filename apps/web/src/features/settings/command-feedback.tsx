import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Link } from '@tanstack/react-router';
import type { CommandState } from './use-settings-command';

export function CommandFeedback<C, R>({
  state,
  check,
  retry,
  writable,
}: {
  state: CommandState<C, R>;
  check: () => void;
  retry?: (command: C) => void;
  writable: boolean;
}) {
  if (state.kind === 'checking') return <p role="status">Checking whether your change was saved…</p>;
  if (state.kind === 'rejected')
    return (
      <Alert variant="destructive">
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  if (state.kind !== 'uncertain') return null;
  return (
    <div className="space-y-3">
      <Alert>
        <AlertDescription>
          {state.message} Recovery information is retained for this account in this browser tab until it closes.
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={check}>
          Check command status
        </Button>
        {state.checked && retry && (
          <Button variant="outline" disabled={!writable} onClick={() => retry(state.command)}>
            Retry same request
          </Button>
        )}
        <Button variant="ghost" nativeButton={false} render={<Link to="/account/workspace-recovery" />}>
          Recover workspace changes
        </Button>
      </div>
    </div>
  );
}
