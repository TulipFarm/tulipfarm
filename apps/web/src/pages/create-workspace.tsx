import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowRight as ArrowRightIcon } from 'reicon-react/icons/ArrowRight';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@tulipfarm/sprout/input-group';
import { suggestWorkspaceSlug, workspaceSlugError } from '@/lib/workspace-slug';
import { createWorkspace, WorkspaceRequestError } from '@/lib/workspaces';
import { useWorkspaceChanges } from '@/features/workspaces/changes';
import { AuthVerification } from '@/features/auth/verification';
import { PublicAuthQueryProvider } from '@/features/auth/public-query';
import { authClient } from '@/lib/auth';
import { resumeOnboarding } from '@/lib/onboarding';
import { WorkspaceSignupPage } from './auth';

export function CreateWorkspacePage() {
  const { data: session } = authClient.useSession();
  return session ? <SignedInCreateWorkspacePage /> : <WorkspaceSignupPage />;
}

function SignedInCreateWorkspacePage() {
  const navigate = useNavigate();
  const changes = useWorkspaceChanges();
  const [name, setName] = useState('');
  const [customSlug, setCustomSlug] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(() => new URLSearchParams(window.location.hash.slice(1)).has('token'));
  const [saveError, setSaveError] = useState('');
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const submitting = useRef(false);
  const slug = customSlug ?? suggestWorkspaceSlug(name);
  const slugError = workspaceSlugError(slug);
  const showSlugError = (slugTouched || submitted) && slugError;
  const nameError = submitted && !name.trim();
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!token) return;
    let active = true;
    void resumeOnboarding(token)
      .then(draft => {
        if (!active) return;
        setName(draft.details.name);
        setCustomSlug(draft.details.slug);
        setRequestId(draft.id);
      })
      .catch(() => {
        if (active) setSaveError('Could not restore your workspace details. Enter them again or return to onboarding.');
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex min-h-svh flex-col">
      <header className="px-6 py-6 sm:px-10">
        <img src="/logo-ink.svg" alt="TulipFarm" className="h-8 dark:hidden" />
        <img src="/logo-white.svg" alt="TulipFarm" className="hidden h-8 dark:block" />
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        <section aria-labelledby="create-workspace-title" className="w-full max-w-md space-y-10">
          <header className="space-y-3 text-center">
            <p className="text-xs font-medium text-muted-foreground">YOUR WORK STARTS HERE</p>
            <h1 id="create-workspace-title" className="text-3xl font-medium tracking-tight">
              Create a workspace
            </h1>
            <p className="text-lg text-muted-foreground">A place for your team, agents, and everyday work.</p>
          </header>
          <form
            noValidate
            className="space-y-6"
            onSubmit={async event => {
              event.preventDefault();
              setSubmitted(true);
              setSaveError('');
              if (!name.trim() || slugError || submitting.current || restoring || challengeToken === null) return;
              submitting.current = true;
              setSaving(true);
              try {
                const workspace = await createWorkspace({
                  requestId,
                  slug,
                  name: name.trim(),
                  ...(challengeToken ? { challengeToken } : {}),
                });
                await changes.changed();
                if (workspace.status === 'ready')
                  await navigate({ to: '/$workspaceSlug', params: { workspaceSlug: workspace.slug }, replace: true });
                else
                  await navigate({
                    to: '/workspace-setups/$setupId',
                    params: { setupId: workspace.id },
                    replace: true,
                  });
              } catch (error) {
                if (error instanceof WorkspaceRequestError && error.status === 401) {
                  await navigate({ to: '/login', search: { redirect: '/create-workspace' }, replace: true });
                  return;
                }
                setSaveError(
                  error instanceof WorkspaceRequestError && [403, 409].includes(error.status)
                    ? error.message
                    : error instanceof WorkspaceRequestError && error.status === 429
                      ? 'Too many workspace creation attempts. Please wait before trying again.'
                      : 'We couldn’t confirm creation. Your details are still here. Check your connection and try again.',
                );
                if (error instanceof WorkspaceRequestError && error.status === 409) setRequestId(crypto.randomUUID());
                setSaving(false);
                setChallengeToken(null);
                setChallengeAttempt(attempt => attempt + 1);
                submitting.current = false;
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="workspace-name">Workspace name</Label>
              <Input
                id="workspace-name"
                name="workspace-name"
                scale="lg"
                placeholder="Acme, Inc."
                autoComplete="organization"
                maxLength={80}
                required
                value={name}
                disabled={saving || restoring}
                aria-invalid={nameError}
                aria-describedby={nameError ? 'workspace-name-error' : undefined}
                onChange={event => {
                  setName(event.target.value);
                  setRequestId(crypto.randomUUID());
                }}
              />
              {nameError && (
                <p id="workspace-name-error" className="text-sm text-destructive">
                  Enter a workspace name.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="workspace-slug">Workspace URL</Label>
              <InputGroup size="lg">
                <InputGroupAddon>
                  <InputGroupText>{window.location.host}/</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="workspace-slug"
                  name="workspace-slug"
                  placeholder="acme"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={48}
                  required
                  value={slug}
                  disabled={saving || restoring}
                  aria-invalid={Boolean(showSlugError)}
                  aria-describedby="workspace-slug-hint"
                  onChange={event => {
                    setCustomSlug(event.target.value);
                    setRequestId(crypto.randomUUID());
                  }}
                  onBlur={() => setSlugTouched(true)}
                />
              </InputGroup>
              <p
                id="workspace-slug-hint"
                aria-live="polite"
                className={showSlugError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
              >
                {showSlugError || 'Choose carefully. This address cannot be changed after creation.'}
              </p>
            </div>
            <div className="grid gap-3 pt-2">
              {restoring && <p role="status">Restoring your workspace details...</p>}
              <PublicAuthQueryProvider>
                <AuthVerification key={challengeAttempt} onToken={setChallengeToken} action="create_workspace" />
              </PublicAuthQueryProvider>
              <div className="grid">
                <Button
                  type="submit"
                  size="lg"
                  disabled={saving || restoring || challengeToken === null}
                  aria-busy={saving || restoring}
                >
                  {saving ? <Spinner aria-hidden="true" /> : <ArrowRightIcon aria-hidden="true" />}
                  {saving ? 'Creating workspace…' : saveError ? 'Try creating workspace again' : 'Create workspace'}
                </Button>
              </div>
              {saveError && (
                <Alert variant="destructive">
                  <AlertTitle>Workspace creation needs attention</AlertTitle>
                  <AlertDescription>{saveError}</AlertDescription>
                </Alert>
              )}
            </div>
          </form>
          <nav aria-label="Account navigation" className="flex justify-center gap-6 text-sm text-muted-foreground">
            <Link to="/">Back to TulipFarm</Link>
            <Link to="/logout" search={{ redirect: '/create-workspace' }}>
              Log out
            </Link>
          </nav>
        </section>
      </main>
    </div>
  );
}
