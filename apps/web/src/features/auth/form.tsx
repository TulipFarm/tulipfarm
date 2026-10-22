import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import { CheckCircle } from 'reicon-react/icons/CheckCircle';
import { EnvelopeCheck } from 'reicon-react/icons/EnvelopeCheck';
import { AgentAvatar } from '@tulipfarm/sprout/agent-avatar';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Field, FieldSeparator } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import {
  GradientBanner,
  GradientBannerBadge,
  GradientBannerPanel,
  GradientBannerProgress,
} from '@tulipfarm/sprout/gradient-banner';
import { Input } from '@tulipfarm/sprout/input';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { apiOrigin, authClient, authCallbackURLs, safeAuthRedirect } from '@/lib/auth';
import { AuthVerification } from '@/features/auth/verification';
import { PublicAuthQueryProvider, useAuthOptions } from '@/features/auth/public-query';
import type { useOnboardingFields } from './onboarding-fields';

export const accountExistsMessage =
  'An account already exists for this address. Sign in with the address you used before.';

// Better Auth's defaults: passwords of 8 to 128 characters.
export const passwordLength = { min: 8, max: 128 };

export function newPasswordError(password: string) {
  if (password.length < passwordLength.min) return `Use at least ${passwordLength.min} characters.`;
  if (password.length > passwordLength.max) return `Use at most ${passwordLength.max} characters.`;
  return undefined;
}

export function passwordFailureMessage(error: { code?: string | undefined; status: number }, fallback: string) {
  if (error.code === 'CHALLENGE_FAILED') return 'Verification failed. Complete the new challenge and try again.';
  if (error.code === 'ACCOUNT_EXISTS') return accountExistsMessage;
  if (error.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  if (error.code === 'INVALID_EMAIL_OR_PASSWORD') return 'The email or password is incorrect.';
  if (error.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')
    return 'An account already exists for this address. Log in, or reset your password to add one.';
  if (error.code === 'PASSWORD_TOO_SHORT' || error.code === 'PASSWORD_TOO_LONG')
    return `Use ${passwordLength.min} to ${passwordLength.max} characters.`;
  return fallback;
}

function GoogleLogo() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="var(--color-brand-google-blue)"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
      />
      <path
        fill="var(--color-brand-google-green)"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="var(--color-brand-google-yellow)"
        d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a11.99 11.99 0 0 0 0 10.76l3.98-3.09Z"
      />
      <path
        fill="var(--color-brand-google-red)"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.46 11.46 0 0 0 12 0 11.99 11.99 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}

const agents = [
  {
    id: 'agent-marketing',
    name: 'Marketing agent',
    task: 'Spring launch email',
    steps: [
      'Reading last campaign results',
      'Writing three subject lines',
      'Checking brand voice',
      'Proposing a Tuesday morning send',
    ],
    result: 'Email ready for your approval',
  },
  {
    id: 'leads_agent',
    name: 'Leads agent',
    task: 'Qualify new leads',
    steps: [
      'Enriching company data',
      'Scoring against ideal customer profile',
      'Drafting follow-ups for the best fits',
      'Proposing lead row updates',
    ],
    result: 'Lead shortlist ready for review',
  },
  {
    id: 'agent_engineering',
    name: 'Engineering agent',
    task: 'Fix checkout timeout',
    steps: [
      'Reproducing the timeout',
      'Tracing a slow database query',
      'Drafting a missing index',
      'Preparing the change for review',
    ],
    result: 'Fix ready for review',
  },
];

const ticksPerStep = 4;
const holdTicks = 6;

function useTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setTick(value => value + 1), 700);
    return () => window.clearInterval(id);
  }, []);
  return tick;
}

