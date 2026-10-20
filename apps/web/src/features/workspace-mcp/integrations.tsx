import { useState } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useMcpIntegrations, useMcpCatalog } from './queries';
import type { McpApi } from './api';
import type { Capabilities, CatalogEntry, Integration } from './contracts';
import { McpGate, McpRead } from './state';
import { McpSetup } from './setup';
import { McpIntegrationDetail } from './review';

export const integrationLabels: Record<Integration['status'], string> = {
  setup: 'Setup incomplete',
  'oauth-pending': 'Authorization pending',
  'registration-required': 'Client registration required',
  discovering: 'Discovering tools',
  'review-required': 'Tool review required',
  ready: 'Verified',
  disabled: 'Disabled',
  disconnected: 'Disconnected',
  error: 'Needs attention',
};
type View = { kind: 'list' } | { kind: 'setup'; entry?: CatalogEntry } | { kind: 'detail'; id: string };

export function WorkspaceMcpIntegrations({ workspaceId }: { workspaceId: string }) {
  return (
    <McpGate workspaceId={workspaceId}>
      {(api, capabilities) => <Integrations api={api} capabilities={capabilities} />}
    </McpGate>
  );
}
function Integrations({ api, capabilities }: { api: McpApi; capabilities: Capabilities }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const hash = useLocation({ select: location => location.hash });
  const navigate = useNavigate();
  const reconnectId = hash.startsWith('reauthorize-mcp-') ? hash.slice('reauthorize-mcp-'.length) : null;
  const [catalog, setCatalog] = useState(false);
  const read = useMcpIntegrations(api);
  return (
    <section aria-label="Custom MCP integrations" className="space-y-4 border-t pt-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-xl font-medium">Custom MCP integrations</h2>
          <p className="text-sm text-muted-foreground">
            Compatible remote tools for personal chats and named agent tasks. Connecting does not enable execution.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setCatalog(!catalog)}>
            {catalog ? 'Hide server catalog' : 'Find MCP servers'}
          </Button>
          <Button disabled={!capabilities.integrationsEnabled} onClick={() => setView({ kind: 'setup' })}>
            Add MCP endpoint
          </Button>
        </div>
      </header>
      {!capabilities.integrationsEnabled && (
        <Alert>
          <AlertDescription>
            New integrations are paused for this workspace. Existing integration status, revocation, and recovery remain
            available.
          </AlertDescription>
        </Alert>
      )}
      {!capabilities.dispatchEnabled && (
        <Alert>
          <AlertDescription>
            MCP execution is paused for this workspace. You can inspect receipts and reconcile unknown outcomes.
          </AlertDescription>
        </Alert>
      )}
      {catalog && (
        <Catalog
          api={api}
          disabled={!capabilities.integrationsEnabled}
          choose={entry => setView({ kind: 'setup', entry })}
        />
      )}
      <McpRead state={read.state} refresh={read.refresh} label="MCP integrations">
        {data =>
          data.integrations.length ? (
            <div className="space-y-4">
              {(['personal', 'shared'] as const).map(ownership => (
                <section key={ownership} className="space-y-2">
                  <h3 className="text-sm font-medium">
                    {ownership === 'personal' ? 'Your personal integrations' : 'Shared workspace integrations'}
                  </h3>
                  <ul className="divide-y">
                    {data.integrations
                      .filter(integration => integration.ownership === ownership)
                      .map(integration => (
                        <li
                          key={integration.id}
                          className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="break-all font-medium">{integration.name}</p>
                            <p className="break-all text-sm text-muted-foreground">
                              {integration.accountLabel ?? 'Account identity not verified'}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Badge variant={integration.status === 'ready' ? 'success' : 'secondary'}>
                                {integrationLabels[integration.status]}
                              </Badge>
                              {integration.barrier && <Badge variant="warning">Paused by unknown outcome</Badge>}
                            </div>
                          </div>
                          <Button variant="outline" onClick={() => setView({ kind: 'detail', id: integration.id })}>
                            Manage {integration.name}
                          </Button>
                        </li>
                      ))}
                  </ul>
                  {!data.integrations.some(integration => integration.ownership === ownership) && (
                    <p className="text-sm text-muted-foreground">
                      {ownership === 'personal'
                        ? 'No personal MCP integrations.'
                        : 'No shared MCP integrations available to you.'}
                    </p>
                  )}
                </section>
              ))}
            </div>
          ) : (
            <StatePanel
              kind="empty"
              heading="h3"
              title="No MCP integrations yet"
              description="Add a remote endpoint or find a server in the catalog. Verify authentication, review its tools, then select it explicitly in a personal chat or task."
            />
          )
        }
      </McpRead>
      {view.kind === 'setup' && (
        <McpSetup
          key={view.entry?.id ?? 'manual'}
          api={api}
          capabilities={capabilities}
          entry={view.entry}
          close={() => setView({ kind: 'list' })}
          saved={id => {
            setView({ kind: 'detail', id });
            void read.refresh();
          }}
        />
      )}
      {reconnectId ? (
        <McpIntegrationDetail
          key={reconnectId}
          api={api}
          capabilities={capabilities}
          id={reconnectId}
          reauthorize
          close={() => {
            void navigate({ hash: '', replace: true });
            void read.refresh();
          }}
        />
      ) : (
        view.kind === 'detail' && (
          <McpIntegrationDetail
            key={view.id}
            api={api}
            capabilities={capabilities}
            id={view.id}
            close={() => {
              setView({ kind: 'list' });
              void read.refresh();
            }}
          />
        )
      )}
    </section>
  );
}
function Catalog({ api, disabled, choose }: { api: McpApi; disabled: boolean; choose: (entry: CatalogEntry) => void }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState('');
  const read = useMcpCatalog(api, search, cursor);
  return (
    <section aria-label="MCP server catalog" className="space-y-4">
      <h3 className="text-lg font-medium">Find a remote server</h3>
      <p>
        Catalog inclusion is not a security review or a guarantee of compatibility. You can also discover servers on{' '}
        <a
          href="https://mcpservers.org/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-text underline underline-offset-4"
        >
          mcpservers.org
        </a>{' '}
        and enter their endpoints manually.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={event => {
          event.preventDefault();
          setSearch(query.trim());
          setCursor('');
        }}
      >
        <SearchField
          label="Search MCP Registry"
          value={query}
          onChange={value => {
            setQuery(value);
            if (!value) {
              setSearch('');
              setCursor('');
            }
          }}
          placeholder="Search remote MCP servers"
        />
        <Button type="submit" variant="outline">
          Search catalog
        </Button>
      </form>
      <McpRead state={read.state} refresh={read.refresh} label="MCP catalog">
        {data => (
          <>
            <p className="break-words text-sm text-muted-foreground">
              {data.source} · Snapshot {data.snapshotVersion} · Last sync{' '}
              {data.syncedAt ? new Date(data.syncedAt).toLocaleString() : 'not available'}
            </p>
            {data.stale && (
              <Alert>
                <AlertDescription>
                  The Registry snapshot is stale. These are the last successfully synced listings. Existing integrations
                  and manual endpoint setup remain available.
                </AlertDescription>
              </Alert>
            )}
            {data.entries.length ? (
              <ul className="divide-y">
                {data.entries.map(entry => (
                  <li key={entry.id} className="min-w-0 space-y-2 py-4">
                    <h4 className="break-all font-medium">{entry.name}</h4>
                    <p className="whitespace-pre-wrap break-words">{entry.description}</p>
                    <p className="break-all text-sm text-muted-foreground">
                      Version {entry.version} · {entry.endpoint}
                    </p>
                    <p className="text-sm">
                      {entry.compatibility === 'eligible'
                        ? 'Eligible remote transport; setup verification required'
                        : entry.compatibility === 'unknown'
                          ? 'Compatibility not verified'
                          : 'Unsupported'}
                      {entry.reason ? `. ${entry.reason}` : ''}
                    </p>
                    <Button
                      variant="outline"
                      disabled={disabled || entry.compatibility === 'unsupported'}
                      onClick={() => choose(entry)}
                    >
                      Set up {entry.name}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <StatePanel
                kind="empty"
                heading="h3"
                title="No matching remote servers"
                description="Try another search, or add an endpoint manually."
              >
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery('');
                    setSearch('');
                    setCursor('');
                  }}
                >
                  Clear search
                </Button>
              </StatePanel>
            )}
            {(cursor || data.nextCursor) && (
              <nav aria-label="MCP catalog pages" className="flex flex-wrap gap-2">
                {cursor && (
                  <Button variant="outline" onClick={() => setCursor('')}>
                    First catalog page
                  </Button>
                )}
                {data.nextCursor && (
                  <Button variant="outline" onClick={() => setCursor(data.nextCursor ?? '')}>
                    Next catalog page
                  </Button>
                )}
              </nav>
            )}
          </>
        )}
      </McpRead>
    </section>
  );
}
