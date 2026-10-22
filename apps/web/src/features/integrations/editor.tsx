import { useEffect, useRef, useState } from 'react';
import { useIntegrationDetail, useIntegrationChanges, useIntegrationIssue } from './queries';
import type { IntegrationDetail, IntegrationMetadata, IssueResult, ReadIssue } from '@tulipfarm/integrations/contracts';
import type { IntegrationCollaborators } from '@/lib/integrations';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  accessLost,
  confirmedRejection,
  integrationError,
  integrationsApi,
  IntegrationRequestError,
} from '@/lib/integrations';
import { InvestigationGrants } from './investigation-grants';

type DetailState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'ready'; data: IntegrationDetail };
type Mutation =
  | { kind: 'idle' }
  | { kind: 'pending'; operation: string }
  | { kind: 'uncertain'; operation: string; expectedGeneration: number | null; reviewed: boolean };
type Grants = NonNullable<IntegrationDetail['grants']>;
type SourceGrants = NonNullable<IntegrationDetail['sourceGrants']>;
type GrantDraft = {
  kind: 'edited' | 'conflict';
  expectedGrantsVersion: number;
  grants: Grants;
  sourceGrants: SourceGrants;
};
type IssueState =
  | { kind: 'idle' }
  | { kind: 'pending'; request: ReadIssue }
  | { kind: 'error'; request: ReadIssue; message: string }
  | { kind: 'ready'; result: IssueResult };

