import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { TurnstileChallenge } from '@/components/turnstile-challenge';
import { useEffect } from 'react';
import { useAuthOptions } from './public-query';

/** The token when the API has no Turnstile site key: nothing to solve, nothing to send. */
export const noChallenge = '';

export function AuthVerification({
  onToken,
  action = 'sign_in',
}: {
  onToken: (token: string | null) => void;
  action?: 'sign_in' | 'create_workspace';
}) {
  const options = useAuthOptions();
  const unchallenged = options.data?.turnstileSiteKey === null;
  useEffect(() => {
    if (unchallenged) onToken(noChallenge);
  }, [unchallenged, onToken]);
  if (unchallenged) return null;
  if (options.data?.turnstileSiteKey)
    return <TurnstileChallenge siteKey={options.data.turnstileSiteKey} onToken={onToken} action={action} />;
  if (options.isPending || options.isFetching)
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading verification…
      </p>
    );
  return (
    <div className="space-y-3">
      <Alert variant="destructive">
        <AlertDescription>Could not load verification. Please try again.</AlertDescription>
      </Alert>
      <Button type="button" variant="outline" onClick={() => void options.refetch()}>
        Retry verification
      </Button>
    </div>
  );
}
