import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plug } from 'reicon-react/icons/Plug';
import { Button } from '@tulipfarm/sprout/button';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Input } from '@tulipfarm/sprout/input';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { McpGate, useMcpCommand } from '@/features/workspace-mcp/state';
import { McpSetup } from '@/features/workspace-mcp/setup';
import { connectionFor, mcpStatusLabel, useMcpConnect, type Ownership } from '@/features/workspace-mcp/connect';
import { useMcpIntegration, useMcpIntegrations } from '@/features/workspace-mcp/queries';
import { markMcpConnected, takeMcpConnected } from '@/features/workspace-mcp/sign-in';
import type { McpApi } from '@/features/workspace-mcp/api';
import type { Capabilities, Integration } from '@/features/workspace-mcp/contracts';
import { mcpPagePrefix } from '@/features/integrations/mcp-apps';
import { useFlag } from '@/lib/feature-flags';
import type { IntegrationCardView } from './conversation-api';

type Proposal = Extract<IntegrationCardView, { action: 'mcp' }>;
type PackageProposal = Extract<IntegrationCardView, { action: 'mcp-package' }>;
const owners: Record<Ownership, string> = { personal: 'Only you', shared: 'Everyone in this workspace' };

/** A chat's suggestion to connect a remote MCP server. One click connects it and opens the provider's sign-in. */
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
  const [ownership, setOwnership] = useState<Ownership>('personal');
  const existing = read.state.kind === 'ready' ? connectionFor(read.state.data.integrations, card.endpoint) : undefined;
  const {
    connect: run,
    command,
    current,
    registration,
    clientId,
    setClientId,
    clientSecret,
    setClientSecret,
  } = useMcpConnect({
    api,
    name: card.name,
    endpoint: card.endpoint,
    authentication: card.authentication === 'none' ? 'none' : 'oauth',
    existing,
    refresh: read.refresh,
  });
  const connect = () => (card.authentication === 'secrets' ? setOpen(true) : run(ownership));
  if (existing && !registration && !['setup', 'oauth-pending', 'registration-required'].includes(existing.status))
    return <Connected api={api} slug={slug} name={card.name} integration={existing} />;
  return (
    <ReviewCard
      label={`Connect ${card.name}`}
      icon={<Plug size={14} />}
      title={`Connect ${card.name}`}
      badge={{ label: registration ? 'One more step' : 'Suggested', variant: 'secondary' }}
      actions={
        capabilities.integrationsEnabled && !open ? (
          <Button aria-busy={command.busy} disabled={command.busy} onClick={connect}>
            {command.busy ? 'Connecting…' : registration ? 'Continue' : `Connect ${card.name}`}
          </Button>
        ) : undefined
      }
      status={
        !capabilities.integrationsEnabled ? (
          <p role="status" className="text-sm">
            An admin has paused new connections in this workspace.
          </p>
        ) : command.state.kind === 'error' ? (
          <p role="alert" className="text-sm text-destructive">
            {command.state.message}
          </p>
        ) : undefined
      }
    >
      <ReviewRows>
        <ReviewRow label="Sign-in">
          {card.authentication === 'oauth'
            ? `Your ${card.name} account`
            : card.authentication === 'none'
              ? 'None needed'
              : 'A saved secret'}
        </ReviewRow>
        <ReviewRow label="Who can use it">
          {capabilities.canManageShared && !current ? (
            <ToggleGroup
              aria-label="Who can use it"
              value={[ownership]}
              onValueChange={(value: string[]) => {
                const next = value[0];
                if (next === 'personal' || next === 'shared') setOwnership(next);
              }}
            >
              <ToggleGroupItem value="personal">{owners.personal}</ToggleGroupItem>
              <ToggleGroupItem value="shared">Everyone</ToggleGroupItem>
            </ToggleGroup>
          ) : (
            owners[current?.ownership ?? 'personal']
          )}
        </ReviewRow>
      </ReviewRows>
      {ownership === 'shared' && !current && (
        <p className="text-sm text-muted-foreground">
          Everyone will use the {card.name} account you sign in with, so pick one that only sees what the whole team
          should.
        </p>
      )}
      {registration && (
        <section aria-label={`Connect your own ${card.name} app`} className="space-y-3 text-sm">
          <p>
            {card.name} doesn't let apps connect automatically. Create an OAuth app in {card.name}, set its callback URL
            to the one below, then paste the client ID here.
          </p>
          <p className="break-all font-mono">{registration.registration.redirectUri}</p>
          <Input
            aria-label="Client ID"
            placeholder="Client ID"
            autoComplete="off"
            value={clientId}
            onChange={event => setClientId(event.target.value)}
          />
          <Input
            aria-label="Client secret, if your app has one"
            placeholder="Client secret, if your app has one"
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={event => setClientSecret(event.target.value)}
          />
        </section>
      )}
      {open && (
        <McpSetup
          api={api}
          capabilities={capabilities}
          proposal={card}
          ownership={ownership}
          close={() => setOpen(false)}
          saved={next => {
            markMcpConnected(next);
            setOpen(false);
            void read.refresh();
          }}
        />
      )}
    </ReviewCard>
  );
}

