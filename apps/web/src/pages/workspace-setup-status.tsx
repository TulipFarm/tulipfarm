import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useRouterState, useSearch } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useWorkspaceSetup, useWorkspaceListCommand } from '@/features/workspaces/queries';

type SetupState =
  | 'loading'
  | 'reserved'
  | 'database'
  | 'slow'
  | 'error'
  | 'failed'
  | 'unavailable'
  | 'ready'
  | 'opening';
const content = {
  loading: { title: 'Checking workspace setup', description: 'Loading the status of your existing workspace.' },
  reserved: {
    title: 'Setting up your workspace',
    description: 'Your workspace has been created. We are preparing its storage and initial access.',
  },
  database: {
    title: 'Finishing workspace setup',
    description: 'Storage is ready. We are checking that your workspace is ready to use.',
  },
  slow: {
    title: 'Setup is taking longer than expected',
    description: 'Your workspace still exists. Check its status again in a moment.',
  },
  error: {
    title: 'Could not check workspace setup',
    description: 'Your workspace still exists. Check your connection and check its status again.',
  },
  failed: {
    title: 'Workspace setup needs attention',
    description: 'Setup has not finished. Automatic recovery may still be running. Check its status again in a moment.',
  },
  unavailable: {
    title: 'Workspace setup is unavailable',
    description: 'This workspace may be disabled, or this account does not have access.',
  },
  ready: {
    title: 'Your workspace is ready',
    description: 'Open your workspace when you are ready. Current membership is checked before access.',
  },
  opening: { title: 'Your workspace is ready', description: 'Checking access and opening your workspace.' },
};

export function WorkspaceSetupStatusPage() {
  const { setupId } = useParams({ from: '/workspace-setups/$setupId' });
  const { redirect } = useSearch({ from: '/workspace-setups/$setupId' });
  const destination = useRouterState({ select: state => state.location.href });
  const navigate = useNavigate();
  const read = useWorkspaceSetup(setupId);
  const list = useWorkspaceListCommand();
  const [opening, setOpening] = useState<'opening' | 'error' | 'unavailable' | null>(null);
  const state: SetupState =
    opening ??
    (read.state.kind === 'unavailable'
      ? 'unavailable'
      : read.state.kind === 'error' || (read.state.kind === 'ready' && read.state.error)
        ? 'error'
        : read.state.kind === 'loading'
          ? 'loading'
          : read.state.kind === 'ready'
            ? read.state.data.stage === 'unavailable'
              ? 'unavailable'
              : read.state.data.stage === 'ready'
                ? 'ready'
                : read.state.data.error
                  ? 'failed'
                  : read.delayed
                    ? 'slow'
                    : read.state.data.stage
            : 'loading');
  const primary = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (restoreFocus.current && ['ready', 'slow', 'error', 'failed'].includes(state)) {
      primary.current?.focus();
      restoreFocus.current = false;
    }
  }, [state]);
  useEffect(() => {
    if (read.state.kind === 'unavailable' && read.state.status === 401)
      void navigate({ to: '/login', search: { redirect: destination }, replace: true });
  }, [read.state.kind, read.state.kind === 'unavailable' && read.state.status, destination, navigate]);

  const autoOpened = useRef(false);
  const open = async () => {
    setOpening('opening');
    restoreFocus.current = true;
    try {
      const workspace = (await list()).find(item => item.id === setupId);
      if (!workspace) {
        setOpening('unavailable');
        return;
      }
      if (redirect) await navigate({ href: redirect, replace: true });
      else await navigate({ to: '/$workspaceSlug', params: { workspaceSlug: workspace.slug }, replace: true });
    } catch {
      setOpening('error');
    }
  };
  useEffect(() => {
    if (state !== 'ready' || autoOpened.current) return;
    autoOpened.current = true;
    void open();
  });

  const loading = ['loading', 'reserved', 'database', 'opening'].includes(state);
  return (
    <main className="flex min-h-svh items-center justify-center">
      <StatePanel
        heading="h1"
        kind={
          loading
            ? 'loading'
            : state === 'ready'
              ? 'success'
              : state === 'error' || state === 'failed'
                ? 'error'
                : 'unavailable'
        }
        title={content[state].title}
        description={content[state].description}
      >
        {(state === 'ready' || state === 'opening') && (
          <Button
            ref={primary}
            disabled={state === 'opening'}
            aria-busy={state === 'opening'}
            onClick={() => void open()}
          >
            Open workspace
          </Button>
        )}
        {['slow', 'error', 'failed'].includes(state) && (
          <Button
            ref={primary}
            onClick={() => {
              restoreFocus.current = true;
              setOpening(null);
              void read.refresh();
            }}
          >
            Check status again
          </Button>
        )}
        <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
          Back to TulipFarm
        </Button>
        {state !== 'unavailable' && (
          <p className="text-sm text-muted-foreground">You can leave this page. Setup continues in the background.</p>
        )}
      </StatePanel>
    </main>
  );
}
