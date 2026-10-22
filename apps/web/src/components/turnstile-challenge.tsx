import { useEffect, useRef, useState } from 'react';
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';

type ChallengeState =
  | { kind: 'loading' | 'interactive' | 'verified' }
  | { kind: 'error'; message: string; reload: boolean };

export function TurnstileChallenge({
  siteKey,
  onToken,
  action = 'sign_in',
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  action?: 'sign_in' | 'create_workspace';
}) {
  const widget = useRef<TurnstileInstance>(undefined);
  const [state, setState] = useState<ChallengeState>({ kind: 'loading' });

  useEffect(() => {
    if (state.kind !== 'loading') return;
    const timeout = window.setTimeout(() => {
      onToken(null);
      setState({ kind: 'error', message: 'Verification took too long. Please try again.', reload: !window.turnstile });
    }, 30000);
    return () => window.clearTimeout(timeout);
  }, [state.kind, onToken]);

  function fail(message: string, reload = false) {
    onToken(null);
    setState({ kind: 'error', message, reload });
  }

  function retry() {
    if (state.kind === 'error' && state.reload) {
      window.location.reload();
      return;
    }
    onToken(null);
    setState({ kind: 'loading' });
    widget.current?.reset();
  }

  return (
    <div className={state.kind === 'interactive' || state.kind === 'error' ? 'space-y-3' : undefined}>
      <Turnstile
        ref={widget}
        siteKey={siteKey}
        options={{
          action,
          appearance: 'interaction-only',
          size: 'flexible',
          responseField: false,
          retry: 'never',
          refreshExpired: 'manual',
          refreshTimeout: 'manual',
        }}
        onSuccess={token => {
          onToken(token);
          setState({ kind: 'verified' });
        }}
        onExpire={() => fail('Verification expired. Please verify again.')}
        onError={() => fail('Could not verify your browser. Please try again.')}
        onTimeout={() => fail('Verification timed out. Please try again.')}
        onUnsupported={() => fail('This browser cannot complete verification. Try another browser.', true)}
        onBeforeInteractive={() => setState({ kind: 'interactive' })}
        onAfterInteractive={() => setState(current => (current.kind === 'interactive' ? { kind: 'loading' } : current))}
        scriptOptions={{
          onError: () => fail('Could not load verification. Check your connection and reload this page.', true),
        }}
      />
      {state.kind === 'loading' && (
        <p role="status" className="sr-only">
          Verifying your browser…
        </p>
      )}
      {state.kind === 'interactive' && (
        <p role="status" className="text-sm text-muted-foreground">
          Complete the verification above to continue.
        </p>
      )}
      {state.kind === 'verified' && (
        <p role="status" className="sr-only">
          Verification complete.
        </p>
      )}
      {state.kind === 'error' && (
        <>
          <Alert variant="destructive">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
          <Button type="button" variant="outline" onClick={retry}>
            {state.reload ? 'Reload page' : 'Retry verification'}
          </Button>
        </>
      )}
    </div>
  );
}