/** A connection that exists. It shows "Connected" once tools are on, and offers one click for anything else. */
function Connected({
  api,
  slug,
  name,
  integration,
}: {
  api: McpApi;
  slug: string;
  name: string;
  integration: Integration;
}) {
  const detail = useMcpIntegration(api, integration.id);
  const command = useMcpCommand();
  const [justConnected] = useState(() => takeMcpConnected() === integration.id);
  const state = detail.state.kind === 'ready' ? detail.state.data : null;
  const live = state?.integration ?? integration;
  const turnOn = () =>
    state &&
    void command.run(
      () =>
        api.integrationCommand(live.id, 'tools', {
          requestId: crypto.randomUUID(),
          expectedVersion: live.version,
          tools: state.tools.map(tool => ({
            name: tool.name,
            revision: tool.revision,
            enabled: tool.compatibility === 'compatible',
            standingException: tool.standingException,
          })),
        }),
      () => void detail.refresh(),
    );
  const ready = live.status === 'ready';
  const manage = (
    <Button
      variant="outline"
      nativeButton={false}
      render={
        <Link
          to="/$workspaceSlug/integrations/$integrationId"
          params={{ workspaceSlug: slug, integrationId: `${mcpPagePrefix}${live.id}` }}
        />
      }
    >
      Manage
    </Button>
  );
  return (
    <ReviewCard
      label={`${name} connection`}
      icon={<Plug size={14} />}
      title={name}
      badge={
        ready
          ? { label: 'Connected', variant: 'info' }
          : live.status === 'discovering'
            ? { label: 'Connecting', variant: 'secondary' }
            : { label: mcpStatusLabel[live.status], variant: live.status === 'error' ? 'warning' : 'secondary' }
      }
      settled={ready}
      actions={
        live.status === 'review-required' && live.canManage ? (
          <Button aria-busy={command.busy} disabled={command.busy || !state} onClick={turnOn}>
            Turn on {name}
          </Button>
        ) : (
          manage
        )
      }
      status={
        <p role={command.state.kind === 'error' ? 'alert' : 'status'} className="text-sm">
          {command.state.kind === 'error'
            ? command.state.message
            : ready
              ? `${justConnected ? `${name} is connected. ` : ''}Ask away. Anything that changes data in ${name} still asks you first.`
              : live.status === 'discovering'
                ? `Getting ${name} ready…`
                : live.status === 'review-required'
                  ? `${name} is connected, but its tools are off.`
                  : (live.statusReason ?? `Open Manage to fix ${name}.`)}
        </p>
      }
    />
  );
}

/**
 * A chat's suggestion to run an npm or PyPI MCP package in a sandbox. Nothing is installed until the person
 * reviews the package and its settings and submits the form.
 */
