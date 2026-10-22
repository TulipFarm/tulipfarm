import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import { EnvelopeCheck } from 'reicon-react/icons/EnvelopeCheck';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { authClient, safeAuthRedirect } from '@/lib/auth';
import { AuthLayout, newPasswordError, passwordFailureMessage, passwordLength } from '@/features/auth/form';
import { useAuthOptions } from '@/features/auth/public-query';
import { AuthVerification } from '@/features/auth/verification';

function currentRedirect() {
  return safeAuthRedirect(new URLSearchParams(window.location.search).get('redirect'));
}

function BackToLogin() {
  return (
    <span className="font-medium text-foreground underline underline-offset-4">
      <Link to="/login" search={{ redirect: currentRedirect() }}>
        Back to login
      </Link>
    </span>
  );
}

export function ForgotPasswordPage() {
  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Set a new password for your TulipFarm account."
      footer={<BackToLogin />}
    >
      <ForgotPassword />
    </AuthLayout>
  );
}

function ForgotPassword() {
  const options = useAuthOptions();
  if (options.isPending)
    return (
      <p role="status" aria-busy="true" className="flex items-center gap-2">
        <Spinner aria-hidden="true" />
        Loading…
      </p>
    );
  if (options.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not load sign-in options. Refresh the page to try again.</AlertDescription>
      </Alert>
    );
  if (!options.data.emailPassword)
    return <p className="text-muted-foreground">This TulipFarm instance signs in with email links, not passwords.</p>;
  if (!options.data.passwordResetEmail)
    return (
      <div className="space-y-3 text-muted-foreground">
        <p>This TulipFarm instance does not send email. Ask your administrator for a reset link.</p>
        <p className="text-sm">
          Administrators can create one with{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-foreground">pnpm auth:reset-password you@company.com</code>
          . The link works once and expires in an hour.
        </p>
      </div>
    );
  return <ResetLinkForm />;
}

function ResetLinkForm() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const submitting = useRef(false);
  const emailError =
    submitted && !z.email().safeParse(email.trim()).success ? 'Enter a valid email address.' : undefined;

  function submit() {
    setSubmitted(true);
    if (!z.email().safeParse(email.trim()).success) {
      setError('Check the highlighted fields to continue.');
      return 'invalid';
    }
    if (submitting.current || challengeToken === null) return;
    submitting.current = true;
    void send(email.trim(), challengeToken);
  }

  async function send(address: string, token: string) {
    setPending(true);
    setError('');
    try {
      // The API builds the link to /login/reset-password itself.
      const result = await authClient.requestPasswordReset(
        { email: address },
        { headers: token ? { 'x-captcha-response': token } : {}, signal: AbortSignal.timeout(15000) },
      );
      if (result.error) setError(passwordFailureMessage(result.error, 'Could not send the reset email. Try again.'));
      else setSentTo(address);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not reach TulipFarm. Check your connection and try again.',
      );
    } finally {
      submitting.current = false;
      setPending(false);
      setChallengeToken(null);
      setChallengeAttempt(value => value + 1);
    }
  }

  if (sentTo)
    return (
      <div className="space-y-4">
        <div role="status" className="flex items-center gap-2 font-medium">
          <EnvelopeCheck size={16} />
          Check your email
        </div>
        <p className="text-muted-foreground">
          If <span className="font-medium text-foreground">{sentTo}</span> has a TulipFarm account, we sent it a link to
          reset the password. The link expires in an hour.
        </p>
      </div>
    );

  return (
    <Form onSubmit={submit} disabled={pending}>
      <div className="space-y-5">
        <Field id="email" label="Email" required error={emailError}>
          <Input
            name="email"
            type="email"
            scale="lg"
            placeholder="you@company.com"
            autoComplete="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
          />
        </Field>
        <AuthVerification key={challengeAttempt} onToken={setChallengeToken} />
        <FormFooter
          dirty={false}
          layout="stack"
          error={error || undefined}
          submit={{
            label: 'Email me a reset link',
            pendingLabel: 'Sending email…',
            state: pending
              ? { kind: 'busy' }
              : challengeToken === null
                ? { kind: 'blocked', reason: 'Complete verification to continue.' }
                : { kind: 'ready' },
          }}
        />
      </div>
    </Form>
  );
}

export function ResetPasswordPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const invalid = !token || params.has('error');
  const [done, setDone] = useState(false);
  return (
    <AuthLayout
      title={invalid ? 'This link is no longer valid' : done ? 'Password updated' : 'Choose a new password'}
      subtitle={
        invalid
          ? 'The reset link may have expired or already been used. Request a new one to continue.'
          : done
            ? 'Log in with your new password. Other devices were signed out.'
            : `Use ${passwordLength.min} to ${passwordLength.max} characters.`
      }
      footer={<BackToLogin />}
    >
      {invalid ? (
        <Button
          size="onboarding"
          nativeButton={false}
          render={<Link to="/login/forgot-password" search={{ redirect: currentRedirect() }} />}
        >
          Request a new link
        </Button>
      ) : done ? (
        <Button
          size="onboarding"
          nativeButton={false}
          render={<Link to="/login" search={{ redirect: currentRedirect() }} />}
        >
          Log in
        </Button>
      ) : (
        <NewPasswordForm token={token} onDone={() => setDone(true)} />
      )}
    </AuthLayout>
  );
}

function NewPasswordForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const passwordError = submitted ? newPasswordError(password) : undefined;
  const confirmationError = submitted && confirmation !== password ? 'The passwords do not match.' : undefined;

  function submit() {
    setSubmitted(true);
    if (newPasswordError(password) || confirmation !== password) {
      setError('Check the highlighted fields to continue.');
      return 'invalid';
    }
    if (submitting.current) return;
    submitting.current = true;
    void reset();
  }

  async function reset() {
    setPending(true);
    setError('');
    try {
      const result = await authClient.resetPassword(
        { newPassword: password, token },
        { signal: AbortSignal.timeout(15000) },
      );
      if (!result.error) onDone();
      else if (result.error.code === 'INVALID_TOKEN')
        setError('This reset link has expired or was already used. Request a new one.');
      else setError(passwordFailureMessage(result.error, 'Could not update your password. Try again.'));
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not reach TulipFarm. Check your connection and try again.',
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit} disabled={pending}>
      <div className="space-y-5">
        <Field id="new-password" label="New password" required error={passwordError}>
          <Input
            name="new-password"
            type="password"
            scale="lg"
            autoComplete="new-password"
            maxLength={passwordLength.max}
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
        </Field>
        <Field id="confirm-password" label="Confirm new password" required error={confirmationError}>
          <Input
            name="confirm-password"
            type="password"
            scale="lg"
            autoComplete="new-password"
            maxLength={passwordLength.max}
            value={confirmation}
            onChange={event => setConfirmation(event.target.value)}
          />
        </Field>
        <FormFooter
          dirty={false}
          layout="stack"
          error={error || undefined}
          submit={{
            label: 'Set new password',
            pendingLabel: 'Saving…',
            state: pending ? { kind: 'busy' } : { kind: 'ready' },
          }}
        />
      </div>
    </Form>
  );
}
