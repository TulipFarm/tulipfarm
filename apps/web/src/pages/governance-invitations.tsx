import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import {
  invitationDetailsSchema,
  invitationTokenSchema,
  joinedWorkspaceSchema,
} from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { authClient } from '@/lib/auth';
import { refreshWorkspaceList } from '@/features/workspaces/queries';
import { governanceRequest } from '@/lib/governance';
import { forgetInvitation, rememberInvitation } from '@/lib/pending-invitation';
import { AuthForm, AuthLayout } from '@/features/auth/form';

const detailsAnswerSchema = z.union([
  invitationDetailsSchema.options[0],
  invitationDetailsSchema.options[1].extend({ linkSignIn: z.boolean() }),
]);
const errorCodeSchema = z.object({ code: z.string() });
type InvitationDetails = z.infer<typeof detailsAnswerSchema>;
type DetailsState =
  | { kind: 'loading' }
  | { kind: 'ready'; details: InvitationDetails }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

/** What a signed-out invitee sees: the invitation creates their account, or they sign in as the invited address. */
function SignedOutInvitation({ token, onSignedIn }: { token: string; onSignedIn: () => void }) {
  const continuation = `/invite?token=${token}`;
  const [state, setState] = useState<DetailsState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [signIn, setSignIn] = useState<'idle' | 'working' | 'failed' | 'account-exists'>('idle');
  const [pending, setPending] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    void authClient
      .$fetch('/invitation/details', { method: 'POST', body: { token } })
      .then(({ data, error }) => {
        if (!current) return;
        if (error) {
          if (error.status === 404 || error.status === 400) forgetInvitation();
          setState({ kind: error.status === 404 || error.status === 400 ? 'unavailable' : 'failed' });
          return;
        }
        const details = detailsAnswerSchema.parse(data);
        if (details.status !== 'active') forgetInvitation();
        setState({ kind: 'ready', details });
      })
      .catch(() => {
        if (current) setState({ kind: 'failed' });
      });
    return () => {
      current = false;
    };
  }, [token, attempt]);
  const signInWithLink = useCallback(async () => {
    setSignIn('working');
    try {
      const { error } = await authClient.$fetch('/invitation/sign-in', { method: 'POST', body: { token } });
      // Signed in now, or already signed in elsewhere in this browser: the signed-in page takes over.
      if (!error) return onSignedIn();
      const code = errorCodeSchema.safeParse(error).data?.code;
      if (code === 'SIGNED_IN') return onSignedIn();
      setSignIn(code === 'ACCOUNT_EXISTS' ? 'account-exists' : 'failed');
    } catch {
      setSignIn('failed');
    }
  }, [token, onSignedIn]);
  const details = state.kind === 'ready' ? state.details : null;
  const linkSignIn = details?.status === 'active' && details.linkSignIn && signIn !== 'account-exists';
  useEffect(() => {
    if (linkSignIn && !started.current) {
      started.current = true;
      void signInWithLink();
    }
  }, [linkSignIn, signInWithLink]);

  if (state.kind === 'loading')
    return (
      <InvitationShell>
        <p role="status">Checking your invitation…</p>
      </InvitationShell>
    );
  if (state.kind === 'failed')
    return (
      <InvitationShell>
        <StatePanel
          kind="error"
          title="Could not check your invitation"
          description="Your invitation is still here. Check your connection and retry."
        >
          <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>
            Retry
          </Button>
        </StatePanel>
      </InvitationShell>
    );
  if (state.kind === 'unavailable' || !details)
    return (
      <InvitationShell>
        <StatePanel
          kind="unavailable"
          title="Invalid invitation link"
          description="Ask a workspace admin for a new invitation link."
        />
      </InvitationShell>
    );
  if (details.status === 'consumed')
    return (
      <InvitationShell>
        <StatePanel
          kind="unavailable"
          title="This invitation was already used"
          description="If you accepted it, sign in to open the workspace. Otherwise, ask a workspace admin for a new invitation."
        >
          <Button nativeButton={false} render={<Link to="/login" search={{ redirect: continuation }} />}>
            Sign in
          </Button>
        </StatePanel>
      </InvitationShell>
    );
  if (details.status !== 'active')
    return (
      <InvitationShell>
        <StatePanel
          kind="unavailable"
          title={details.status === 'expired' ? 'This invitation has expired' : 'This invitation was revoked'}
          description="Ask a workspace admin for a new invitation."
        />
      </InvitationShell>
    );
  if (linkSignIn)
    return (
      <InvitationShell>
        {signIn === 'failed' ? (
          <StatePanel
            kind="error"
            title="Could not join the workspace"
            description="Your invitation is still here. Retry, or ask a workspace admin for a new invitation."
          >
            <Button onClick={() => void signInWithLink()}>Retry</Button>
          </StatePanel>
        ) : (
          <p role="status">
            Joining {details.workspaceName} as {details.email}…
          </p>
        )}
      </InvitationShell>
    );
  const hasAccount = details.hasAccount || signIn === 'account-exists';
  return (
    <AuthLayout
      title={`Join ${details.workspaceName}`}
      subtitle={
        hasAccount
          ? `Sign in as ${details.email} to join. You will go straight to the workspace.`
          : `Create your account for ${details.email} to join. You will go straight to the workspace.`
      }
      footer="Invited at a different address? Ask a workspace admin to invite the address you use."
    >
      <AuthForm
        key={hasAccount ? 'sign-in' : 'sign-up'}
        withName={!hasAccount}
        email={details.email}
        redirect={continuation}
        submitLabel={hasAccount ? 'Email me a sign-in link' : 'Email me a sign-up link'}
        passwordLabel={hasAccount ? 'Log in' : 'Create account'}
        linkLabel={hasAccount ? 'Email me a sign-in link instead' : undefined}
        googleLabel="Continue with Google"
        providersFirst={hasAccount}
        pending={pending}
        onPendingChange={setPending}
      />
    </AuthLayout>
  );
}

function InvitationShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-medium">Join a workspace</h1>
      {children}
      <Button variant="ghost" nativeButton={false} render={<Link to="/" />}>
        Back to TulipFarm
      </Button>
    </main>
  );
}

export function JoinWorkspacePage() {
  const { data: session, isPending, error: sessionError, refetch } = authClient.useSession();
  const token = invitationTokenSchema.safeParse(new URLSearchParams(window.location.search).get('token'));
  const continuation = token.success ? `/invite?token=${token.data}` : '/';
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<string | null>(null);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const attempted = useRef(false);
  const tokenValue = token.success ? token.data : null;
  useEffect(() => {
    if (tokenValue) rememberInvitation(tokenValue);
  }, [tokenValue]);
  async function openWorkspace(workspaceId: string) {
    if (!session) return;
    const workspaces = await refreshWorkspaceList({ userId: session.user.id, sessionId: session.session.id });
    const workspace = workspaces.find(item => item.id === workspaceId);
    if (!workspace)
      throw new Error('Your membership was saved, but the workspace could not be opened. Try opening it again.');
    window.location.replace(`/${workspace.slug}`);
  }
  const join = useCallback(async () => {
    if (!tokenValue || pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = joinedWorkspaceSchema.parse(
        await governanceRequest('/invitations/redeem', 'POST', { token: tokenValue }),
      );
      forgetInvitation();
      setJoined(result.workspaceId);
      try {
        await openWorkspace(result.workspaceId);
      } catch {
        setMessage('Your membership was saved. Use Open joined workspace to try opening it again.');
      }
    } catch {
      // Opening TulipFarm again should not return here; the link itself still works.
      forgetInvitation();
      setRetryAvailable(true);
      setMessage(
        'Could not accept this invitation. It may be expired, revoked, or for a different verified email. Retry, switch accounts, or ask the admin for a new invitation.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [tokenValue, session?.user.id, session?.session.id]);
  useEffect(() => {
    if (!isPending && !sessionError && session && tokenValue && !attempted.current) {
      attempted.current = true;
      void join();
    }
  }, [isPending, sessionError, session, tokenValue, join]);
  if (tokenValue && !isPending && !sessionError && !session)
    return <SignedOutInvitation token={tokenValue} onSignedIn={() => window.location.replace(continuation)} />;
  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-medium">Join a workspace</h1>
      {!token.success ? (
        <StatePanel
          kind="unavailable"
          title="Invalid invitation link"
          description="Ask a workspace admin for a new invitation link."
        />
      ) : isPending ? (
        <p role="status">Checking your session…</p>
      ) : sessionError ? (
        <StatePanel
          kind="error"
          title="Could not check your account"
          description="Your invitation is still here. Retry the session check."
        >
          <Button variant="outline" onClick={() => void refetch()}>
            Retry session check
          </Button>
        </StatePanel>
      ) : !session ? null : joined ? (
        <StatePanel
          kind="success"
          title="Workspace joined"
          description="Your membership is ready. An admin assigns teams separately."
        >
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await openWorkspace(joined);
              } catch {
                setMessage('Could not open your joined workspace. Try again.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Open joined workspace
          </Button>
        </StatePanel>
      ) : (
        <section className="flex flex-col gap-4">
          <p>Signed in as {session.user.email}.</p>
          {retryAvailable ? (
            <Button aria-disabled={busy} aria-busy={busy} onClick={() => void join()}>
              {busy ? 'Retrying invitation…' : 'Retry invitation'}
            </Button>
          ) : (
            <p role="status">Joining workspace…</p>
          )}
          <Button
            variant="outline"
            disabled={busy}
            nativeButton={false}
            render={<Link to="/logout" search={{ redirect: continuation }} />}
          >
            Use a different account
          </Button>
        </section>
      )}
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <Button variant="ghost" nativeButton={false} render={<Link to="/" />}>
        Back to TulipFarm
      </Button>
    </main>
  );
}
