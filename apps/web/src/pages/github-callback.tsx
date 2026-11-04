import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { z } from 'zod';
import type { completionSchema } from '@tulipfarm/github/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { githubApi, githubError } from '@/lib/github';
import { githubReturn, parseGitHubReturn, type GitHubReturnParams } from '@/lib/github-return';
import { listWorkspaces } from '@/lib/workspaces';
import { workspaceDestination } from '@/lib/last-workspace';
import { startGitHub } from '@/features/integrations/connect';
import { useIntegrationWorkspace, useIntegrationCallbackChanges } from '@/features/integrations/queries';
import { authClient } from '@/lib/auth';

type SetupAction = Extract<GitHubReturnParams, { kind: 'setup' }>['action'];
type Outcome =
  | { kind: 'loading' }
  | { kind: 'connected'; login: string; workspaceId: string; setup?: SetupAction }
  | { kind: 'not-active'; workspaceId: string }
  | { kind: 'not-connected'; workspaceId: string; setup: SetupAction }
  | { kind: 'no-workspace' }
  | { kind: 'error'; message: string; workspaceId: string | null; retry: 'connect' | 'check' };

// GitHub's callback code and state work once. The attempt lives outside the component so that a
// remount (a session refresh, or React re-running the effect) reuses it instead of posting the
// stripped URL again and reporting a used callback after a successful connection.
let attempt: {
  key: string;
  params: GitHubReturnParams;
  completion: Promise<z.infer<typeof completionSchema>> | null;
} | null = null;
function captureReturn() {
  const { pathname, search } = window.location;
  const key = pathname + search;
  if (!attempt || (search && attempt.key !== key) || !attempt.key.startsWith(pathname)) {
    const params = parseGitHubReturn(pathname, search);
    attempt = { key, params, completion: params.kind === 'oauth' ? githubApi.complete(params.input) : null };
  }
  window.history.replaceState(null, '', pathname);
  return attempt;
}

async function installationOutcome(userId: string, setup: SetupAction): Promise<Outcome> {
  const workspaces = (await listWorkspaces()).filter(workspace => workspace.status === 'ready');
  const remembered = githubReturn();
  const fallback = workspaceDestination(userId, workspaces);
  const workspace =
    workspaces.find(item => item.id === remembered?.workspaceId) ??
    workspaces.find(item => `/${item.slug}` === fallback);
  if (!workspace) return { kind: 'no-workspace' };
  const active = (await githubApi.list(workspace.id)).accounts.find(
    account => account.state === 'active' && account.identity,
  );
  return active?.identity
    ? { kind: 'connected', login: active.identity.login, workspaceId: workspace.id, setup }
    : { kind: 'not-connected', workspaceId: workspace.id, setup };
}

export function GitHubCallbackPage() {
  const session = authClient.useSession();
  if (session.isPending)
    return (
      <StatePanel kind="loading" title="Checking your session" description="Checking the account for GitHub consent." />
    );
  if (!session.data)
    return (
      <StatePanel
        kind="unavailable"
        title="Sign in to recover GitHub consent"
        description="Return to Integrations after signing in and start fresh consent."
      >
        <Button nativeButton={false} render={<Link to="/login" />}>
          Sign in to TulipFarm
        </Button>
      </StatePanel>
    );
  return <GitHubCallbackResult userId={session.data.user.id} />;
}

