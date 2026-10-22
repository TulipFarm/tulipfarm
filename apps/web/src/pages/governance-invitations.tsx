import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { invitationTokenSchema, joinedWorkspaceSchema } from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { authClient } from '@/lib/auth';
import { refreshWorkspaceList } from '@/features/workspaces/queries';
import { governanceRequest } from '@/lib/governance';

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
      setJoined(result.workspaceId);
      try {
        await openWorkspace(result.workspaceId);
      } catch {
        setMessage('Your membership was saved. Use Open joined workspace to try opening it again.');
      }
    } catch {
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
      ) : !session ? (
        <StatePanel
          kind="unavailable"
          title="Sign in before joining"
          description="Your invitation will remain available after you sign in or create an account."
        >
          <Button nativeButton={false} render={<Link to="/login" search={{ redirect: continuation }} />}>
            Sign in
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/register" search={{ redirect: continuation }} />}
          >
            Create an account
          </Button>
        </StatePanel>
      ) : joined ? (
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
