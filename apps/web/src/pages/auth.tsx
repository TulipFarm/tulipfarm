import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'reicon-react/icons/ArrowRight';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Button } from '@tulipfarm/sprout/button';
import { Form } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { apiOrigin, authClient, authCallbackURLs, magicLinkDestination, safeAuthRedirect } from '@/lib/auth';
import { accountExistsMessage, AuthForm, AuthLayout, SignInAvailable } from '@/features/auth/form';
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
  const [step, setStep] = useState<'workspace' | 'account'>('workspace');
  const workspace = useOnboardingFields(pending);
  const { name, slug } = workspace.details;
  const stepChanged = useRef(false);
  useEffect(() => {
    if (stepChanged.current) document.getElementById('auth-title')?.focus();
    stepChanged.current = true;
  }, [step]);
  const returnError = new URLSearchParams(window.location.search).get('error');
  const footer = (
    <>
      Have an account? Use the same email or Google account to create this workspace, or{' '}
      <span className="font-medium text-foreground underline underline-offset-4">
        <Link to="/login" search={{ redirect: '/' }}>
          log in
        </Link>
      </span>
      .
    </>
  );
  if (step === 'workspace')
    return (
      <AuthLayout
        step="Step 1 of 2"
        title="Create your workspace"
        subtitle="Next, you’ll create your account."
        footer={footer}
      >
        <SignInAvailable>
          <Form label="Workspace details" onSubmit={() => (workspace.validate() ? setStep('account') : 'invalid')}>
            <div className="space-y-6">
              {returnError !== null && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {returnError === 'ACCOUNT_EXISTS'
                      ? accountExistsMessage
                      : 'Sign-in did not finish. Please try again.'}
                  </AlertDescription>
                </Alert>
              )}
              {workspace.fields}
              <div className="grid">
                <Button type="submit" size="lg">
                  Continue
                  <ArrowRight aria-hidden="true" />
                </Button>
              </div>
            </div>
          </Form>
        </SignInAvailable>
      </AuthLayout>
    );
  return (
    <AuthLayout step="Step 2 of 2" title="Create your account" subtitle={`Sign in to claim ${name}.`} footer={footer}>
      <div className="space-y-6">
        <div className="flex items-center gap-3 rounded-xl border bg-card p-3">
          <EntityAvatar seed={slug} name={name} size="md" shape="square" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{name}</p>
            <p className="truncate text-sm text-muted-foreground">
              {window.location.host}/{slug}
            </p>
          </div>
          <Button
            variant="ghost"
            disabled={pending}
            aria-label="Edit workspace details"
            onClick={() => setStep('workspace')}
          >
            Edit
          </Button>
        </div>
        <AuthForm
          workspace={workspace}
          withName
          providersFirst
          submitLabel="Create workspace with email"
          passwordLabel="Create workspace"
          linkLabel="Email me a sign-in link instead"
          googleLabel="Continue with Google"
          pending={pending}
          onPendingChange={setPending}
        />
      </div>
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
        <div className="grid">
          <Button size="lg" nativeButton={false} render={<Link to="/login" search={{ redirect: destination }} />}>
            Request a new link
          </Button>
        </div>
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
          <div className="grid">
            <Button variant="outline" size="lg" onClick={signOut}>
              Try again
            </Button>
          </div>
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
        <div className="grid">
          <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
            {pending && <Spinner />}Continue
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
