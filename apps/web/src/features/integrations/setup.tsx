import { useEffect, useRef, useState } from 'react';
import type { CreateIntegration } from '@tulipfarm/integrations/contracts';
import type { GovernanceSnapshot } from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  integrationsApi,
  confirmedRejection,
  integrationError,
  type IntegrationCreationContext,
} from '@/lib/integrations';
import { useIntegrationGrants, useIntegrationChanges, useIntegrationRecovery } from './queries';
import { UnsavedChanges } from '@/features/tables/feedback';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@tulipfarm/sprout/alert-dialog';

type SavedRequest = Readonly<Omit<CreateIntegration, 'repositories'>> & {
  readonly repositories: readonly Readonly<CreateIntegration['repositories'][number]>[];
};
type Creation =
  | { kind: 'editing' }
  | { kind: 'pending'; request: SavedRequest }
  | { kind: 'uncertain'; request: SavedRequest };
type Repository = { id: string; owner: string; repo: string };
const repository = (): Repository => ({ id: crypto.randomUUID(), owner: '', repo: '' });

export function IntegrationSetup({
  workspaceId,
  allowed,
  teams,
  onCreated,
}: {
  workspaceId: string;
  allowed: boolean;
  teams: IntegrationCreationContext['teams'];
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [owningTeamId, setOwningTeamId] = useState('');
  const [token, setToken] = useState('');
  const [repositories, setRepositories] = useState<Repository[]>(() => [repository()]);
  const [creation, setCreation] = useState<Creation>({ kind: 'editing' });
  const [message, setMessage] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<'checking' | 'retrying' | null>(null);
  const pending = useRef(false);
  const changes = useIntegrationChanges();
  const recover = useIntegrationRecovery();
  function saved(id: string) {
    setToken('');
    setName('');
    setOwningTeamId('');
    setRepositories([repository()]);
    setCreation({ kind: 'editing' });
    setMessage('Integration saved. You can grant metadata access, use, management, and repository scope separately.');
    onCreated(id);
  }
  async function create() {
    if (pending.current || creation.kind !== 'editing' || !allowed || !teams.some(team => team.id === owningTeamId))
      return;
    pending.current = true;
    const request: SavedRequest = {
      id: crypto.randomUUID(),
      name,
      owningTeamId,
      token,
      repositories: repositories.map(item => ({ ...item })),
    };
    setCreation({ kind: 'pending', request });
    setMessage(null);
    try {
      await integrationsApi.create(workspaceId, request);
      await changes.authority('github');
      saved(request.id);
    } catch (error) {
      setCreation(confirmedRejection(error) ? { kind: 'editing' } : { kind: 'uncertain', request });
      setMessage(integrationError(error));
    } finally {
      pending.current = false;
    }
  }
  async function check() {
    if (creation.kind !== 'uncertain' || pending.current) return;
    pending.current = true;
    setRecovery('checking');
    try {
      await recover(workspaceId, creation.request.id);
      await changes.authority('github');
      saved(creation.request.id);
    } catch {
      setMessage(
        'Creation is still unconfirmed or you do not have read access. No request was repeated. Retry the saved request to confirm creation without read access.',
      );
    } finally {
      pending.current = false;
      setRecovery(null);
    }
  }
  async function retry() {
    if (creation.kind !== 'uncertain' || pending.current) return;
    pending.current = true;
    setRecovery('retrying');
    setMessage(null);
    try {
      await integrationsApi.create(workspaceId, creation.request);
      await changes.authority('github');
      saved(creation.request.id);
    } catch (error) {
      setMessage(integrationError(error));
    } finally {
      pending.current = false;
      setRecovery(null);
    }
  }
  if (!allowed) return null;
  const locked = creation.kind !== 'editing';
  return (
    <section className="flex flex-col gap-4 border-b border-border pb-6">
      <h2 className="text-lg font-medium">Connect GitHub</h2>
      {!teams.length && <p>Create a team in workspace administration before adding an integration.</p>}
      <form
        className="flex flex-col gap-4"
        onSubmit={event => {
          event.preventDefault();
          void create();
        }}
      >
        <fieldset disabled={locked || !teams.length} className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="integration-name">Integration name</Label>
            <Input
              id="integration-name"
              required
              maxLength={100}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="integration-owner">Owning team</Label>
            <Select value={owningTeamId} required onValueChange={value => setOwningTeamId(value ?? '')}>
              <SelectTrigger id="integration-owner" width="full">
                <SelectValue placeholder="Select a team">
                  {teams.find(team => team.id === owningTeamId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Select a team</SelectItem>
                {teams.map(team => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground">
              The integration starts private to you. Team access requires explicit grants.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="integration-token">GitHub token</Label>
            <Input
              id="integration-token"
              type="password"
              autoComplete="new-password"
              required
              value={token}
              onChange={event => setToken(event.target.value)}
              aria-describedby="token-help"
            />
            <p id="token-help" className="text-muted-foreground">
              Use a fine-grained token with read-only Issues permission for these repositories. It will never be shown
              in integration status.
            </p>
          </div>
          <fieldset className="flex min-w-0 flex-col gap-4">
            <legend className="mb-3 font-medium">Configured repositories</legend>
            {repositories.map((item, index) => (
              <div key={item.id} className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
                <Label htmlFor={`repo-owner-${item.id}`}>Repository {index + 1} owner</Label>
                <Input
                  id={`repo-owner-${item.id}`}
                  required
                  pattern="[A-Za-z0-9][A-Za-z0-9-]*"
                  maxLength={39}
                  value={item.owner}
                  onChange={event =>
                    setRepositories(items =>
                      items.map(repo => (repo.id === item.id ? { ...repo, owner: event.target.value } : repo)),
                    )
                  }
                />
                <Label htmlFor={`repo-name-${item.id}`}>Repository {index + 1} name</Label>
                <Input
                  id={`repo-name-${item.id}`}
                  required
                  pattern="[A-Za-z0-9_.-]+"
                  maxLength={100}
                  value={item.repo}
                  onChange={event =>
                    setRepositories(items =>
                      items.map(repo => (repo.id === item.id ? { ...repo, repo: event.target.value } : repo)),
                    )
                  }
                />
                <p className="break-all text-xs text-muted-foreground">Source ID {item.id}</p>
                {repositories.length > 1 && (
                  <div>
                    <Button
                      variant="ghost"
                      onClick={() => setRepositories(items => items.filter(repo => repo.id !== item.id))}
                    >
                      Remove repository {index + 1}
                    </Button>
                  </div>
                )}
              </div>
            ))}
            <div>
              <Button
                variant="outline"
                disabled={repositories.length >= 20}
                onClick={() => setRepositories(items => [...items, repository()])}
              >
                Add repository
              </Button>
            </div>
          </fieldset>
        </fieldset>
        {message && (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {creation.kind === 'uncertain' ? (
          <>
            <p role="status" className="break-all">
              Creation unconfirmed. Integration ID {creation.request.id}. Check status without resending, or retry the
              saved request with the same ID, token, and original values. Retrying will not create a second integration.
              Keep this tab open to retain the request.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button disabled={recovery !== null} aria-busy={recovery === 'retrying'} onClick={() => void retry()}>
                {recovery === 'retrying' ? 'Retrying saved request…' : 'Retry saved request'}
              </Button>
              <Button
                variant="outline"
                disabled={recovery !== null}
                aria-busy={recovery === 'checking'}
                onClick={() => void check()}
              >
                Check creation status
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button
              type="submit"
              disabled={locked || !teams.some(team => team.id === owningTeamId)}
              aria-busy={creation.kind === 'pending'}
            >
              {creation.kind === 'pending' ? 'Creating integration…' : 'Create integration'}
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}

export function IntegrationCreationGrants({
  workspaceId,
  teams,
  onChanged,
}: {
  workspaceId: string;
  teams: GovernanceSnapshot['teams'];
  onChanged: () => void;
}) {
  const [owningTeamId, setOwningTeamId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [nextTeam, setNextTeam] = useState<string | null>(null);
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Integration creation access</h2>
      <p>
        Choose a destination to review which teams can create integrations for it. This does not grant access to created
        integrations.
      </p>
      <Label htmlFor="creation-destination">Creation destination team</Label>
      <Select
        value={owningTeamId}
        onValueChange={value => {
          const nextTeam = value ?? '';
          if (dirty) setNextTeam(nextTeam);
          else setOwningTeamId(nextTeam);
        }}
      >
        <SelectTrigger id="creation-destination" width="full">
          <SelectValue placeholder="Select a destination team">
            {teams.find(team => team.id === owningTeamId)?.name}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Select a destination team</SelectItem>
          {teams.map(team => (
            <SelectItem key={team.id} value={team.id}>
              {team.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {owningTeamId && (
        <CreationGrantEditor
          key={owningTeamId}
          workspaceId={workspaceId}
          owningTeamId={owningTeamId}
          teams={teams}
          onChanged={onChanged}
          onDirty={setDirty}
        />
      )}
      <AlertDialog
        open={nextTeam !== null}
        onOpenChange={open => {
          if (!open) setNextTeam(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Discard permission edits?</AlertDialogTitle>
          <AlertDialogDescription>
            Keep editing to save your selection before choosing another destination.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setNextTeam(null)}>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (nextTeam !== null) setOwningTeamId(nextTeam);
                setNextTeam(null);
                setDirty(false);
              }}
            >
              Discard edits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CreationGrantEditor({
  workspaceId,
  owningTeamId,
  teams,
  onChanged,
  onDirty,
}: {
  workspaceId: string;
  owningTeamId: string;
  teams: GovernanceSnapshot['teams'];
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  type Snapshot = Awaited<ReturnType<typeof integrationsApi.creationGrants>>;
  const [base, setBase] = useState<Snapshot | null>(null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const read = useIntegrationGrants(workspaceId, owningTeamId);
  const changes = useIntegrationChanges();
  const current = read.state.kind === 'ready' ? read.state.data : null;
  useEffect(() => {
    if (current && !base) {
      setBase(current);
      setTeamIds(current.teamIds);
    }
  }, [current, base]);
  const conflict = !!base && !!current && base.version !== current.version;
  const additions = teamIds.filter(id => !base?.teamIds.includes(id));
  const removals = base?.teamIds.filter(id => !teamIds.includes(id)) ?? [];
  const dirty = additions.length > 0 || removals.length > 0;
  useEffect(() => onDirty(dirty || saving), [onDirty, dirty, saving]);
  const names = (ids: string[]) =>
    ids.map(id => teams.find(team => team.id === id)?.name ?? `Unavailable team ${id.slice(0, 8)}`).join(', ') ||
    'None';
  const locked = saving || !base || !current || conflict || (read.state.kind === 'ready' && read.state.refreshing);
  async function save() {
    if (pending.current || !confirmed || locked || !base) return;
    pending.current = true;
    setSaving(true);
    setMessage(null);
    try {
      await integrationsApi.setCreationGrants(workspaceId, { owningTeamId, teamIds, expectedVersion: base.version });
      await changes.creation();
      setBase(null);
      setMessage('Creation grants saved. Integration access remains separate.');
      setConfirmed(false);
      onChanged();
    } catch (error) {
      setMessage(integrationError(error));
      setConfirmed(false);
      void read.refresh();
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return (
    <section className="flex flex-col gap-4" aria-label="Saved creation permissions">
      <UnsavedChanges dirty={additions.length > 0 || removals.length > 0} />
      {read.state.kind === 'loading' && <p role="status">Loading saved permissions…</p>}
      {(read.state.kind === 'error' || read.state.kind === 'unavailable') && (
        <p role="alert">Saved permissions could not load. Retry before editing.</p>
      )}
      {(read.state.kind === 'error' || read.state.kind === 'unavailable') && (
        <Button variant="outline" disabled={saving} onClick={() => void read.refresh()}>
          Retry
        </Button>
      )}
      {current && <p>Currently allowed teams: {names(current.teamIds)}.</p>}
      {conflict && (
        <div className="space-y-2">
          <p role="alert">
            Saved permissions changed. Your selection is retained. Review the current teams before replacing them.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setBase(current);
              setConfirmed(false);
            }}
          >
            Keep my selection against these permissions
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setBase(current);
              setTeamIds(current?.teamIds ?? []);
              setConfirmed(false);
            }}
          >
            Use saved permissions
          </Button>
        </div>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
      >
        <p role="status" className="text-sm text-muted-foreground">
          {dirty
            ? 'Unsaved creation permissions. Review the additions and removals, then save.'
            : 'Checkboxes are drafts until you save creation permissions.'}
        </p>
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3">
          {teams.map(team => (
            <div key={team.id} className="flex items-center gap-2">
              <Checkbox
                id={`creation-grant-${team.id}`}
                checked={teamIds.includes(team.id)}
                onCheckedChange={checked => {
                  setTeamIds(current => (checked ? [...current, team.id] : current.filter(id => id !== team.id)));
                  setConfirmed(false);
                }}
              />
              <Label htmlFor={`creation-grant-${team.id}`}>Allow {team.name} to create integrations</Label>
            </div>
          ))}
          <p>
            Allow creation: {names(additions)}. Remove creation access: {names(removals)}.
          </p>
          <div className="flex items-center gap-2">
            <Checkbox id="creation-replace-confirm" checked={confirmed} onCheckedChange={setConfirmed} />
            <Label htmlFor="creation-replace-confirm">
              Apply these additions and removals. Other saved teams keep their access.
            </Label>
          </div>
        </fieldset>
        {message && (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            type="submit"
            variant="outline"
            disabled={locked || !confirmed || !(additions.length || removals.length)}
            aria-busy={saving}
          >
            {saving ? 'Saving creation grants…' : 'Save creation permissions'}
          </Button>
        </div>
      </form>
    </section>
  );
}
