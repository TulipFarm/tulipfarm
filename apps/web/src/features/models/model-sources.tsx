import { useState, type ReactNode } from 'react';
import { useLinkProps } from '@tanstack/react-router';
import { workspaceModelsRoute } from '@/router';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { ImageIcon, KeyIcon, MinimizeIcon } from '@tulipfarm/icons';
import { isByokProvider } from './byok-plan-api';
import { useChatGptConnection, useTokenConnection } from './plan-connections';
import type { TokenConnection } from './token-plan-api';
import {
  PlanModels,
  ShareDialog,
  audience,
  planStates,
  providerLabels,
  usePeople,
  useSubscriptions,
  type Subscription,
} from './subscription-sharing';

export { ApiKeysPane } from './byok-keys-pane';

/** What the Models page shows on the right: one model source, or a workspace setting. */
export type ModelSource =
  | 'access'
  | 'chatgpt'
  | 'claude'
  | 'copilot'
  | 'keys'
  | 'compaction'
  | 'images'
  | `plan:${string}`;

const providerBrands: Record<Subscription['provider'], Brand | null> = {
  chatgpt: 'openai',
  claude: 'claude',
  copilot: 'github',
  'byok-anthropic': 'claude',
  'byok-openai': 'openai',
  'byok-google': 'gemini',
  'byok-xai': 'grok',
  'byok-openai-compatible': null,
};

function ProviderMark({ provider, size }: { provider: Subscription['provider']; size: 'inline' | 'sm' }) {
  const brand = providerBrands[provider];
  return brand ? <BrandIcon brand={brand} size={size} /> : <KeyIcon size="sm" aria-hidden="true" />;
}

function Tile({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={`grid size-7 shrink-0 place-items-center rounded-md border bg-background ${muted ? 'opacity-50' : ''}`}
    >
      {children}
    </span>
  );
}