function AgentActivity() {
  const tick = useTick();
  const work = ticksPerStep * 4;
  const run = work + holdTicks;
  const active = Math.floor(tick / run) % agents.length;
  const agent = agents[active]!;
  const elapsed = tick % run;
  const done = elapsed >= work;
  const current = Math.min(Math.floor(elapsed / ticksPerStep), agent.steps.length);

  return (
    <GradientBanner variant="iris" size="lg">
      <div className="grid w-full max-w-md gap-6">
        <div className="flex justify-center">
          <GradientBannerPanel tone="dark">
            <GradientBannerBadge>Example</GradientBannerBadge>
            <span>How agents work in TulipFarm</span>
          </GradientBannerPanel>
        </div>
        <div key={agent.id} className="animate-in duration-700 fade-in zoom-in-95 slide-in-from-bottom-6">
          <GradientBannerPanel>
            <div className="grid w-full gap-4 py-1">
              <div className="flex items-center gap-3">
                <AgentAvatar agentId={agent.id} name={agent.name} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{agent.name}</p>
                  <p className="truncate text-sm opacity-70">{agent.task}</p>
                </div>
                <GradientBannerBadge>{done ? 'Done' : 'Working'}</GradientBannerBadge>
              </div>
              <GradientBannerProgress value={Math.min((elapsed / work) * 100, 100)} />
              <ol className="grid gap-2 text-sm">
                {agent.steps.map((step, index) => (
                  <li
                    key={step}
                    className={
                      index <= current
                        ? 'flex items-center gap-2 transition duration-500'
                        : 'flex -translate-x-2 items-center gap-2 opacity-0 transition duration-500'
                    }
                  >
                    {index < current ? <CheckCircle size={16} /> : <Spinner />}
                    <span className="truncate">{step}</span>
                  </li>
                ))}
              </ol>
              <div className={done ? 'transition duration-500' : 'scale-95 opacity-0 transition duration-500'}>
                <GradientBannerBadge>
                  <CheckCircle size={14} />
                  {agent.result}
                </GradientBannerBadge>
              </div>
            </div>
          </GradientBannerPanel>
        </div>
        <div className="flex justify-center gap-2">
          {agents.map((item, index) => (
            <span
              key={item.id}
              className={
                index === active ? 'transition-opacity duration-500' : 'opacity-40 transition-opacity duration-500'
              }
            >
              <AgentAvatar agentId={item.id} name={item.name} size="sm" />
            </span>
          ))}
        </div>
      </div>
    </GradientBanner>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  compact,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  compact?: boolean;
}) {
  return (
    <PublicAuthQueryProvider>
      <div className="grid min-h-svh lg:grid-cols-2">
        <div className="flex flex-col">
          <header className={`px-6 py-6 sm:px-10${compact ? ' lg:py-2' : ''}`}>
            <img src="/logo-ink.svg" alt="TulipFarm" className="h-8 dark:hidden" />
            <img src="/logo-white.svg" alt="TulipFarm" className="hidden h-8 dark:block" />
          </header>
          <main
            className={`flex flex-1 items-center justify-center px-2 pb-16 min-[360px]:px-6${compact ? ' lg:pb-4' : ''}`}
          >
            <section
              aria-labelledby="auth-title"
              className={`w-full max-w-sm space-y-8${compact ? ' lg:space-y-4' : ''}`}
            >
              <header className="space-y-2">
                <h1 id="auth-title" className="text-2xl font-medium tracking-tight">
                  {title}
                </h1>
                <p className="text-lg text-muted-foreground">{subtitle}</p>
              </header>
              {children}
              <p className="text-sm text-muted-foreground">{footer}</p>
            </section>
          </main>
        </div>
        <aside aria-hidden="true" className="hidden p-3 lg:grid [html[data-analytics-consent]_&]:pb-64">
          <AgentActivity />
        </aside>
      </div>
    </PublicAuthQueryProvider>
  );
}

async function loadDevSignInLink(email: string) {
  try {
    const response = await fetch(`${apiOrigin}/v1/dev/sign-in-link?email=${encodeURIComponent(email)}`);
    return response.ok ? String((await response.json()).link) : '';
  } catch {
    return '';
  }
}

/** Picks the subtitle by the sign-in methods the server offers; render it inside AuthLayout. */
export function AuthSubtitle({ password, link }: { password: string; link: string }) {
  const options = useAuthOptions().data;
  if (!options) return null;
  if (options.emailPassword) return options.magicLink ? password : 'Sign in with your email and password.';
  if (options.magicLink) return link;
  if (options.google) return 'Continue with your Google account.';
  return 'Sign-in is not set up on this server yet.';
}

