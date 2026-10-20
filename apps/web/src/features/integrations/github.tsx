import { useState } from 'react';
import type { IntegrationMetadata } from '@tulipfarm/integrations/contracts';
import type { IntegrationCollaborators } from '@/lib/integrations';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { Disclosure } from '@/components/disclosure';
import { type IntegrationCreationContext } from '@/lib/integrations';
import {
  useManagedIntegrations,
  useIntegrationAdministration,
  useIntegrationCreation,
  useIntegrationDetail,
} from './queries';
import { IntegrationSetup } from './setup';
import { IntegrationEditor } from './editor';

type PageState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'ready'; integrations: IntegrationMetadata[] };
type Administration =
  | { kind: 'loading' }
  | { kind: 'member' }
  | { kind: 'error' }
  | { kind: 'admin'; teams: IntegrationCollaborators['teams'] };
type CreationAccess =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; teams: IntegrationCreationContext['teams'] };

export function GitHubIntegrations({ workspaceId }: { workspaceId: string; onChanged: () => void }) {
  const list = useManagedIntegrations(workspaceId);
  const admin = useIntegrationAdministration(workspaceId);
  const creation = useIntegrationCreation(workspaceId);
  const state: PageState =
    list.state.kind === 'ready'
      ? { kind: 'ready', integrations: list.state.data.integrations }
      : list.state.kind === 'unavailable'
        ? { kind: 'unavailable', message: 'Integrations are unavailable to your current membership.' }
        : list.state;
  const administration: Administration =
    admin.state.kind === 'ready'
      ? admin.state.error
        ? { kind: 'error' }
        : { kind: 'admin', teams: admin.state.data.teams }
      : admin.state.kind === 'unavailable'
        ? { kind: 'member' }
        : { kind: admin.state.kind };
  const creationAccess: CreationAccess =
    creation.state.kind === 'ready'
      ? creation.state.error
        ? { kind: 'error' }
        : { kind: 'ready', teams: creation.state.data.teams }
      : { kind: creation.state.kind === 'loading' ? 'loading' : 'error' };
  const refreshing = [list, admin, creation].some(
    read => read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing),
  );
  const message = list.state.kind === 'ready' ? list.state.error : null;
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useIntegrationDetail(workspaceId, selected ?? '', selected !== null);
  const refresh = async () => {
    await Promise.all([list.refresh(), admin.refresh(), creation.refresh(), detail.refresh()]);
  };
  const changed = () => {};
  const available = state.kind === 'ready';
  const canCreate = available && creationAccess.kind === 'ready' && creationAccess.teams.length > 0;
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Team GitHub setup">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="github-integrations" tabIndex={-1} className="font-medium">
          GitHub integrations
        </h2>
        <Button variant="outline" size="sm" disabled={refreshing} aria-busy={refreshing} onClick={() => void refresh()}>
          {refreshing && <Spinner aria-hidden="true" />}Refresh integrations
        </Button>
      </div>
      {state.kind === 'loading' && (
        <p role="status" className="flex items-center gap-2">
          <Spinner aria-hidden="true" />
          Loading integrations…
        </p>
      )}
      {state.kind === 'error' && (
        <StatePanel kind="error" title="Could not load integrations" description={state.message}>
          <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>
            Retry loading integrations
          </Button>
        </StatePanel>
      )}
      {state.kind === 'unavailable' && (
        <StatePanel kind="unavailable" title="Integrations unavailable" description={state.message} />
      )}
      {available && message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {available && administration.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not check administration access. Refresh integrations to retry. Grant controls are hidden until access
            is confirmed.
          </AlertDescription>
        </Alert>
      )}
      {available && creationAccess.kind === 'loading' && <p role="status">Checking integration creation access…</p>}
      {available && creationAccess.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not check integration creation access. Refresh integrations to retry. Setup is hidden until access is
            confirmed.
          </AlertDescription>
        </Alert>
      )}
      {state.kind === 'ready' && (
        <section className="flex flex-col gap-3" aria-label="Accessible integrations">
          {!state.integrations.length && (
            <StatePanel
              kind="empty"
              title="No integrations available"
              description={
                canCreate
                  ? 'Add one below. You can share integration use and repository access separately.'
                  : 'Create or join a team to add a team integration, or ask an integration manager to share one.'
              }
            />
          )}
          {state.integrations.length > 0 && (
            <ul className="divide-y divide-border">
              {state.integrations.map(integration => (
                <li key={integration.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{integration.name}</p>
                    <p className="text-muted-foreground">
                      {integration.enabled ? 'On' : 'Off'} · Key version {integration.generation}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Open ${integration.name}`}
                    aria-pressed={selected === integration.id}
                    onClick={() => setSelected(integration.id)}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {selected && (
        <IntegrationEditor
          key={selected}
          workspaceId={workspaceId}
          id={selected}
          current={available ? state.integrations.find(item => item.id === selected) : undefined}
          teams={administration.kind === 'admin' ? administration.teams : []}
          members={admin.state.kind === 'ready' ? admin.state.data.members : []}
          onChanged={changed}
        />
      )}
      <Disclosure title="Add GitHub integration" hidden={!canCreate}>
        <IntegrationSetup
          workspaceId={workspaceId}
          allowed={canCreate}
          teams={creationAccess.kind === 'ready' ? creationAccess.teams : []}
          onCreated={id => {
            setSelected(id);
            changed();
          }}
        />
        <p className="text-muted-foreground">Tokens are write-only. Unsaved tokens stay only in this tab.</p>
      </Disclosure>
    </section>
  );
}