export function McpPackageCard({
  workspaceId,
  slug,
  card,
}: {
  workspaceId: string;
  slug: string;
  card: PackageProposal;
}) {
  return (
    <McpGate workspaceId={workspaceId}>
      {(api, capabilities) => <ConnectPackage api={api} capabilities={capabilities} slug={slug} card={card} />}
    </McpGate>
  );
}

function ConnectPackage({
  api,
  capabilities,
  slug,
  card,
}: {
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  card: PackageProposal;
}) {
  const flag = useFlag('hosted-mcp');
  const read = useMcpIntegrations(api);
  const [open, setOpen] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const available = flag && capabilities.hosted && capabilities.integrationsEnabled;
  const existing =
    read.state.kind === 'ready'
      ? read.state.data.integrations.find(
          integration =>
            integration.ownership === 'personal' &&
            integration.package?.registry === card.package.registry &&
            integration.package.name === card.package.name,
        )
      : undefined;
  const id = savedId ?? existing?.id ?? null;
  const secrets = card.settings.filter(setting => setting.secret);
  const plain = card.settings.filter(setting => !setting.secret);
  const command = useMcpCommand();
  const needsValues = card.settings.some(setting => setting.secret || setting.required);
  const install = () => {
    if (needsValues) return setOpen(true);
    void command.run(
      async () => {
        const result = await api.setup({
          requestId: crypto.randomUUID(),
          name: card.name,
          package: card.package,
          egress: card.egress,
          ownership: 'personal',
          auth: { kind: 'hosted', env: [] },
        });
        markMcpConnected(result.integration.id);
        setSavedId(result.integration.id);
        await read.refresh();
      },
      () => {},
    );
  };
  if (existing) return <Connected api={api} slug={slug} name={card.name} integration={existing} />;
  return (
    <ReviewCard
      label={`Run ${card.name}`}
      icon={<Plug size={14} />}
      title={`Run ${card.name}`}
      badge={{ label: 'Suggested', variant: 'secondary' }}
      actions={
        !id && !open && available ? (
          <Button aria-busy={command.busy} disabled={command.busy} onClick={install}>
            {command.busy ? 'Installing…' : needsValues ? `Set up ${card.name}` : `Install ${card.name}`}
          </Button>
        ) : undefined
      }
      status={
        !available && !id ? (
          <p role="status" className="text-sm">
            Running MCP packages is not available in this workspace.
          </p>
        ) : command.state.kind === 'error' ? (
          <p role="alert" className="text-sm text-destructive">
            {command.state.message}
          </p>
        ) : id ? (
          <p role="status" className="text-sm">
            Installing {card.name}…
          </p>
        ) : undefined
      }
    >
      <ReviewRows>
        <ReviewRow label="Package">
          <span className="break-all font-mono">
            {card.package.registry === 'npm' ? 'npm' : 'PyPI'} · {card.package.name}
          </span>
        </ReviewRow>
        <ReviewRow label="Version">{card.package.version}</ReviewRow>
        <ReviewRow label="Settings">
          {plain.length ? (
            <span className="break-all font-mono">{plain.map(item => item.name).join(', ')}</span>
          ) : (
            'None'
          )}
        </ReviewRow>
        <ReviewRow label="Secrets">
          {secrets.length ? (
            <span>
              <span className="break-all font-mono">{secrets.map(item => item.name).join(', ')}</span>. Protected by
              default: the package never sees the value unless you let it.
            </span>
          ) : (
            'None'
          )}
        </ReviewRow>
        <ReviewRow label="Can reach">
          {card.egress.length ? (
            <span className="break-all font-mono">{card.egress.join(', ')}</span>
          ) : (
            'Only the websites of the secrets you choose'
          )}
        </ReviewRow>
        <ReviewRow label="Who can use it">Only you</ReviewRow>
      </ReviewRows>
      {open && !id && (
        <McpSetup
          api={api}
          capabilities={capabilities}
          packageProposal={card}
          close={() => setOpen(false)}
          saved={next => {
            markMcpConnected(next);
            setSavedId(next);
            setOpen(false);
            void read.refresh();
          }}
        />
      )}
    </ReviewCard>
  );
}