function GitHubCallbackResult({ userId }: { userId: string }) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'loading' });
  const [check, setCheck] = useState(0);
  const [starting, setStarting] = useState(false);
  const workspaceId = 'workspaceId' in outcome ? (outcome.workspaceId ?? undefined) : undefined;
  const navigation = useIntegrationWorkspace(workspaceId);
  const changed = useIntegrationCallbackChanges();
  const navigate = useNavigate();
  useEffect(() => {
    let live = true;
    const settle = (next: Outcome) => {
      if (live) setOutcome(next);
    };
    const { params, completion } = captureReturn();
    if (params.kind === 'invalid') {
      settle({
        kind: 'error',
        message: 'Invalid or already used callback. Return to GitHub accounts and connect again.',
        workspaceId: params.workspaceId ?? githubReturn()?.workspaceId ?? null,
        retry: 'connect',
      });
    } else if (params.kind === 'setup') {
      setOutcome({ kind: 'loading' });
      installationOutcome(userId, params.action)
        .then(async next => {
          if ('workspaceId' in next && next.workspaceId)
            await changed(next.workspaceId, 'github-personal').catch(() => {});
          settle(next);
        })
        .catch(error =>
          settle({
            kind: 'error',
            message: githubError(error),
            workspaceId: githubReturn()?.workspaceId ?? null,
            retry: 'check',
          }),
        );
    } else {
      completion
        ?.then(async result => {
          await changed(result.workspaceId, 'github-personal').catch(() => {});
          // Coming back from GitHub is not proof of a connection; only an active account is.
          settle(
            result.account.state === 'active' && result.account.identity
              ? { kind: 'connected', login: result.account.identity.login, workspaceId: result.workspaceId }
              : { kind: 'not-active', workspaceId: result.workspaceId },
          );
        })
        .catch(error =>
          settle({ kind: 'error', message: githubError(error), workspaceId: params.workspaceId, retry: 'connect' }),
        );
    }
    return () => {
      live = false;
    };
  }, [changed, userId, check]);

  const slug = navigation.data?.slug;
  const back = slug ? githubReturn(workspaceId)?.path : null;
  const backSection = back?.split(/[?#]/)[0]?.split('/');
  const sameWorkspace = !!back && backSection?.[1] === slug;
  const backToAccounts = sameWorkspace && backSection?.[2] === 'integrations' ? back : null;
  const backElsewhere =
    sameWorkspace && !backToAccounts
      ? { href: back, label: backSection?.[2] === 'chat' ? 'Return to chat' : 'Return to where you started' }
      : null;
  const follow = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigate({ href });
  };
  const connectAgain = useCallback(async () => {
    if (!workspaceId) return;
    setStarting(true);
    try {
      await startGitHub(workspaceId);
    } catch (error) {
      setStarting(false);
      setOutcome({ kind: 'error', message: githubError(error), workspaceId, retry: 'connect' });
    }
  }, [workspaceId]);

  const [kind, title, description] = ((): ['loading' | 'success' | 'unavailable' | 'error', string, string] => {
    switch (outcome.kind) {
      case 'loading':
        return ['loading', 'Connecting GitHub…', 'Checking consent for your current session.'];
      case 'connected':
        return [
          'success',
          `Connected @${outcome.login}`,
          outcome.setup === 'request'
            ? 'Your GitHub login is connected. An organization owner must approve the App installation request on GitHub before its repositories appear.'
            : outcome.setup
              ? 'Your GitHub login is connected. Repositories you gave the TulipFarm GitHub App appear in GitHub accounts once GitHub shares them.'
              : 'Your GitHub login is connected and private to you.',
        ];
      case 'not-active':
        return [
          'error',
          'GitHub sign-in finished, but the login is not connected',
          'TulipFarm could not confirm an active connection. Check GitHub accounts, then connect again if it still needs attention.',
        ];
      case 'not-connected':
        return [
          'unavailable',
          outcome.setup === 'request'
            ? 'GitHub App installation needs approval'
            : 'Connect your GitHub login to finish',
          outcome.setup === 'request'
            ? 'An organization owner must approve the request on GitHub. Connect your GitHub login so agents can use it once approved.'
            : 'GitHub returned from the App installation, but no GitHub login is connected to TulipFarm yet.',
        ];
      case 'no-workspace':
        return [
          'unavailable',
          'Back from GitHub',
          'Open your workspace, then check GitHub accounts in Integrations to see the connection.',
        ];
      case 'error':
        return [
          'error',
          outcome.retry === 'check' ? 'GitHub status could not be checked' : 'GitHub consent could not be confirmed',
          outcome.message,
        ];
    }
  })();
  const offerConnect =
    !!workspaceId && (outcome.kind === 'not-active' || outcome.kind === 'not-connected' || outcome.kind === 'error');

  const panel = (
    <StatePanel heading="h1" kind={kind} title={title} description={description}>
      {backElsewhere && outcome.kind === 'connected' && (
        <Button nativeButton={false} render={<a href={backElsewhere.href} onClick={follow(backElsewhere.href)} />}>
          {backElsewhere.label}
        </Button>
      )}
      {offerConnect && (outcome.kind !== 'error' || outcome.retry === 'connect') && (
        <Button disabled={starting} aria-busy={starting} onClick={() => void connectAgain()}>
          {starting ? 'Opening GitHub…' : 'Connect GitHub'}
        </Button>
      )}
      {outcome.kind === 'error' && outcome.retry === 'check' && (
        <Button onClick={() => setCheck(value => value + 1)}>Check again</Button>
      )}
      {slug &&
        outcome.kind !== 'loading' &&
        (backToAccounts ? (
          <Button
            variant={outcome.kind === 'connected' && !backElsewhere ? 'default' : 'outline'}
            nativeButton={false}
            render={<a href={backToAccounts} onClick={follow(backToAccounts)} />}
          >
            Return to GitHub accounts
          </Button>
        ) : (
          <Button
            variant={outcome.kind === 'connected' && !backElsewhere ? 'default' : 'outline'}
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug/integrations/$integrationId"
                params={{ workspaceSlug: slug, integrationId: 'github' }}
                search={{ tab: 'accounts' }}
              />
            }
          >
            Return to GitHub accounts
          </Button>
        ))}
      {navigation.error && (
        <Button variant="outline" onClick={() => void navigation.refresh()}>
          Retry workspace navigation
        </Button>
      )}
      {outcome.kind !== 'loading' && (
        <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
          Open my workspace
        </Button>
      )}
    </StatePanel>
  );
  return <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-5 p-6">{panel}</main>;
}
