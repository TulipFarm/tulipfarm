import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plug } from 'reicon-react/icons/Plug';
import { Button } from '@tulipfarm/sprout/button';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { McpGate } from '@/features/workspace-mcp/state';
import { McpSetup, sameEndpoint } from '@/features/workspace-mcp/setup';
import { integrationLabels } from '@/features/workspace-mcp/integrations';
import { useMcpIntegrations } from '@/features/workspace-mcp/queries';
import type { McpApi } from '@/features/workspace-mcp/api';
import type { Capabilities } from '@/features/workspace-mcp/contracts';
import type { IntegrationCardView } from './conversation-api';

type Proposal = Extract<IntegrationCardView, { action: 'mcp' }>;
const signIn = {
  oauth: 'Sign in with the provider',
  secrets: 'Saved secrets you choose',
  none: 'No sign-in',
} as const;

/** A chat's suggestion to connect a remote MCP server. The person sets it up here, as their own integration. */
export function McpConnectCard({ workspaceId, slug, card }: { workspaceId: string; slug: string; card: Proposal }) {
  return (
    <McpGate workspaceId={workspaceId}>
      {(api, capabilities) => <Connect api={api} capabilities={capabilities} slug={slug} card={card} />}
    </McpGate>
  );
}

function Connect({
  api,
  capabilities,
  slug,
  card,
}: {
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  card: Proposal;
}) {
  const read = useMcpIntegrations(api);
  const [open, setOpen] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const existing =
    read.state.kind === 'ready'
      ? read.state.data.integrations.find(
          integration => integration.ownership === 'personal' && sameEndpoint(integration.endpoint, card.endpoint),
        )
      : undefined;
  const id = savedId ?? existing?.id ?? null;
  return (
    <ReviewCard
      label={`Connect ${card.name}`}
      icon={<Plug size={14} />}
      title={`Connect ${card.name}`}
      badge={
        existing
          ? {
              label: integrationLabels[existing.status],
              variant: existing.status === 'ready' ? 'info' : existing.status === 'error' ? 'warning' : 'secondary',
            }
          : { label: 'Not connected', variant: 'secondary' }
      }
      settled={existing?.status === 'ready'}
      actions={
        id ? (
          <Button
            nativeButton={false}
            render={
              <Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: slug }} hash={`review-mcp-${id}`} />
            }
          >
            Review {card.name} tools
          </Button>
        ) : !open && capabilities.integrationsEnabled ? (
          <Button onClick={() => setOpen(true)}>Set up {card.name}</Button>
        ) : undefined
      }
      status={
        !capabilities.integrationsEnabled && !id ? (
          <p role="status" className="text-sm">
            New MCP integrations are paused in this workspace.
          </p>
        ) : id ? (
          <p role="status" className="text-sm">
            Review its tools, then select {card.name} in a chat to use it.
          </p>
        ) : undefined
      }
    >
      <ReviewRows>
        <ReviewRow label="Endpoint">
          <span className="break-all">{card.endpoint}</span>
        </ReviewRow>
        <ReviewRow label="Sign-in">{signIn[card.authentication]}</ReviewRow>
        <ReviewRow label="Who can use it">Only you</ReviewRow>
      </ReviewRows>
      {open && !id && (
        <McpSetup
          api={api}
          capabilities={capabilities}
          proposal={card}
          close={() => setOpen(false)}
          saved={next => {
            setSavedId(next);
            setOpen(false);
            void read.refresh();
          }}
        />
      )}
    </ReviewCard>
  );
}
