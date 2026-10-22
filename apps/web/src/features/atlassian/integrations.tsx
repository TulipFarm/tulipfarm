import { useRef, useState } from 'react';
import type { IntegrationCollaborators } from '@/lib/integrations';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { atlassianApi, atlassianError, type AccountList, type SourceList } from '@/lib/atlassian';
import {
  useAtlassianAccounts,
  useAtlassianSources,
  useAtlassianCatalog,
  useIntegrationAdministration,
  useIntegrationChanges,
} from '@/features/integrations/queries';
import { AccountRow, AccountSetup } from './accounts';
import { SourceSetup } from './sources';
import { Operations } from './operations';
import { ProviderResult } from './result';

type Collection<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: T };
type Administration =
  | { kind: 'loading' }
  | { kind: 'member' }
  | { kind: 'error' }
  | { kind: 'admin'; data: IntegrationCollaborators };

export function AtlassianIntegrations({
  workspaceId,
  product,
}: {
  workspaceId: string;
  product: 'jira' | 'confluence' | 'trello';
}) {
  const accountRead = useAtlassianAccounts(workspaceId);
  const sourceRead = useAtlassianSources(workspaceId);
  const adminRead = useIntegrationAdministration(workspaceId);
  const changes = useIntegrationChanges();
  const accounts: Collection<AccountList> =
    accountRead.state.kind === 'unavailable'
      ? { kind: 'error', message: 'Account access is unavailable.' }
      : accountRead.state;
  const sources: Collection<SourceList> =
    sourceRead.state.kind === 'unavailable'
      ? { kind: 'error', message: 'Source access is unavailable.' }
      : sourceRead.state;
  const admin: Administration =
    adminRead.state.kind === 'ready'
      ? adminRead.state.error
        ? { kind: 'error' }
        : { kind: 'admin', data: adminRead.state.data }
      : { kind: adminRead.state.kind === 'unavailable' ? 'member' : adminRead.state.kind };
  const refreshing = [accountRead, sourceRead, adminRead].some(
    read => read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing),
  );
  const accountError = accountRead.state.kind === 'ready' ? accountRead.state.error : null;
  const sourceError = sourceRead.state.kind === 'ready' ? sourceRead.state.error : null;
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalogId, setCatalogId] = useState<string | null>(null);
  const catalogRead = useAtlassianCatalog(workspaceId, catalogId);
  const catalog =
    catalogRead.state.kind === 'ready' ? { sourceId: catalogId, data: catalogRead.state.data.data } : undefined;
  const [disableId, setDisableId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [history, setHistory] = useState(false);
  const actionLock = useRef(false);
  const refresh = async () => {
    await Promise.all([accountRead.refresh(), sourceRead.refresh(), adminRead.refresh()]);
  };
  async function sourceAction(id: string, action: 'disable' | 'discover') {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(id);
    setActionMessage(null);
    try {
      if (action === 'disable') {
        await atlassianApi.disableSource(workspaceId, id);
        setCatalogId(null);
        await changes.authority('atlassian');
        setDisableId(null);
        setActionMessage('Source disabled. Pending writes using it cannot execute.');
      } else {
        if (catalogId === id) await catalogRead.refresh();
        else setCatalogId(id);
      }
    } catch (error) {
      setActionMessage(atlassianError(error));
    } finally {
      actionLock.current = false;
      setBusy(null);
    }
  }
  const available = accounts.kind === 'ready' && sources.kind === 'ready' && !accountError && !sourceError;
  const usableSources =
    sources.kind === 'ready' && accounts.kind === 'ready'
      ? sources.data.sources.filter(source =>
          accounts.data.accounts.some(
            account =>
              account.id === source.accountId &&
              account.capabilities.use &&
              account.configured &&
              account.state === 'active',
          ),
        )
      : [];
  const productAccounts =
    accounts.kind === 'ready'
      ? accounts.data.accounts.filter(
          account => account.protocol === (product === 'trello' ? 'trello' : 'atlassian-mcp'),
        )
      : [];
  const connected = productAccounts.filter(account => account.state === 'active' || account.state === 'refreshing');
  const unfinished = productAccounts.filter(account => account.state !== 'active' && account.state !== 'refreshing');
  return (
    <section
      className="min-w-0 space-y-6 border-t border-border pt-6 text-foreground"
      aria-labelledby="atlassian-heading"
    >
      <h2 id="atlassian-heading" className="sr-only">
        {product === 'trello' ? 'Trello integration' : 'Jira and Confluence integration'}
      </h2>
      {accounts.kind === 'loading' && (
        <div role="status" className="space-y-3">
          <p>Loading Atlassian accounts…</p>
          <Skeleton />
          <Skeleton />
        </div>
      )}
      {accounts.kind === 'error' && (
        <StatePanel kind="error" title="Could not load Atlassian accounts" description={accounts.message}>
          <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>
            Retry Atlassian accounts
          </Button>
        </StatePanel>
      )}
      {accounts.kind === 'ready' && (
        <>
          {accountError && (
            <Alert variant="destructive">
              <AlertDescription>{accountError} Last loaded accounts remain visible.</AlertDescription>
            </Alert>
          )}
          {admin.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>
                Could not load sharing recipients. Refresh Atlassian integrations to recover grant controls.
              </AlertDescription>
            </Alert>
          )}
          <AccountSetup
            workspaceId={workspaceId}
            data={accounts.data}
            selectedProtocol={advanced ? undefined : product === 'trello' ? 'trello' : 'atlassian-mcp'}
            onChanged={() => void refresh()}
          />
          <ul
            className="divide-y divide-border empty:hidden"
            aria-label={advanced ? 'Atlassian accounts' : 'Connected accounts'}
          >
            {(advanced ? accounts.data.accounts : connected).map(account => (
              <AccountRow
                key={account.id}
                workspaceId={workspaceId}
                account={account}
                governance={admin.kind === 'admin' ? admin.data : null}
                onChanged={() => void refresh()}
              />
            ))}
          </ul>
          {!advanced && unfinished.length > 0 && (
            <div className="space-y-3">
              <p className="text-muted-foreground">
                {connected.length
                  ? 'Previous sign-in attempts can be resumed below.'
                  : 'You have an unfinished integration. Connect account will reuse it.'}
              </p>
              <Button variant="ghost" aria-expanded={history} onClick={() => setHistory(value => !value)}>
                Previous integrations ({unfinished.length})
              </Button>
              {history && (
                <ul className="divide-y divide-border" aria-label="Previous accounts">
                  {unfinished.map(account => (
                    <AccountRow
                      key={account.id}
                      workspaceId={workspaceId}
                      account={account}
                      governance={admin.kind === 'admin' ? admin.data : null}
                      onChanged={() => void refresh()}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
          {!advanced && connected.length > 0 && (
            <p className="text-base text-muted-foreground">
              {product !== 'trello' && sources.kind === 'ready' && !sources.data.mcp.enabled
                ? 'Your account is connected. Jira and Confluence tools are not enabled on this server yet. Contact your workspace admin to finish setup.'
                : 'Choose a site or board in advanced setup to use this account in chat.'}
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={refreshing} aria-busy={refreshing} onClick={() => void refresh()}>
          Check integration status
        </Button>
        <Button variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>
          Advanced setup
        </Button>
      </div>
      <div hidden={!advanced} className="space-y-6">
        <section className="space-y-4 border-t border-border pt-6" aria-labelledby="atlassian-sources-heading">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="atlassian-sources-heading" className="text-base font-medium">
              Your sources
            </h3>
            <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>
              Refresh sources
            </Button>
          </header>
          {sources.kind === 'loading' && <p role="status">Loading sources…</p>}
          {sources.kind === 'error' && (
            <StatePanel kind="error" title="Could not load sources" description={sources.message}>
              <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>
                Retry sources
              </Button>
            </StatePanel>
          )}
          {sources.kind === 'ready' && accounts.kind === 'ready' && (
            <>
              {sourceError && (
                <Alert variant="destructive">
                  <AlertDescription>{sourceError} Last loaded sources remain visible.</AlertDescription>
                </Alert>
              )}
              <Alert>
                <AlertDescription>{sources.data.mcp.explanation}</AlertDescription>
              </Alert>
            </>
          )}
          <SourceSetup
            workspaceId={workspaceId}
            accounts={accounts.kind === 'ready' ? accounts.data.accounts : []}
            available={available}
            onCreated={() => void refresh()}
          />
          {sources.kind === 'ready' && accounts.kind === 'ready' && (
            <>
              {!sources.data.sources.length && (
                <StatePanel
                  kind="empty"
                  title="No sources selected"
                  description="Save a named site or board above. Account consent alone does not select a source."
                />
              )}
              <ul className="divide-y divide-border" aria-label="Saved Atlassian sources">
                {usableSources.map(source => (
                  <li key={source.id} className="space-y-3 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words font-medium">{source.name}</p>
                        <p className="break-all text-sm text-muted-foreground">
                          {source.binding.kind} ·{' '}
                          {source.binding.kind === 'trello' ? source.binding.boardId : source.binding.cloudId}
                          {source.binding.kind === 'confluence-trash' ? ` · Space ${source.binding.spaceId}` : ''}
                        </p>
                      </div>
                      <Badge variant={source.enabled ? 'success' : 'secondary'}>
                        {source.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </div>
                    {source.enabled && (
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" disabled={busy !== null} onClick={() => setDisableId(source.id)}>
                          Disable {source.name.slice(0, 40)}
                        </Button>
                        {(source.binding.kind === 'jira' || source.binding.kind === 'confluence') && (
                          <Button
                            variant="outline"
                            disabled={busy !== null}
                            aria-busy={busy === source.id}
                            onClick={() => void sourceAction(source.id, 'discover')}
                          >
                            Discover catalog
                          </Button>
                        )}
                      </div>
                    )}
                    {disableId === source.id && (
                      <div className="space-y-2">
                        <p>
                          Disabling this source stops future use and invalidates pending writes. It cannot be
                          re-enabled. You can select a new source later.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="destructive"
                            disabled={busy !== null}
                            onClick={() => void sourceAction(source.id, 'disable')}
                          >
                            Confirm disable source
                          </Button>
                          <Button variant="ghost" disabled={busy !== null} onClick={() => setDisableId(null)}>
                            Cancel disable
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {available && actionMessage && (
            <Alert>
              <AlertDescription>{actionMessage}</AlertDescription>
            </Alert>
          )}
          {available &&
            catalog !== undefined &&
            usableSources.some(source => source.id === catalog.sourceId && source.enabled) && (
              <section className="space-y-3">
                <h4 className="font-medium">Discovered MCP catalog</h4>
                <p>
                  Operator review is required. Discovery does not verify identity, enable operations, or approve tool
                  contracts.
                </p>
                <ProviderResult value={catalog.data} />
              </section>
            )}
        </section>
        <Operations
          workspaceId={workspaceId}
          sources={usableSources}
          mcpEnabled={sources.kind === 'ready' && sources.data.mcp.enabled}
          available={available}
        />
      </div>
    </section>
  );
}
