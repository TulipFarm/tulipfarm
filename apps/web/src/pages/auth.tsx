import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { apiOrigin, authClient, authCallbackURLs, magicLinkDestination, safeAuthRedirect } from '@/lib/auth';
import { accountExistsMessage, AuthForm, AuthLayout } from '@/features/auth/form';
import { clearDraftFiles } from '@/features/chat/draft-files';
import { useOnboardingFields } from '@/features/auth/onboarding-fields';

export function RegisterPage() {
  const [pending, setPending] = useState(false);
  const redirect = safeAuthRedirect(new URLSearchParams(window.location.search).get('redirect'));
  if (redirect === '/' || redirect === '/create-workspace') return <WorkspaceSignupPage />;
  return (
    <AuthLayout
      title="Create your account"
      subtitle="Put agents to work on your business in minutes."
      footer={
        <>
          Already have an account?{' '}
          <span className="font-medium text-foreground underline underline-offset-4">
            <Link to="/login" search={{ redirect }}>
              Log in
            </Link>
          </span>
        </>
      }
    >
      <AuthForm
        withName
        submitLabel="Email me a sign-up link"
        passwordLabel="Create account"
        googleLabel="Sign up with Google"
        pending={pending}
        onPendingChange={setPending}
      />
    </AuthLayout>
  );
}

export function WorkspaceSignupPage() {
  const [pending, setPending] = useState(false);
  const workspace = useOnboardingFields(pending);
  return (
    <AuthLayout
      compact
      title="Create your workspace"
      subtitle="Name your workspace, then sign in to make it yours."
      footer={
        <>
          Have an account? Use the same email or Google account to create this workspace, or{' '}
          <span className="font-medium text-foreground underline underline-offset-4">
            <Link to="/login" search={{ redirect: '/' }}>
              log in
            </Link>
          </span>
          .
        </>
      }
    >
      <AuthForm
        workspace={workspace}
        withName
        submitLabel="Create workspace with email"
        passwordLabel="Create workspace"
        googleLabel="Continue with Google"
        pending={pending}
        onPendingChange={setPending}
      />
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const invalid = !token || params.has('error');
  const accountExists = params.get('error') === 'ACCOUNT_EXISTS';
  const verifyingToken = useRef<string | null>(null);

  const destination = magicLinkDestination(params.get('callbackURL'), window.location.origin);

  useEffect(() => {
    if (!token || invalid || verifyingToken.current === token) return;
    verifyingToken.current = token;
    const url = new URL('/v1/auth/magic-link/verify', apiOrigin);
    url.searchParams.set('token', token);
    const callbacks = authCallbackURLs(destination, window.location.origin);
    url.searchParams.set('callbackURL', callbacks.callbackURL);
    url.searchParams.set('newUserCallbackURL', callbacks.newUserCallbackURL);
    const errorURL = new URL('/verify-email', window.location.origin);
    errorURL.searchParams.set('callbackURL', callbacks.callbackURL);
    url.searchParams.set('errorCallbackURL', errorURL.href);
    window.location.replace(url.href);
  }, [token, invalid, destination]);

  return (
    <AuthLayout
      title={
        accountExists
          ? 'An account already exists'
          : invalid
            ? 'This link is no longer valid'
            : 'Signing in to TulipFarm'
      }
      subtitle={
        accountExists
          ? accountExistsMessage
          : invalid
            ? 'The link may have expired or already been used. Request a new one to continue.'
            : 'We are verifying your email link. You will continue automatically.'
      }
      footer={
        <Link to="/login" search={{ redirect: destination }}>
          Back to login
        </Link>
      }
    >
      {invalid ? (
        <Button size="onboarding" nativeButton={false} render={<Link to="/login" search={{ redirect: destination }} />}>
          Request a new link
        </Button>
      ) : (
        <p role="status" aria-busy="true" className="flex items-center gap-2">
          <Spinner aria-hidden="true" />
          Signing you in…
        </p>
      )}
    </AuthLayout>
  );
}

export function LogoutPage() {
  const destination = safeAuthRedirect(new URLSearchParams(window.location.search).get('redirect'));
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const signOut = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const result = await authClient.signOut();
      if (result.error) setError('Could not log out. Please try again.');
      else {
        clearDraftFiles();
        window.location.replace(`/login?redirect=${encodeURIComponent(destination)}`);
      }
    } catch {
      setError('Could not log out. Check your connection and try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [destination]);
  useEffect(() => {
    void signOut();
  }, [signOut]);
  return (
    <AuthLayout
      title={error ? 'Could not log out' : 'Logging out of TulipFarm'}
      subtitle="Logging out of your account on this device."
      footer={<Link to={destination}>Back to TulipFarm</Link>}
    >
      {error ? (
        <>
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="onboarding" onClick={signOut}>
            Try again
          </Button>
        </>
      ) : (
        <p role="status" aria-busy={pending} className="flex items-center gap-2">
          <Spinner />
          Logging out…
        </p>
      )}
    </AuthLayout>
  );
}

export function CompleteProfilePage() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    if (!name || name.length > 80) {
      setError('Enter a name between 1 and 80 characters.');
      return;
    }
    setPending(true);
    setError('');
    try {
      const result = await authClient.updateUser({ name });
      if (result.error) setError('Could not save your name. Please try again.');
      else window.location.replace(safeAuthRedirect(new URLSearchParams(window.location.search).get('redirect')));
    } catch {
      setError('Could not save your name. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <AuthLayout
      title="What should we call you?"
      subtitle="Add your name to finish setting up your account."
      footer={
        <Link
          to="/logout"
          search={{ redirect: safeAuthRedirect(new URLSearchParams(window.location.search).get('redirect')) }}
        >
          Log out
        </Link>
      }
    >
      <form className="space-y-5" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            id="profile-name"
            name="name"
            scale="lg"
            autoComplete="name"
            placeholder="Ada Lovelace"
            maxLength={80}
            required
            disabled={pending}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'profile-error' : undefined}
          />
          {error && (
            <p id="profile-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" size="onboarding" disabled={pending} aria-busy={pending}>
          {pending && <Spinner />}Continue
        </Button>
      </form>
    </AuthLayout>
  );
}