export function IntegrationEditor({
  workspaceId,
  id,
  current,
  teams,
  members,
  onChanged,
}: {
  workspaceId: string;
  id: string;
  current: IntegrationMetadata | undefined;
  teams: IntegrationCollaborators['teams'];
  members: IntegrationCollaborators['members'];
  onChanged: () => void;
}) {
  const visible = current !== undefined;
  const detail = useIntegrationDetail(workspaceId, id, visible);
  const changes = useIntegrationChanges();
  const loadIssue = useIntegrationIssue(workspaceId);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const state: DetailState =
    unavailable || detail.state.kind === 'unavailable'
      ? { kind: 'unavailable', message: unavailable ?? 'This integration is unavailable to your current membership.' }
      : detail.state;
  const [mutation, setMutation] = useState<Mutation>({ kind: 'idle' });
  const refreshing = detail.state.kind === 'loading' || (detail.state.kind === 'ready' && detail.state.refreshing);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
  const [grantDraft, setGrantDraft] = useState<GrantDraft | null>(null);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [issueNumber, setIssueNumber] = useState('');
  const [issue, setIssue] = useState<IssueState>({ kind: 'idle' });
  const initialized = useRef(false);
  const pending = useRef(false);
  const issueRead = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  const refresh = async (reloadGrants = false) => {
    const result = await detail.refresh();
    if (!result) return;
    setUnavailable(null);
    if (reloadGrants) setGrantDraft(null);
    setMutation(previous => (previous.kind === 'uncertain' ? { ...previous, reviewed: true } : previous));
  };
  const snapshot = state.kind === 'ready' ? state.data : null;
  useEffect(() => {
    if (!snapshot) return;
    if (!initialized.current) {
      setName(snapshot.name);
      setOwner(snapshot.owningTeamId);
      initialized.current = true;
    }
  }, [snapshot]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    issueRead.current?.abort();
    setIssue({ kind: 'idle' });
    return () => {
      issueRead.current?.abort();
    };
  }, [
    visible,
    detail.data === null,
    current?.generation,
    current?.grantsVersion,
    current?.enabled,
    current?.capabilities.use,
  ]);
  useEffect(() => {
    if (visible && state.kind === 'ready' && !focused.current) {
      heading.current?.focus();
      focused.current = true;
    }
  }, [visible, state.kind]);

  async function change(
    operation: string,
    path: string,
    method: string,
    body?: unknown,
    expectedGeneration: number | null = null,
  ) {
    if (pending.current || mutation.kind !== 'idle' || state.kind !== 'ready') return;
    pending.current = true;
    issueRead.current?.abort();
    setIssue({ kind: 'idle' });
    setMessage(null);
    setMutation({ kind: 'pending', operation });
    try {
      await integrationsApi.change(workspaceId, id, path, method, body);
      await changes.authority('github');
      if (!alive.current) return;
      if (path === '/rotate') setToken('');
      if (path === '/grants') setGrantDraft(null);
      setMutation({ kind: 'idle' });
      setMessage(`${operation} confirmed.`);
      if (method === 'DELETE') setUnavailable('This integration was deleted.');
      onChanged();
    } catch (error) {
      if (!alive.current) return;
      setMutation(
        confirmedRejection(error)
          ? { kind: 'idle' }
          : { kind: 'uncertain', operation, expectedGeneration, reviewed: false },
      );
      setMessage(integrationError(error));
      if (path === '/grants' && error instanceof IntegrationRequestError && error.status === 409) {
        setGrantDraft(previous => (previous ? { ...previous, kind: 'conflict' } : previous));
        await refresh();
      }
      if (accessLost(error)) setUnavailable(integrationError(error));
    } finally {
      pending.current = false;
    }
  }
  async function readIssue() {
    if (issueRead.current || state.kind !== 'ready' || !state.data.capabilities.use) return;
    const request =
      issue.kind === 'error'
        ? issue.request
        : { requestId: crypto.randomUUID(), integrationId: id, sourceId, issueNumber: Number(issueNumber) };
    const controller = new AbortController();
    issueRead.current = controller;
    setIssue({ kind: 'pending', request });
    try {
      const result = await loadIssue(request, controller.signal);
      if (!controller.signal.aborted) setIssue({ kind: 'ready', result });
    } catch (error) {
      if (controller.signal.aborted) return;
      setIssue({ kind: 'error', request, message: integrationError(error) });
      if (accessLost(error)) {
        setUnavailable(integrationError(error));
        setIssue({ kind: 'idle' });
      }
    } finally {
      if (issueRead.current === controller) issueRead.current = null;
    }
  }
  function togglePermission(teamId: string, permission: 'read' | 'use' | 'manage', checked: boolean) {
    if (state.kind !== 'ready') return;
    const data = state.data;
    setGrantDraft(previous => {
      const current = previous ?? {
        kind: 'edited',
        expectedGrantsVersion: data.grantsVersion,
        grants: data.grants ?? [],
        sourceGrants: data.sourceGrants ?? [],
      };
      const permissions = current.grants.find(grant => grant.teamId === teamId)?.permissions ?? [];
      const next = checked ? [...permissions, permission] : permissions.filter(item => item !== permission);
      return {
        ...current,
        grants: [
          ...current.grants.filter(grant => grant.teamId !== teamId),
          ...(next.length ? [{ teamId, permissions: next }] : []),
        ],
      };
    });
  }
  function toggleSource(teamId: string, sourceId: string, checked: boolean) {
    if (state.kind !== 'ready') return;
    const data = state.data;
    setGrantDraft(previous => {
      const current = previous ?? {
        kind: 'edited',
        expectedGrantsVersion: data.grantsVersion,
        grants: data.grants ?? [],
        sourceGrants: data.sourceGrants ?? [],
      };
      return {
        ...current,
        sourceGrants: checked
          ? [...current.sourceGrants, { teamId, sourceId }]
          : current.sourceGrants.filter(grant => grant.teamId !== teamId || grant.sourceId !== sourceId),
      };
    });
  }
  if (!current) return null;
  if (state.kind === 'loading') return <p role="status">Loading integration status…</p>;
  if (state.kind !== 'ready')
    return (
      <StatePanel
        kind={state.kind === 'error' ? 'error' : 'unavailable'}
        title="Integration status unavailable"
        description={state.message}
      >
        <Button disabled={refreshing} onClick={() => void refresh()}>
          Check integration status
        </Button>
      </StatePanel>
    );
  const data = {
    ...state.data,
    capabilities: { ...state.data.capabilities, use: current.capabilities.use && state.data.capabilities.use },
  };
  const canUse = current.capabilities.use && data.capabilities.use;
  const canManage = current.capabilities.manage && data.capabilities.manage;
  const canAdminister = current.capabilities.administer && data.capabilities.administer;
  const locked = mutation.kind !== 'idle' || refreshing;
  const grants = grantDraft?.grants ?? data.grants ?? [];
  const sourceGrants = grantDraft?.sourceGrants ?? data.sourceGrants ?? [];
  const grantsConflict =
    grantDraft !== null &&
    (grantDraft.kind === 'conflict' ||
      grantDraft.expectedGrantsVersion < data.grantsVersion ||
      grantDraft.expectedGrantsVersion < current.grantsVersion);
  const invalidGrants = grants.some(grant => !grant.permissions.includes('read'));
  const readable = canUse ? data.repositories.filter(repository => repository.canReadIssues) : [];
  const selectedRepository = readable.find(repository => repository.id === sourceId);
  return (
    <section className="flex min-w-0 flex-col gap-6 border-t border-border pt-6" aria-label="Selected integration">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={heading} tabIndex={-1} className="break-words text-lg font-medium">
          {data.name}
        </h2>
        <Button
          variant="outline"
          disabled={refreshing || mutation.kind === 'pending'}
          aria-busy={refreshing}
          onClick={() => void refresh()}
        >
          Check integration status
        </Button>
      </header>
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="font-medium">Integration ID</dt>
          <dd className="break-all">{data.id}</dd>
        </div>
        <div>
          <dt className="font-medium">Owning team</dt>
          <dd className="break-all">{teams.find(team => team.id === data.owningTeamId)?.name ?? data.owningTeamId}</dd>
        </div>
        <div>
          <dt className="font-medium">Credential generation</dt>
          <dd>{data.generation}</dd>
        </div>
        <div>
          <dt className="font-medium">Status</dt>
          <dd>{data.enabled ? 'Enabled' : 'Disabled'}</dd>
        </div>
      </dl>
      <p>
        Your permissions · Metadata {current.capabilities.read ? 'allowed' : 'denied'} · Use{' '}
        {canUse ? 'allowed' : 'denied'} · Manage {canManage ? 'allowed' : 'denied'}
      </p>
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {detail.state.kind === 'ready' && detail.state.error && (
        <Alert variant="destructive">
          <AlertDescription>{detail.state.error}</AlertDescription>
        </Alert>
      )}
      {mutation.kind === 'pending' && <p role="status">{mutation.operation} pending…</p>}
      {mutation.kind === 'uncertain' && (
        <div className="flex flex-col gap-3">
          <Alert>
            <AlertDescription>
              {mutation.operation} is unconfirmed. No write will be repeated automatically.{' '}
              {mutation.expectedGeneration !== null &&
                `The request expected generation ${mutation.expectedGeneration}. Current generation is ${data.generation}. A changed generation does not prove which token is installed.`}
            </AlertDescription>
          </Alert>
          {mutation.reviewed ? (
            <Button
              variant="outline"
              onClick={() => {
                setToken('');
                setMutation({ kind: 'idle' });
                setMessage(
                  'Status reviewed. No write was repeated. Enter a new token only if another rotation is needed.',
                );
              }}
            >
              Finish status review
            </Button>
          ) : (
            <Button disabled={refreshing} onClick={() => void refresh()}>
              Check uncertain change status
            </Button>
          )}
        </div>
      )}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-medium">Repository scope</h3>
        <ul className="flex flex-col gap-3">
          {data.repositories.map(repository => (
            <li key={repository.id}>
              <p className="break-all">
                {repository.owner}/{repository.repo} ·{' '}
                {canUse && repository.canReadIssues ? 'Issue reading allowed' : 'Issue reading not allowed'}
              </p>
              <p className="break-all text-xs text-muted-foreground">Source ID {repository.id}</p>
            </li>
          ))}
        </ul>
      </section>
      {data.capabilities.use && readable.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h3 className="text-base font-medium">Read a GitHub issue</h3>
          <form
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault();
              void readIssue();
            }}
          >
            <fieldset
              disabled={issue.kind === 'pending' || issue.kind === 'error' || locked}
              className="flex min-w-0 flex-col gap-3"
            >
              <Label htmlFor="issue-source">Repository</Label>
              <Select value={sourceId} required onValueChange={value => setSourceId(value ?? '')}>
                <SelectTrigger id="issue-source" width="full">
                  <SelectValue placeholder="Select an allowed repository">
                    {selectedRepository ? `${selectedRepository.owner}/${selectedRepository.repo}` : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Select an allowed repository</SelectItem>
                  {readable.map(repository => (
                    <SelectItem key={repository.id} value={repository.id}>
                      {repository.owner}/{repository.repo}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label htmlFor="issue-number">Issue number</Label>
              <Input
                id="issue-number"
                type="number"
                min={1}
                max={2147483647}
                step={1}
                required
                value={issueNumber}
                onChange={event => setIssueNumber(event.target.value)}
              />
            </fieldset>
            {issue.kind === 'error' && (
              <Alert variant="destructive">
                <AlertDescription>{issue.message} Retry uses the same request ID.</AlertDescription>
              </Alert>
            )}
            <div>
              <Button
                type="submit"
                disabled={
                  issue.kind === 'pending' || locked || !readable.some(repository => repository.id === sourceId)
                }
                aria-busy={issue.kind === 'pending'}
              >
                {issue.kind === 'pending'
                  ? 'Reading issue…'
                  : issue.kind === 'error'
                    ? 'Retry reading issue'
                    : 'Read issue'}
              </Button>
            </div>
          </form>
          {issue.kind === 'ready' && (
            <article className="flex flex-col gap-2" aria-label="GitHub issue result">
              <h4 className="break-words text-base font-medium">
                #{issue.result.number} {issue.result.title}
              </h4>
              <p>{issue.result.state}</p>
              <p className="whitespace-pre-wrap break-words">{issue.result.body || 'This issue has no description.'}</p>
            </article>
          )}
        </section>
      ) : (
        <p className="text-muted-foreground">
          Reading issues requires integration use and an explicit repository grant. Management alone does not permit
          reading issues.
        </p>
      )}
      {canManage && (
        <section className="flex flex-col gap-4">
          <h3 className="text-base font-medium">Manage integration</h3>
          <form
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault();
              void change('Rename integration', '', 'PATCH', { name });
            }}
          >
            <Label htmlFor="edit-integration-name">Saved integration name</Label>
            <Input
              id="edit-integration-name"
              required
              maxLength={120}
              disabled={locked}
              value={name}
              onChange={event => setName(event.target.value)}
            />
            <div>
              <Button variant="outline" type="submit" disabled={locked}>
                Save integration name
              </Button>
            </div>
          </form>
          <div>
            <Button
              variant="outline"
              disabled={locked}
              onClick={() =>
                void change(data.enabled ? 'Disable integration' : 'Enable integration', '', 'PATCH', {
                  enabled: !data.enabled,
                })
              }
            >
              {data.enabled ? 'Disable integration' : 'Enable integration'}
            </Button>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault();
              void change(
                'Rotate token',
                '/rotate',
                'POST',
                { expectedGeneration: data.generation, token },
                data.generation,
              );
            }}
          >
            <Label htmlFor="rotation-token">Replacement GitHub token</Label>
            <Input
              id="rotation-token"
              type="password"
              autoComplete="new-password"
              required
              maxLength={4096}
              disabled={locked}
              value={token}
              onChange={event => setToken(event.target.value)}
            />
            <p className="text-muted-foreground">
              Rotation replaces generation {data.generation} only. A concurrent rotation is rejected rather than
              overwritten.
            </p>
            <div>
              <Button type="submit" variant="outline" disabled={locked}>
                Rotate token
              </Button>
            </div>
          </form>
          <div className="flex items-center gap-3">
            <Checkbox
              id="delete-integration-confirm"
              disabled={locked}
              checked={deleteConfirmed}
              onCheckedChange={setDeleteConfirmed}
            />
            <Label htmlFor="delete-integration-confirm">
              Delete this integration and stop future use. This cannot be undone.
            </Label>
          </div>
          <div>
            <Button
              variant="destructive"
              disabled={locked || !deleteConfirmed}
              onClick={() => void change('Delete integration', '', 'DELETE')}
            >
              Delete integration
            </Button>
          </div>
        </section>
      )}
      {canAdminister && (
        <PersonGrants
          key={data.grantsVersion}
          data={data}
          members={members}
          locked={locked}
          save={body => change('Save person grants', '/grants', 'PUT', body)}
        />
      )}
      {canAdminister && (
        <InvestigationGrants
          key={`investigation-${data.grantsVersion}`}
          data={data}
          teams={teams}
          members={members}
          locked={locked}
          save={body => change('Save investigation permissions', '/grants', 'PUT', body)}
        />
      )}
      {canAdminister && data.grants && data.sourceGrants && teams.length > 0 && (
        <section className="flex flex-col gap-4">
          <h3 className="text-base font-medium">Team grants</h3>
          <p className="text-muted-foreground">
            Read metadata is required alongside Use or Manage. Select each permission explicitly. Repository scope does
            not grant integration use. Ownership transfer preserves all explicit grants below.
          </p>
          <fieldset disabled={locked || grantsConflict} className="flex min-w-0 flex-col gap-5">
            <legend className="sr-only">Integration and repository grants</legend>
            {teams.map(team => (
              <fieldset key={team.id} className="flex min-w-0 flex-col gap-3">
                <legend className="mb-3 font-medium">{team.name}</legend>
                <div className="flex flex-wrap gap-4">
                  {(['read', 'use', 'manage'] as const).map(permission => (
                    <div key={permission} className="flex items-center gap-2">
                      <Checkbox
                        id={`${team.id}-${permission}`}
                        checked={grants.some(
                          grant => grant.teamId === team.id && grant.permissions.includes(permission),
                        )}
                        onCheckedChange={checked => togglePermission(team.id, permission, checked)}
                      />
                      <Label htmlFor={`${team.id}-${permission}`}>
                        {permission === 'read'
                          ? 'Read metadata'
                          : permission === 'use'
                            ? 'Use integration'
                            : 'Manage integration'}
                      </Label>
                    </div>
                  ))}
                </div>
                {data.repositories.map(repository => (
                  <div key={repository.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`${team.id}-${repository.id}`}
                      checked={sourceGrants.some(grant => grant.teamId === team.id && grant.sourceId === repository.id)}
                      onCheckedChange={checked => toggleSource(team.id, repository.id, checked)}
                    />
                    <Label htmlFor={`${team.id}-${repository.id}`}>
                      Read issues in {repository.owner}/{repository.repo}
                    </Label>
                  </div>
                ))}
              </fieldset>
            ))}
          </fieldset>
          {grantsConflict && (
            <>
              <Alert variant="destructive">
                <AlertDescription>
                  Another manager changed these grants. Your edits have not been saved. Reload grants to discard your
                  edits and review the current permissions.
                </AlertDescription>
              </Alert>
              <div>
                <Button variant="outline" disabled={locked} onClick={() => void refresh(true)}>
                  Reload grants
                </Button>
              </div>
            </>
          )}
          {invalidGrants && (
            <Alert variant="destructive">
              <AlertDescription>
                Select Read metadata explicitly for every team receiving Use or Manage.
              </AlertDescription>
            </Alert>
          )}
          <div>
            <Button
              disabled={locked || invalidGrants || grantsConflict || !grantDraft}
              onClick={() => {
                if (grantDraft && !grantsConflict)
                  void change('Save grants', '/grants', 'PUT', {
                    expectedGrantsVersion: grantDraft.expectedGrantsVersion,
                    grants,
                    sourceGrants,
                  });
              }}
            >
              Save team grants
            </Button>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault();
              void change('Transfer ownership', '/owner', 'PUT', { owningTeamId: owner });
            }}
          >
            <Label htmlFor="transfer-owner">Transfer to team</Label>
            <Select value={owner} required disabled={locked} onValueChange={value => setOwner(value ?? '')}>
              <SelectTrigger id="transfer-owner" width="full">
                <SelectValue placeholder="Select a team">{teams.find(team => team.id === owner)?.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {teams.map(team => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div>
              <Button variant="outline" type="submit" disabled={locked || owner === data.owningTeamId}>
                Transfer ownership
              </Button>
            </div>
          </form>
        </section>
      )}
    </section>
  );
}

