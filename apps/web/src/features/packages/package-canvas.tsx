import { useEffect, useRef } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { useCanvas, useResultAttention, type CanvasItem } from '@/features/chat/canvas-state';
import { InstallationOutline, installationVerified } from './progress';
import { PackageSuccess } from './package-surface';
import { usePackageInstallations } from './queries';

export function PackageCanvasButton({
  item,
  summary,
  autoOpen,
  foreground,
}: {
  item: CanvasItem;
  summary: string;
  autoOpen: boolean;
  foreground: boolean;
}) {
  const { activeId, show, update } = useCanvas();
  const observed = useRef(false);
  const updated = useRef('');
  const signature = JSON.stringify(item);
  useEffect(() => {
    if (updated.current === signature) return;
    updated.current = signature;
    update(item.id, { title: item.title, content: item.content });
  }, [item, signature, update]);
  useEffect(() => {
    if (observed.current) return;
    observed.current = true;
    if (autoOpen && foreground && !activeId && window.matchMedia('(min-width: 768px)').matches) show(item);
  }, [autoOpen, foreground, activeId, show, item]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-muted-foreground tabular-nums">{summary}</span>
      <Button variant="outline" size="sm" onClick={() => show(item)}>
        Open installation
      </Button>
    </div>
  );
}

export function PackageInstallationCanvas({
  workspaceId,
  chatId,
  installationId,
}: {
  workspaceId: string;
  chatId: string;
  installationId: string;
}) {
  const { read } = usePackageInstallations(workspaceId, chatId);
  const view =
    read.state.kind === 'ready'
      ? read.state.data.installations.find(installation => installation.id === installationId)
      : undefined;
  const outline = view ? (
    <InstallationOutline
      view={view}
      stale={
        read.state.kind === 'ready' && read.state.error
          ? 'Showing the last loaded installation. Refresh to see the latest progress.'
          : undefined
      }
    />
  ) : null;
  useResultAttention(`package:${installationId}`, view?.status === 'waiting-review', 'A package needs your review');
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Refresh installation
    </Button>
  );
  return (
    <CanvasSection>
      <ReadFeedback
        state={read.state}
        loading={
          <div role="status" aria-label="Loading installation">
            <Skeleton />
            <Skeleton />
          </div>
        }
        errorTitle="Could not load installation"
        retry={retry}
        unavailable={() => (
          <StatePanel
            kind="unavailable"
            title="Installation unavailable"
            description="Your access to this chat or workspace may have changed."
          />
        )}
        refreshError={message => <ReadError message={message}>{retry}</ReadError>}
      >
        {() =>
          view ? (
            <section aria-label="Package installation progress" className="space-y-4">
              {installationVerified(view) ? (
                <PackageSuccess id={`package-canvas-success-${view.id}`} title={view.package.title} details={outline} />
              ) : (
                <>
                  <h2 className="text-base font-medium">{view.package.title}</h2>
                  {outline}
                </>
              )}
            </section>
          ) : (
            <StatePanel
              kind="unavailable"
              title="Installation unavailable"
              description="This installation was not found in this chat."
            >
              {retry}
            </StatePanel>
          )
        }
      </ReadFeedback>
    </CanvasSection>
  );
}
