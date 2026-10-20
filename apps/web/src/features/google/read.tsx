import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Spinner } from '@tulipfarm/sprout/spinner';

export function GoogleReadFeedback({
  busy,
  error,
  hasData,
  title,
}: {
  busy: boolean;
  error: string | null;
  hasData: boolean;
  title: string;
}) {
  return (
    <>
      {busy && (
        <p role="status" className={hasData ? 'sr-only' : 'flex items-center gap-2'}>
          <Spinner aria-hidden="true" />
          {hasData ? `Refreshing ${title}…` : `Loading ${title}…`}
        </p>
      )}
      {error &&
        (hasData ? (
          <Alert variant="destructive">
            <AlertDescription>
              {error} Last loaded information remains visible. Changes are blocked until a successful status check.
            </AlertDescription>
          </Alert>
        ) : (
          <StatePanel kind="error" title={`Could not load ${title}`} description={error}>
            <span>Use the status check for this section to retry.</span>
          </StatePanel>
        ))}
      {error && (
        <Button variant="link" nativeButton={false} render={<Link to="/login" />}>
          Sign in again
        </Button>
      )}
    </>
  );
}