function RailItem({
  id,
  selected,
  icon,
  label,
  detail,
}: {
  id: ModelSource;
  selected: boolean;
  icon: ReactNode;
  label: string;
  detail: ReactNode;
}) {
  const link = useLinkProps({
    from: workspaceModelsRoute.fullPath,
    to: '.',
    search: { tab: id === 'access' ? undefined : id },
    replace: true,
  });
  return (
    <a
      {...link}
      aria-current={selected ? 'page' : undefined}
      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'bg-muted' : 'hover:bg-muted/50'}`}
    >
      {icon}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </a>
  );
}

function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <p className="px-3 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/**
 * The Models page layout: a rail of model sources (TulipFarm's models, AI plans, API keys) and workspace settings on
 * the left, and the selected one's details on the right.
 */
export function ModelSources({
  workspaceId,
  source,
  builtInCount,
  children,
}: {
  workspaceId: string;
  source: ModelSource;
  builtInCount: number | null;
  children: ReactNode;
}) {
  const chatGpt = useChatGptConnection(workspaceId);
  const { read } = useSubscriptions(workspaceId);
  const people = usePeople(workspaceId);
  const offered = !(chatGpt.state.kind === 'unavailable' || (chatGpt.state.kind === 'ready' && !chatGpt.state.data));
  const shared =
    read.state.kind === 'ready' ? read.state.data.filter(item => !item.mine && item.state !== 'signed-out') : [];
  const ownKeys =
    read.state.kind === 'ready'
      ? read.state.data.filter(item => item.mine && isByokProvider(item.provider) && item.state !== 'signed-out')
      : [];
  const keysDetail =
    read.state.kind === 'loading'
      ? 'Checking…'
      : ownKeys.length === 0
        ? 'Not connected'
        : ownKeys.some(item => item.state === 'reconnect-required')
          ? 'Needs reconnect'
          : ownKeys.length === 1
            ? (ownKeys[0]?.account ?? '1 key connected')
            : `${ownKeys.length} keys connected`;
  const chatGptDetail =
    chatGpt.state.kind === 'loading'
      ? 'Checking…'
      : railDetail(
          chatGpt.state.kind === 'ready' ? (chatGpt.state.data?.connections ?? []) : [],
          connection => connection.email,
        );
  const claude = useTokenConnection(workspaceId, 'claude');
  const copilot = useTokenConnection(workspaceId, 'copilot');
  const tokenRail = (
    id: 'claude' | 'copilot',
    read: typeof claude,
    brand: Brand,
    label: string,
    account: (connection: TokenConnection) => string | null,
  ) => {
    if (read.state.kind === 'unavailable' || (read.state.kind === 'ready' && !read.state.data)) return null;
    const detail =
      read.state.kind === 'loading'
        ? 'Checking…'
        : railDetail(read.state.kind === 'ready' ? (read.state.data?.connections ?? []) : [], account);
    return item(
      id,
      <Tile muted={detail === 'Not connected'}>
        <BrandIcon brand={brand} size="inline" />
      </Tile>,
      label,
      detail,
    );
  };
  const item = (id: ModelSource, icon: ReactNode, label: string, detail: ReactNode) => (
    <RailItem key={id} id={id} selected={source === id} icon={icon} label={label} detail={detail} />
  );
  return (
    <div className="rounded-lg border md:flex md:min-h-140">
      <nav
        aria-label="Model sources"
        className="grid shrink-0 content-start gap-4 border-b p-2 md:w-62 md:border-r md:border-b-0"
      >
        {item(
          'access',
          <Tile>
            <img src="/favicon.svg" alt="" className="size-4" />
          </Tile>,
          'TulipFarm',
          builtInCount === null
            ? 'Workspace credits'
            : `${builtInCount} ${builtInCount === 1 ? 'model' : 'models'} · Workspace credits`,
        )}
        <RailGroup label="Your plans">
          {offered &&
            item(
              'chatgpt',
              <Tile muted={chatGptDetail === 'Not connected'}>
                <BrandIcon brand="openai" size="inline" />
              </Tile>,
              'ChatGPT',
              chatGptDetail,
            )}
          {tokenRail('claude', claude, 'claude', 'Claude', connection => connection.account)}
          {tokenRail('copilot', copilot, 'github', 'GitHub Copilot', connection =>
            connection.account ? `@${connection.account}` : null,
          )}
        </RailGroup>
        {shared.length > 0 && (
          <RailGroup label="Shared with you">
            {shared.map(plan =>
              item(
                `plan:${plan.connectionId}`,
                <Tile>
                  <ProviderMark provider={plan.provider} size="inline" />
                </Tile>,
                providerLabels[plan.provider],
                plan.state === 'connected'
                  ? `${people.name(plan.ownerMembershipId)}’s ${isByokProvider(plan.provider) ? 'key' : 'plan'}`
                  : planStates[plan.state].label,
              ),
            )}
          </RailGroup>
        )}
        <RailGroup label="API keys">
          {item(
            'keys',
            <Tile muted={ownKeys.length === 0}>
              <KeyIcon size="sm" aria-hidden="true" />
            </Tile>,
            'API keys',
            keysDetail,
          )}
        </RailGroup>
        <RailGroup label="Settings">
          {item(
            'compaction',
            <Tile>
              <MinimizeIcon size="sm" aria-hidden="true" />
            </Tile>,
            'Compaction',
            'Summarize long chats',
          )}
          {item(
            'images',
            <Tile>
              <ImageIcon size="sm" aria-hidden="true" />
            </Tile>,
            'Images',
            'Image models and limits',
          )}
        </RailGroup>
      </nav>
      <div className="min-w-0 flex-1 p-4 md:p-6">{children}</div>
    </div>
  );
}

/** A plan another member connected and shared with the signed-in member. */
export function SharedPlanPane({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }) {
  const { read } = useSubscriptions(workspaceId);
  const people = usePeople(workspaceId);
  const [sharing, setSharing] = useState(false);
  if (read.state.kind !== 'ready') return null;
  const plan = read.state.data.find(item => item.connectionId === connectionId);
  if (!plan) return <p className="text-sm text-muted-foreground">This plan is no longer shared with you.</p>;
  const provider = providerLabels[plan.provider];
  const noun = isByokProvider(plan.provider) ? 'key' : 'plan';
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-start gap-3">
        <ProviderMark provider={plan.provider} size="sm" />
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-medium">
            {isByokProvider(plan.provider) ? provider : `${provider} plan`}
            <Badge variant={planStates[plan.state].variant}>{planStates[plan.state].label}</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">
            {people.name(plan.ownerMembershipId)}’s {noun}
            {plan.account ? ` · ${plan.account}` : ''}
          </p>
          {plan.grants && <p className="text-sm text-muted-foreground">Shared with: {audience(plan.grants, people)}</p>}
        </div>
        {plan.canShare && (
          <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
            Share
          </Button>
        )}
      </header>
      <p className="text-sm text-muted-foreground">
        Use this {noun}’s models in your chats. Usage counts against {people.name(plan.ownerMembershipId)}’s {provider}
        {isByokProvider(plan.provider) ? '' : ' plan'}, not workspace credits.
      </p>
      <PlanModels workspaceId={workspaceId} subscription={plan} people={people} />
      {sharing && (
        <ShareDialog workspaceId={workspaceId} subscription={plan} people={people} close={() => setSharing(false)} />
      )}
    </div>
  );
}

/** A provider's rail line: the one account, or how many, and whether any needs sign-in again. */
function railDetail<T extends { state: string }>(connections: readonly T[], account: (connection: T) => string | null) {
  const live = connections.filter(item => item.state !== 'not-connected' && item.state !== 'signed-out');
  if (!live.length) return 'Not connected';
  if (live.some(item => item.state === 'reconnect-required')) return 'Needs sign-in again';
  if (live.length > 1) return `${live.length} accounts`;
  const [only] = live;
  if (only?.state === 'plan-disabled') return 'Plan usage off';
  return (only && account(only)) ?? 'Connected';
}
