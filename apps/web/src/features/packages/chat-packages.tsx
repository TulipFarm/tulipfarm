import { createContext, useContext, useMemo, useState } from 'react';
import {
  marketplacePackage,
  marketplacePackagesInPrompt,
  type MarketplacePackage,
} from '@tulipfarm/config/package-links';
import { packagesInLayout } from '@tulipfarm/conversations/layout-contracts';
import type { SystemPackageInstallation } from '@tulipfarm/agents/system-package-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { useFeatureRead } from '@/lib/query';
import { workspaceChatRoute } from '@/router';
import { bundledPackage } from './catalog';
import { Installation, PackageOffer } from './installation-panel';
import { PackageCanvasButton } from './package-canvas';
import { usePackageInstallations } from './queries';
import { loadPublicPackage } from './public-catalog';
import type { CanvasItem } from '@/features/chat/canvas-state';

export function useChatPackages(
  workspaceId: string,
  chatId: string,
  enabled: boolean,
  prompts: readonly string[] = [],
  layouts: readonly unknown[] = [],
) {
  const routeChatId = workspaceChatRoute.useParams({ shouldThrow: false })?.chatId;
  const selectedPackage = workspaceChatRoute.useSearch({ shouldThrow: false })?.package;
  const offer = routeChatId === chatId && selectedPackage === 'leave-management';
  const [accepted, setAccepted] = useState<SystemPackageInstallation | null>(null);
  const { api, read } = usePackageInstallations(workspaceId, chatId, enabled);
  const installations = read.state.kind === 'ready' ? read.state.data.installations : [];
  const links =
    [...prompts]
      .reverse()
      .map(marketplacePackagesInPrompt)
      .find(entries => entries.length) ?? [];
  return {
    api,
    workspaceId,
    read,
    offer,
    accepted,
    setAccepted,
    links,
    embedded: new Set(layouts.flatMap(packagesInLayout).map(link => `${link.name}@${link.version}`)),
    active: enabled && (offer || links.length > 0 || installations.length > 0 || accepted?.chatId === chatId),
  };
}

export type PackageChatContextValue = {
  packages: ReturnType<typeof useChatPackages>;
  chatId: string;
  disabled: boolean;
  foreground: boolean;
};

export const PackageChatContext = createContext<PackageChatContextValue | null>(null);

export function PackageInstallationReply({ url, chatId }: { url: string; chatId: string }) {
  const context = useContext(PackageChatContext);
  const link = marketplacePackage(url);
  if (!context || context.chatId !== chatId || !link)
    return (
      <StatePanel
        kind="unavailable"
        title="Package review unavailable"
        description="Open this package in its private chat."
      />
    );
  return (
    <ChatPackages
      packages={context.packages}
      chatId={chatId}
      disabled={context.disabled}
      foreground={context.foreground}
      onlyPackage={link}
    />
  );
}

export function ChatPackages({
  packages,
  chatId,
  disabled,
  foreground,
  onlyPackage,
}: PackageChatContextValue & { onlyPackage?: MarketplacePackage }) {
  const { api, read, accepted, setAccepted, workspaceId } = packages;
  const included = (name: string, version: string) =>
    onlyPackage
      ? name === onlyPackage.name && version === onlyPackage.version
      : !packages.embedded.has(`${name}@${version}`);
  const links = onlyPackage ? [onlyPackage] : packages.links.filter(link => included(link.name, link.version));
  const offer = !onlyPackage && packages.offer && included(bundledPackage.package.name, bundledPackage.package.version);
  const saved =
    read.state.kind === 'ready' && read.state.data.installations.length
      ? read.state.data.installations
      : accepted?.chatId === chatId
        ? [accepted]
        : [];
  const installations = saved.filter(view => included(view.package.name, view.package.version));
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
  if (!onlyPackage && packages.embedded.size && !installations.length && !links.length && !offer) return null;
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
        const publicOffers = links.filter(
          link => !installations.some(view => view.package.name === link.name && view.package.version === link.version),
        );
        return (
          <div className="space-y-6">
            {installations.map(view => (
              <section key={view.id} aria-label={`${view.package.title} installation`} className="space-y-4">
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
            {publicOffers.map(link => (
              <PublicPackageOffer
                key={`${chatId}:${link.url}`}
                link={link}
                packages={packages}
                chatId={chatId}
                disabled={disabled || (read.state.kind === 'ready' && read.state.error !== null)}
                foreground={foreground}
              />
            ))}
            {installations.length === 0 && links.length === 0 && offer && (
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
            )}
          </div>
        );
      }}
    </ReadFeedback>
  );
}

function PublicPackageOffer({
  link,
  packages,
  chatId,
  disabled,
  foreground,
}: {
  link: MarketplacePackage;
  packages: ReturnType<typeof useChatPackages>;
  chatId: string;
  disabled: boolean;
  foreground: boolean;
}) {
  const read = useFeatureRead({
    key: ['public-package', link.name, link.version],
    load: signal => loadPublicPackage(link.name, link.version, signal),
    staleTime: 5 * 60_000,
  });
  return (
    <section aria-label={`${link.name} package review`} className="space-y-3">
      <ReadFeedback
        state={read.state}
        errorTitle="Could not load package for review"
        retry={
          <Button variant="outline" onClick={() => void read.refresh()}>
            Retry package
          </Button>
        }
        loading={
          <div role="status" aria-label="Loading package review">
            <Skeleton />
          </div>
        }
        unavailable={() => (
          <StatePanel
            kind="unavailable"
            heading="h3"
            title="Package unavailable"
            description="This package version is not available in the marketplace."
          />
        )}
        refreshError={message => <ReadError message={message} />}
      >
        {({ document, source }) => (
          <PackageOffer
            key={`${chatId}:${source}`}
            api={packages.api}
            refresh={packages.read.refresh}
            document={document}
            chatId={chatId}
            installed={packages.setAccepted}
            disabled={disabled || (read.state.kind === 'ready' && read.state.error !== null)}
            progress={order => (
              <PackageCanvasButton
                item={{
                  id: `package:${chatId}:${document.package.name}:${document.package.version}`,
                  title: document.package.title,
                  content: { kind: 'package-plan', document, order },
                }}
                summary={`${document.resources.length} resources, followed by verification`}
                autoOpen={false}
                foreground={foreground}
              />
            )}
          />
        )}
      </ReadFeedback>
    </section>
  );
}
