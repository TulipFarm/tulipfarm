import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useProvisioningWorkspace } from '@/features/workspaces/queries';
import { useWorkspaceChanges } from '@/features/workspaces/changes';

type SetupState = 'checking' | 'slow' | 'error' | 'ready' | 'opening';

export function WorkspaceSetup({ name, slug }: { name: string; slug: string }) {
  const router = useRouter();
  const read = useProvisioningWorkspace(slug);
  const changes = useWorkspaceChanges();
  const [opening, setOpening] = useState<'opening' | 'error' | null>(null);
  const state: SetupState =
    opening ??
    (read.state.kind === 'error' ||
    read.state.kind === 'unavailable' ||
    (read.state.kind === 'ready' && read.state.error)
      ? 'error'
      : read.state.kind === 'ready' && read.state.data.status === 'ready'
        ? 'ready'
        : read.delayed
          ? 'slow'
          : 'checking');
  useEffect(() => {
    if (read.state.kind === 'unavailable') void router.invalidate({ sync: true });
  }, [read.state.kind, router]);

  const content = {
    checking: {
      title: `Setting up ${name}`,
      description: 'Your workspace has been created. We’re getting it ready for your team.',
    },
    slow: {
      title: 'Setup is taking longer than expected',
      description: 'Your workspace has been created, but it isn’t ready yet. Check its status again in a moment.',
    },
    error: {
      title: 'We couldn’t check setup',
      description: 'Your workspace has been created. Check your connection and try checking its status again.',
    },
    ready: { title: `${name} is ready`, description: 'Your workspace is set up. Open it when you’re ready.' },
    opening: { title: `${name} is ready`, description: 'Opening your workspace…' },
  }[state];

  return (
    <section aria-label="Workspace setup" className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <StatePanel
        heading="h1"
        kind={
          state === 'error'
            ? 'error'
            : state === 'ready'
              ? 'success'
              : state === 'checking' || state === 'opening'
                ? 'loading'
                : 'unavailable'
        }
        title={content.title}
        description={content.description}
      >
        {(state === 'ready' || state === 'opening') && (
          <Button
            disabled={state === 'opening'}
            aria-busy={state === 'opening'}
            onClick={async () => {
              setOpening('opening');
              try {
                await changes.changed();
                await router.invalidate({ sync: true });
              } catch {
                setOpening('error');
              }
            }}
          >
            {state === 'opening' && <Spinner aria-hidden="true" />}Open workspace
          </Button>
        )}
        {(state === 'error' || state === 'slow') && (
          <Button
            onClick={() => {
              setOpening(null);
              void read.refresh();
            }}
          >
            Check status again
          </Button>
        )}
        <p className="text-sm text-muted-foreground">You can leave this page. Setup continues in the background.</p>
        <p className="text-sm text-muted-foreground">Use the workspace menu to switch workspaces.</p>
      </StatePanel>
    </section>
  );
}
