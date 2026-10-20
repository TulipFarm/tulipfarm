import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { onboardingTokenSchema } from '@tulipfarm/workspaces/onboarding-contracts';
import type { Workspace } from '@tulipfarm/workspaces/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { AuthVerification } from '@/features/auth/verification';
import { PublicAuthQueryProvider } from '@/features/auth/public-query';
import { OnboardingChatHistory, OnboardingChatSetup, OnboardingChatSlug } from '@/features/auth/onboarding-chat';
import { useWorkspaceChanges } from '@/features/workspaces/changes';
import { completeOnboarding, resumeOnboarding } from '@/lib/onboarding';
import { WorkspaceRequestError } from '@/lib/workspaces';

export function OnboardingChatPage() {
  return <OnboardingPage chat />;
}

export function OnboardingPage({ chat = false }: { chat?: boolean }) {
  const hash = useRouterState({ select: state => state.location.hash });
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
  return <OnboardingResume key={`${chat}:${token}`} token={token} chat={chat} />;
}

function OnboardingResume({ token, chat }: { token: string; chat: boolean }) {
  const destination = `${chat ? '/onboarding/chat' : '/onboarding'}#token=${token}`;
  const navigate = useNavigate();
  const changes = useWorkspaceChanges();
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof resumeOnboarding>> | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'creating' | 'error' | 'unavailable' | 'opening'>('loading');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef<string | null>(null);
  const mounted = useRef(false);
  const activeToken = useRef(token);
  activeToken.current = token;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setPhase('loading');
    setDraft(null);
    setWorkspace(null);
    setConflict(false);
    setError('');
    setChallenge(null);
    setAttempt(value => value + 1);
    if (!onboardingTokenSchema.safeParse(token).success) {
      setError('This onboarding link is invalid. Start again.');
      setPhase('unavailable');
      return;
    }
    try {
      const saved = await resumeOnboarding(token);
      if (!mounted.current || activeToken.current !== token) return;
      setDraft(saved);
      setPhase('ready');
    } catch (error) {
      if (!mounted.current || activeToken.current !== token) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) {
        await navigate({ to: '/login', search: { redirect: destination }, replace: true });
        return;
      }
      setError(
        error instanceof WorkspaceRequestError ? error.message : 'Could not load your saved details. Please try again.',
      );
      setPhase(error instanceof WorkspaceRequestError && error.status === 404 ? 'unavailable' : 'error');
    }
  }, [token, destination, navigate]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(
    async (created: Workspace) => {
      if (!mounted.current || activeToken.current !== token) return;
      setPhase('opening');
      try {
        await changes.changed();
        if (!mounted.current || activeToken.current !== token) return;
        if (chat || created.status === 'ready')
          await navigate({ to: '/$workspaceSlug', params: { workspaceSlug: created.slug }, replace: true });
        else await navigate({ to: '/workspace-setups/$setupId', params: { setupId: created.id }, replace: true });
      } catch {
        if (!mounted.current || activeToken.current !== token) return;
        setError('Your workspace was created, but could not be opened. Try opening it again.');
        setPhase('error');
      }
    },
    [changes.changed, navigate, token, chat],
  );

  const signIn = useCallback(() => {
    void navigate({ to: '/login', search: { redirect: destination }, replace: true });
  }, [navigate, destination]);

  useEffect(() => {
    if (phase !== 'ready' || !draft || workspace || challenge === null || inFlight.current === token) return;
    inFlight.current = token;
    setPhase('creating');
    void completeOnboarding(token, challenge)
      .then(async created => {
        if (!mounted.current || activeToken.current !== token) return;
        setWorkspace(created);
        if (chat) setPhase('ready');
        else await open(created);
      })
      .catch(async error => {
        if (!mounted.current || activeToken.current !== token) return;
        if (error instanceof WorkspaceRequestError && error.status === 401) {
          await navigate({ to: '/login', search: { redirect: destination }, replace: true });
          return;
        }
        setError(
          error instanceof WorkspaceRequestError && error.status === 429
            ? 'Too many workspace creation attempts. Please wait before trying again.'
            : error instanceof WorkspaceRequestError
              ? error.message
              : 'We could not confirm creation. Your saved details are safe. Try again.',
        );
        setConflict(error instanceof WorkspaceRequestError && error.status === 409);
        setPhase(error instanceof WorkspaceRequestError && error.status === 404 ? 'unavailable' : 'error');
        setChallenge(null);
        setAttempt(value => value + 1);
      })
      .finally(() => {
        if (inFlight.current === token) inFlight.current = null;
      });
  }, [phase, draft, workspace, challenge, token, open, navigate, chat, destination]);

  return (
    <main className={chat ? 'min-h-svh px-2 py-8 min-[360px]:px-6' : 'flex min-h-svh items-center justify-center px-2'}>
      <div className={chat ? 'mx-auto w-full max-w-2xl space-y-8' : 'w-full max-w-md'}>
        {chat && (
          <header className="space-y-3">
            <h1 className="text-2xl font-medium">Your TulipFarm guide</h1>
            <p className="text-sm text-muted-foreground">Continue your website chat and finish workspace setup here.</p>
          </header>
        )}
        {chat && draft && <OnboardingChatHistory draft={draft} />}
        {phase === 'error' ? (
          <StatePanel
            kind="error"
            heading={chat ? 'h2' : 'h1'}
            title={workspace ? 'Your workspace was created' : 'Onboarding needs attention'}
            description={error}
          >
            {conflict ? (
              chat && draft ? (
                <OnboardingChatSlug
                  key={token}
                  draft={draft}
                  onSaved={async replacement => {
                    if (!mounted.current || activeToken.current !== token) return;
                    await navigate({ to: '/onboarding/chat', hash: `token=${replacement}`, replace: true });
                  }}
                />
              ) : (
                <Button nativeButton={false} render={<Link to="/create-workspace" hash={`token=${token}`} />}>
                  Choose a different workspace URL
                </Button>
              )
            ) : (
              <Button
                onClick={() => {
                  if (workspace) void open(workspace);
                  else if (!draft) void load();
                  else setPhase('ready');
                }}
              >
                {workspace ? 'Open workspace' : 'Try again'}
              </Button>
            )}
          </StatePanel>
        ) : phase === 'unavailable' ? (
          <StatePanel
            kind="unavailable"
            heading={chat ? 'h2' : 'h1'}
            title="Start onboarding again"
            description={error}
          >
            <Button nativeButton={false} render={<Link to="/create-workspace" />}>
              Create a workspace
            </Button>
          </StatePanel>
        ) : chat && workspace && phase !== 'opening' ? (
          workspace.status === 'ready' ? (
            <StatePanel
              kind="success"
              title="Your workspace is ready"
              description={`Continue in ${workspace.name} to start your first task.`}
            >
              <Button onClick={() => void open(workspace)}>Open workspace</Button>
            </StatePanel>
          ) : (
            <OnboardingChatSetup workspace={workspace} onOpen={() => void open(workspace)} onSignIn={signIn} />
          )
        ) : (
          <StatePanel
            kind="loading"
            heading={chat ? 'h2' : 'h1'}
            title={
              phase === 'loading'
                ? 'Restoring your workspace details'
                : phase === 'opening'
                  ? 'Opening your workspace'
                  : phase === 'ready'
                    ? 'Finish creating your workspace'
                    : 'Creating your workspace'
            }
            description={
              draft
                ? phase === 'ready'
                  ? `You are signed in. Complete verification to create ${draft.details.name}.`
                  : `We are setting up ${draft.details.name}.`
                : 'Your saved details will appear here.'
            }
          />
        )}
        {draft && !workspace && phase !== 'unavailable' && (
          <div className="flex justify-center pb-8">
            <PublicAuthQueryProvider>
              <AuthVerification key={attempt} action="create_workspace" onToken={setChallenge} />
            </PublicAuthQueryProvider>
          </div>
        )}
      </div>
    </main>
  );
}