export function AuthForm({
  withName,
  submitLabel,
  passwordLabel,
  googleLabel,
  pending,
  onPendingChange: setPending,
  workspace,
}: {
  withName?: boolean;
  submitLabel: string;
  /** The primary action when password sign-in is on; the email link becomes the secondary one. */
  passwordLabel?: string;
  googleLabel: string;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  workspace?: ReturnType<typeof useOnboardingFields>;
}) {
  const options = useAuthOptions();
  const passwordSignIn = options.data?.emailPassword === true;
  const emailLink = options.data?.magicLink === true;
  const googleSignIn = options.data?.google === true;
  // Keep the email form while options load so typed input survives; verification blocks submits until then.
  const emailForm = !options.data || passwordSignIn || emailLink;
  const [passwordInput, setPasswordInput] = useState('');
  // The magic-link button submits the same form; this marks that submit as a link request.
  const linkRequested = useRef(false);
  const [submittedMode, setSubmittedMode] = useState<'password' | 'link'>('password');
  const [sentTo, setSentTo] = useState('');
  const [devLink, setDevLink] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const nameError = submitted && withName && !nameInput.trim() ? 'Enter your name.' : undefined;
  const emailError =
    submitted && !z.email().safeParse(emailInput.trim()).success ? 'Enter a valid email address.' : undefined;
  const passwordProblem = withName
    ? newPasswordError(passwordInput)
    : passwordInput
      ? undefined
      : 'Enter your password.';
  const passwordError = submitted && submittedMode === 'password' ? passwordProblem : undefined;
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const [recipient, setRecipient] = useState<{ email: string; name: string | undefined } | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const cooldown = Math.max(0, Math.ceil((resendAt - now) / 1000));
  useEffect(() => {
    if (!resendAt) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= resendAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  function startCooldown() {
    const current = Date.now();
    setNow(current);
    setResendAt(current + 60000);
  }
  const submitting = useRef(false);
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    return code === 'ACCOUNT_EXISTS'
      ? accountExistsMessage
      : code !== null
        ? 'Sign-in did not finish. Please try again.'
        : '';
  });
  const destination = safeAuthRedirect(new URLSearchParams(window.location.search).get('redirect'));
  async function callbacks() {
    const next = workspace ? await workspace.prepare() : destination;
    return authCallbackURLs(next, window.location.origin);
  }

  function submit() {
    const mode = passwordSignIn && !linkRequested.current ? 'password' : 'link';
    linkRequested.current = false;
    setSubmitted(true);
    setSubmittedMode(mode);
    const validWorkspace = !workspace || workspace.validate();
    if (
      (withName && !nameInput.trim()) ||
      !z.email().safeParse(emailInput.trim()).success ||
      !validWorkspace ||
      (mode === 'password' && passwordProblem)
    ) {
      setError('Check the highlighted fields to continue.');
      return 'invalid';
    }
    if (submitting.current || challengeToken === null) return;
    submitting.current = true;
    const address = { email: emailInput.trim(), name: withName ? nameInput.trim() : undefined };
    void (mode === 'password' ? submitPassword(address) : sendLink(address));
  }

  async function submitPassword({ email, name }: { email: string; name: string | undefined }) {
    if (challengeToken === null) return;
    setPending(true);
    setError('');
    let leaving = false;
    try {
      const { callbackURL } = await callbacks();
      const request = {
        headers: challengeToken ? { 'x-captcha-response': challengeToken } : {},
        signal: AbortSignal.timeout(15000),
      };
      const result =
        name === undefined
          ? await authClient.signIn.email({ email, password: passwordInput }, request)
          : await authClient.signUp.email({ email, name, password: passwordInput }, request);
      if (result.error) {
        setError(
          passwordFailureMessage(
            result.error,
            name === undefined
              ? 'Could not sign you in. Please try again.'
              : 'Could not create your account. Please try again.',
          ),
        );
      } else {
        leaving = true;
        window.location.assign(callbackURL);
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not reach TulipFarm. Check your connection and try again.',
      );
    } finally {
      if (!leaving) {
        submitting.current = false;
        setPending(false);
      }
      setChallengeToken(null);
      setChallengeAttempt(value => value + 1);
    }
  }

  async function sendLink(address: { email: string; name: string | undefined }) {
    if (challengeToken === null) return;
    const { email } = address;
    setRecipient(address);
    setPending(true);
    setError('');
    try {
      const { callbackURL, newUserCallbackURL, errorCallbackURL } = await callbacks();
      const result = await authClient.signIn.magicLink(
        { ...address, callbackURL, newUserCallbackURL, errorCallbackURL },
        {
          headers: challengeToken ? { 'x-captcha-response': challengeToken } : {},
          signal: AbortSignal.timeout(15000),
        },
      );
      if (result.error) {
        setError(
          result.error.code === 'CHALLENGE_FAILED'
            ? 'Verification failed. Complete the new challenge and try again.'
            : result.error.code === 'ACCOUNT_EXISTS'
              ? accountExistsMessage
              : result.error.status === 429
                ? 'Too many attempts. Please wait a minute and try again.'
                : 'Could not send the sign-in email. Please try again.',
        );
        if (result.error.status === 429) startCooldown();
      } else {
        setSentTo(email);
        startCooldown();
        if (import.meta.env.DEV) setDevLink(await loadDevSignInLink(email));
      }
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

  async function signInWithGoogle() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const { callbackURL, newUserCallbackURL, errorCallbackURL } = await callbacks();
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL,
        newUserCallbackURL,
        errorCallbackURL,
      });
      if (result.error)
        setError(
          emailLink
            ? 'Google sign-in is unavailable. Please use an email link or try again later.'
            : 'Google sign-in is unavailable. Please try again later.',
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not reach Google sign-in. Please try again.');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <div className="space-y-4">
        <div role="status" className="flex items-center gap-2 font-medium">
          <EnvelopeCheck size={16} />
          Check your email
        </div>
        <p className="text-muted-foreground">
          We sent a sign-in link to <span className="font-medium text-foreground">{sentTo}</span>. The link expires in
          15 minutes.
        </p>
        <p className="text-sm text-muted-foreground">
          Check your spam folder. If the email has not arrived, request another link below.
        </p>
        {workspace && (
          <p className="text-sm text-muted-foreground">
            Your workspace details are saved for 24 hours. Open the link on any device to continue.
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AuthVerification key={challengeAttempt} onToken={setChallengeToken} />
        <div className="grid">
          <Button
            size="lg"
            disabled={pending || cooldown > 0 || challengeToken === null}
            aria-busy={pending}
            onClick={() => {
              if (submitting.current || !recipient || challengeToken === null || cooldown) return;
              submitting.current = true;
              void sendLink(recipient);
            }}
          >
            {pending ? 'Resending link…' : cooldown ? `Resend link in ${cooldown}s` : 'Resend sign-in link'}
          </Button>
        </div>
        {devLink && (
          <div className="grid">
            <Button size="lg" nativeButton={false} render={<a href={devLink} />}>
              Open dev sign-in link
            </Button>
          </div>
        )}
        <div className="grid">
          <Button
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={() => {
              setSentTo('');
              setDevLink('');
              setError('');
              setEmailInput('');
              setSubmitted(false);
              setChallengeToken(null);
              setChallengeAttempt(value => value + 1);
            }}
          >
            Use a different email
          </Button>
        </div>
      </div>
    );
  }

  if (!emailForm && !googleSignIn)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          No sign-in method is set up on this server. Ask your administrator to configure email delivery or Google
          sign-in.
        </AlertDescription>
      </Alert>
    );

  return (
    <div className={workspace ? 'space-y-4 lg:space-y-3' : 'space-y-6'}>
      {!emailForm && workspace?.fields}
      {!emailForm && error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {emailForm && (
        <Form onSubmit={submit} disabled={pending}>
          <div className={workspace ? 'space-y-4 lg:space-y-3' : 'space-y-5'}>
            {workspace?.fields}
            {withName && (
              <Field id="name" label="Name" required error={nameError}>
                <Input
                  name="name"
                  scale="lg"
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                  maxLength={80}
                  value={nameInput}
                  onChange={event => setNameInput(event.target.value)}
                />
              </Field>
            )}
            <Field id="email" label="Email" required error={emailError}>
              <Input
                name="email"
                type="email"
                scale="lg"
                placeholder="you@company.com"
                autoComplete="email"
                value={emailInput}
                onChange={event => setEmailInput(event.target.value)}
              />
            </Field>
            {passwordSignIn && (
              <Field
                id="password"
                label="Password"
                required
                error={passwordError}
                helper={
                  withName ? (
                    `${passwordLength.min} to ${passwordLength.max} characters.`
                  ) : (
                    <span className="underline underline-offset-4">
                      <Link to="/login/forgot-password" search={{ redirect: destination }}>
                        Forgot password?
                      </Link>
                    </span>
                  )
                }
              >
                <Input
                  name="password"
                  type="password"
                  scale="lg"
                  autoComplete={withName ? 'new-password' : 'current-password'}
                  maxLength={passwordLength.max}
                  value={passwordInput}
                  onChange={event => setPasswordInput(event.target.value)}
                />
              </Field>
            )}
            <AuthVerification key={challengeAttempt} onToken={setChallengeToken} />
            <FormFooter
              dirty={false}
              layout="stack"
              error={error || undefined}
              submit={{
                label: passwordSignIn ? (passwordLabel ?? submitLabel) : submitLabel,
                pendingLabel: passwordSignIn && submittedMode === 'password' ? 'Signing in…' : 'Sending email…',
                state: pending
                  ? { kind: 'busy' }
                  : challengeToken === null
                    ? { kind: 'blocked', reason: 'Complete verification to continue.' }
                    : { kind: 'ready' },
              }}
              secondarySubmit={
                passwordSignIn && emailLink
                  ? {
                      label: submitLabel,
                      disabled: pending || challengeToken === null,
                      onSelect: () => {
                        linkRequested.current = true;
                      },
                    }
                  : undefined
              }
            />
          </div>
        </Form>
      )}
      {emailForm && googleSignIn && (
        <div className="py-2">
          <FieldSeparator>or</FieldSeparator>
        </div>
      )}
      {googleSignIn && (
        <div className="grid">
          <Button variant="outline" size="lg" disabled={pending} onClick={signInWithGoogle}>
            <GoogleLogo />
            {googleLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
