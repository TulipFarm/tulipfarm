import { useState, type ReactNode } from 'react';
import { useLinkProps } from '@tanstack/react-router';
import { workspaceModelsRoute } from '@/router';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { Compress } from 'reicon-react/icons/Compress';
import { Image } from 'reicon-react/icons/Image';
import { Key } from 'reicon-react/icons/Key';
import { useChatGptConnection } from './chatgpt-plan';
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

const providerBrands: Record<Subscription['provider'], Brand> = {
  chatgpt: 'openai',
  claude: 'claude',
  copilot: 'github',
};

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
  images,
  children,
}: {
  workspaceId: string;
  source: ModelSource;
  builtInCount: number | null;
  images: boolean;
  children: ReactNode;
}) {
  const chatGpt = useChatGptConnection(workspaceId);
  const { read } = useSubscriptions(workspaceId);
  const people = usePeople(workspaceId);
  const offered = !(chatGpt.state.kind === 'unavailable' || (chatGpt.state.kind === 'ready' && !chatGpt.state.data));
  const connection = chatGpt.state.kind === 'ready' ? chatGpt.state.data : null;
  const shared =
    read.state.kind === 'ready' ? read.state.data.filter(item => !item.mine && item.state !== 'signed-out') : [];
  const chatGptDetail =
    !connection || connection.state === 'not-connected' || connection.state === 'signed-out'
      ? 'Not connected'
      : connection.state === 'reconnect-required'
        ? 'Needs sign-in again'
        : connection.state === 'plan-disabled'
          ? 'Plan usage off'
          : (connection.email ?? 'Connected');
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
          {item(
            'claude',
            <Tile muted>
              <BrandIcon brand="claude" size="inline" />
            </Tile>,
            'Claude',
            'Coming soon',
          )}
          {item(
            'copilot',
            <Tile muted>
              <BrandIcon brand="github" size="inline" />
            </Tile>,
            'GitHub Copilot',
            'Coming soon',
          )}
        </RailGroup>
        {shared.length > 0 && (
          <RailGroup label="Shared with you">
            {shared.map(plan =>
              item(
                `plan:${plan.connectionId}`,
                <Tile>
                  <BrandIcon brand={providerBrands[plan.provider]} size="inline" />
                </Tile>,
                providerLabels[plan.provider],
                plan.state === 'connected'
                  ? `${people.name(plan.ownerMembershipId)}’s plan`
                  : planStates[plan.state].label,
              ),
            )}
          </RailGroup>
        )}
        <RailGroup label="API keys">
          {item(
            'keys',
            <Tile muted>
              <Key size={14} aria-hidden="true" />
            </Tile>,
            'Add API key',
            'Coming soon',
          )}
        </RailGroup>
        <RailGroup label="Settings">
          {item(
            'compaction',
            <Tile>
              <Compress size={14} aria-hidden="true" />
            </Tile>,
            'Compaction',
            'Summarize long chats',
          )}
          {images &&
            item(
              'images',
              <Tile>
                <Image size={14} aria-hidden="true" />
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
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-start gap-3">
        <BrandIcon brand={providerBrands[plan.provider]} size="sm" />
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-medium">
            {provider} plan
            <Badge variant={planStates[plan.state].variant}>{planStates[plan.state].label}</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">
            {people.name(plan.ownerMembershipId)}’s plan{plan.account ? ` · ${plan.account}` : ''}
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
        Your chats and agents can pick this plan’s models. Requests use {people.name(plan.ownerMembershipId)}’s{' '}
        {provider} usage, not workspace credits.
      </p>
      <PlanModels workspaceId={workspaceId} subscription={plan} people={people} />
      {sharing && (
        <ShareDialog workspaceId={workspaceId} subscription={plan} people={people} close={() => setSharing(false)} />
      )}
    </div>
  );
}

const comingSoon = {
  claude: {
    brand: 'claude',
    title: 'Claude plan',
    detail: 'Use your Claude plan for chats and agents. Requests will use your Claude usage, not workspace credits.',
  },
  copilot: {
    brand: 'github',
    title: 'GitHub Copilot plan',
    detail:
      'Use your GitHub Copilot plan’s models for chats and agents. Requests will use your Copilot usage, not workspace credits.',
  },
} as const satisfies Record<string, { brand: Brand; title: string; detail: string }>;

/** A plan provider TulipFarm doesn't support yet. */
export function ComingSoonPane({ provider }: { provider: keyof typeof comingSoon }) {
  const plan = comingSoon[provider];
  return (
    <div className="mx-auto grid max-w-md justify-items-center gap-3 py-12 text-center">
      <BrandIcon brand={plan.brand} size="lg" />
      <h2 className="flex items-center gap-2 text-lg font-medium">
        {plan.title} <Badge variant="secondary">Coming soon</Badge>
      </h2>
      <p className="text-sm text-muted-foreground">{plan.detail}</p>
    </div>
  );
}

const keyProviders: { name: string; brand: Brand | null; url: string | null }[] = [
  { name: 'OpenAI', brand: 'openai', url: 'https://platform.openai.com/api-keys' },
  { name: 'Anthropic', brand: 'claude', url: 'https://console.anthropic.com/settings/keys' },
  { name: 'Google AI Studio', brand: 'gemini', url: 'https://aistudio.google.com/apikey' },
  { name: 'OpenRouter', brand: null, url: 'https://openrouter.ai/keys' },
  { name: 'xAI', brand: 'grok', url: 'https://console.x.ai' },
  { name: 'Any OpenAI-compatible server', brand: null, url: null },
];

/** Bring-your-own API keys, not supported yet. */
export function ApiKeysPane() {
  return (
    <div className="grid gap-5">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-medium">
          API keys <Badge variant="secondary">Coming soon</Badge>
        </h2>
        <p className="text-sm text-muted-foreground">
          Soon you’ll be able to add your own key from an AI provider. Its models will appear in chats and agents, and
          requests will be billed to your provider account, not workspace credits.
        </p>
      </header>
      <ul className="divide-y rounded-md border px-3">
        {keyProviders.map(provider => (
          <li key={provider.name} className="flex items-center gap-3 py-2.5 text-sm">
            {provider.brand ? (
              <BrandIcon brand={provider.brand} size="inline" />
            ) : (
              <span className="text-muted-foreground">
                <Key size={14} aria-hidden="true" />
              </span>
            )}
            <span className="flex-1">{provider.name}</span>
            {provider.url && (
              <a
                href={provider.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Get a key <ArrowUpRight size={12} aria-hidden="true" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
