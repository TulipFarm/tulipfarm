import { useMemo, useState } from 'react';
import type { SystemPackageInstallation } from '@tulipfarm/agents/system-package-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { workspaceChatRoute } from '@/router';
import { bundledPackage } from './catalog';
import { Installation, PackageOffer } from './installation-panel';
import { PackageCanvasButton } from './package-canvas';
import { usePackageInstallations } from './queries';
import type { CanvasItem } from '@/features/chat/canvas-state';

export function useChatPackages(workspaceId: string, chatId: string, enabled: boolean) {
  const routeChatId = workspaceChatRoute.useParams({ shouldThrow: false })?.chatId;
  const selectedPackage = workspaceChatRoute.useSearch({ shouldThrow: false })?.package;
  const offer = routeChatId === chatId && selectedPackage === 'leave-management';
  const [accepted, setAccepted] = useState<SystemPackageInstallation | null>(null);
  const { api, read } = usePackageInstallations(workspaceId, chatId, enabled);
  const installations = read.state.kind === 'ready' ? read.state.data.installations : [];
  return {
    api,
    workspaceId,
    read,
    offer,
    accepted,
    setAccepted,
    active: enabled && (offer || installations.length > 0 || accepted?.chatId === chatId),
  };
}

export function ChatPackages({
  packages,
  chatId,
  disabled,
  foreground,
}: {
  packages: ReturnType<typeof useChatPackages>;
  chatId: string;
  disabled: boolean;
  foreground: boolean;
}) {
  const { api, read, offer, accepted, setAccepted, workspaceId } = packages;
  const installations =
    read.state.kind === 'ready' && read.state.data.installations.length
      ? read.state.data.installations
      : accepted?.chatId === chatId
        ? [accepted]
        : [];
  const items = useMemo(
    () =>
      new Map(
        installations.map(view => [
          view.id,
          {
            id: `package:${chatId}:${view.package.name}`,
            title: view.package.title,
            content: { kind: 'package-installation', workspaceId, chatId, installationId: view.id },
          } satisfies CanvasItem,
        ]),
      ),
    [installations, workspaceId, chatId],
  );
  const offerItem = useMemo<CanvasItem>(
    () => ({
      id: `package:${chatId}:${bundledPackage.package.name}`,
      title: bundledPackage.package.title,
      content: { kind: 'package-plan', document: bundledPackage },
    }),
    [chatId],
  );
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Refresh packages
    </Button>
  );
  return (
    <ReadFeedback
      state={read.state}
      errorTitle="Could not load packages for this chat"
      retry={retry}
      loading={
        offer ? (
          <div role="status" aria-label="Loading package">
            <Skeleton />
            <Skeleton />
          </div>
        ) : null
      }
      unavailable={() => (
        <StatePanel
          kind="unavailable"
          title="Packages unavailable"
          description="Your access to this chat or workspace may have changed."
        >
          {retry}
        </StatePanel>
      )}
      refreshError={message => <ReadError message={message}>{retry}</ReadError>}
    >
      {() => {
        return installations.length ? (
          <div className="space-y-6">
            {installations.map(view => (
              <section key={view.id} aria-label={`${view.package.title} installation`} className="space-y-4">
                <h2 className="text-base font-medium">{view.package.title}</h2>
                <Installation
                  view={view}
                  api={api}
                  refresh={read.refresh}
                  stale={disabled || (read.state.kind === 'ready' && read.state.error !== null)}
                  progress={
                    <PackageCanvasButton
                      item={items.get(view.id)!}
                      summary={`${view.nodes.filter(node => node.state === 'completed').length} of ${view.nodes.length} steps complete`}
                      autoOpen={accepted?.id === view.id}
                      foreground={foreground}
                    />
                  }
                />
              </section>
            ))}
          </div>
        ) : offer ? (
          <PackageOffer
            key={chatId}
            api={api}
            refresh={read.refresh}
            document={bundledPackage}
            chatId={chatId}
            installed={setAccepted}
            progress={order => (
              <PackageCanvasButton
                item={{ ...offerItem, content: { kind: 'package-plan', document: bundledPackage, order } }}
                summary={`${bundledPackage.resources.length} resources, followed by verification`}
                autoOpen
                foreground={foreground}
              />
            )}
            disabled={disabled || (read.state.kind === 'ready' && read.state.error !== null)}
          />
        ) : null;
      }}
    </ReadFeedback>
  );
}