function PersonGrants({
  data,
  members,
  locked,
  save,
}: {
  data: IntegrationDetail;
  members: IntegrationCollaborators['members'];
  locked: boolean;
  save: (input: unknown) => Promise<void>;
}) {
  const [grants, setGrants] = useState(data.personGrants ?? []);
  const [sources, setSources] = useState(data.sourcePersonGrants ?? []);
  const [dirty, setDirty] = useState(false);
  const invalid = grants.some(grant => !grant.permissions.includes('read'));
  return (
    <section className="space-y-4" aria-label="Person integration grants">
      <h3 className="text-base font-medium">Person grants</h3>
      <p>
        Use and repository access are separate. Managers can edit credentials and sharing. Keep at least one current
        manager.
      </p>
      <fieldset disabled={locked} className="space-y-4">
        <legend className="sr-only">People with integration access</legend>
        {members.map(member => (
          <div key={member.id} className="space-y-2">
            <p>{member.name}</p>
            <div className="flex flex-wrap gap-3">
              {(['read', 'use', 'manage'] as const).map(permission => (
                <Label key={permission}>
                  <Checkbox
                    checked={grants.some(
                      grant => grant.memberId === member.id && grant.permissions.includes(permission),
                    )}
                    onCheckedChange={checked => {
                      const previous = grants.find(grant => grant.memberId === member.id)?.permissions ?? [];
                      const permissions = checked
                        ? [...previous, permission]
                        : previous.filter(value => value !== permission);
                      setGrants([
                        ...grants.filter(grant => grant.memberId !== member.id),
                        ...(permissions.length ? [{ memberId: member.id, permissions }] : []),
                      ]);
                      setDirty(true);
                    }}
                  />
                  {permission} for {member.name}
                </Label>
              ))}
            </div>
            {data.repositories.map(repository => (
              <Label key={repository.id}>
                <Checkbox
                  checked={sources.some(grant => grant.memberId === member.id && grant.sourceId === repository.id)}
                  onCheckedChange={checked => {
                    setSources(
                      checked
                        ? [...sources, { memberId: member.id, sourceId: repository.id }]
                        : sources.filter(grant => grant.memberId !== member.id || grant.sourceId !== repository.id),
                    );
                    setDirty(true);
                  }}
                />
                Read {repository.owner}/{repository.repo} issues for {member.name}
              </Label>
            ))}
          </div>
        ))}
      </fieldset>
      {invalid && (
        <Alert variant="destructive">
          <AlertDescription>Read metadata is required alongside use or manage.</AlertDescription>
        </Alert>
      )}
      <Button
        disabled={locked || !dirty || invalid}
        onClick={() =>
          void save({
            expectedGrantsVersion: data.grantsVersion,
            grants: data.grants ?? [],
            sourceGrants: data.sourceGrants ?? [],
            personGrants: grants,
            sourcePersonGrants: sources,
          })
        }
      >
        Save person grants
      </Button>
    </section>
  );
}
