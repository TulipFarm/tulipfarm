import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { grantsSchema, sharingCandidatesSchema, workflowSchema } from '@tulipfarm/workflows/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { workflowRequest, WorkflowRequestError } from './api';

type Candidates = z.infer<typeof sharingCandidatesSchema>;
type Workflow = z.infer<typeof workflowSchema>;
export const recordSourceDenied =
  'The sponsor or a history reader cannot read this workflow’s table. Grant them table read access or choose someone else.';
const denied = (error: unknown) => error instanceof WorkflowRequestError && error.code === 'record-source-denied';
type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; candidates: Candidates; grants: z.infer<typeof grantsSchema> };

export function WorkflowSharing({
  workspaceId,
  id,
  provider = false,
  workflow,
  changed,
}: {
  workspaceId: string;
  id: string;
  provider?: boolean;
  workflow?: Workflow;
  changed: () => Promise<void>;
}) {
  const base = `/workspaces/${workspaceId}/workflows`;
  const path = `${base}/${provider ? 'provider-integrations/' : ''}${id}`;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [principal, setPrincipal] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [audience, setAudience] = useState<string[]>(workflow?.historyAudience ?? []);
  const [sponsor, setSponsor] = useState(workflow?.sponsorMembershipId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try {
      const [candidates, grants] = await Promise.all([
        workflowRequest(`${base}/sharing-candidates`),
        workflowRequest(`${path}/grants`),
      ]);
      setState({
        kind: 'ready',
        candidates: sharingCandidatesSchema.parse(candidates),
        grants: grantsSchema.parse(grants),
      });
    } catch {
      setState({ kind: 'error' });
    }
  }, [base, path]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(suffix: string, body: unknown, success: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await workflowRequest(`${path}/${suffix}`, 'PUT', body);
      await load();
      await changed();
      setMessage(success);
    } catch (failure) {
      setError(
        denied(failure)
          ? `${recordSourceDenied} Your choices are retained.`
          : 'This change could not be confirmed. Your choices are retained. Reload access before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }
  const choices = provider ? ['use', 'manage'] : ['read', 'invoke', 'manage'];
  return (
    <section aria-label={provider ? 'Provider sharing' : 'Workflow sharing'} className="space-y-3">
      <h2 className="text-sm font-medium">{provider ? 'Provider sharing' : 'Definition sharing'}</h2>
      <p className="text-sm text-muted-foreground">
        {provider
          ? 'Grant integration use or management to selected people or your teams. Credentials remain private.'
          : 'New workflows are private. Sharing a definition never shares someone else’s manual run history.'}
      </p>
      {state.kind === 'loading' && (
        <StatePanel
          kind="loading"
          title="Loading sharing"
          description="Checking current grants and available recipients."
        />
      )}
      {state.kind === 'error' && (
        <StatePanel kind="error" title="Sharing could not load" description="Check your access and retry.">
          <Button variant="outline" onClick={() => void load()}>
            Reload sharing
          </Button>
        </StatePanel>
      )}
      {state.kind === 'ready' && (
        <>
          <Label htmlFor={`share-${id}`}>Person or team</Label>
          <Select
            value={principal}
            onValueChange={value => {
              if (!value) return;
              setPrincipal(value);
              const [kind, target] = value.split(':');
              setPermissions(
                state.grants
                  .filter(grant => (kind === 'person' ? grant.membershipId === target : grant.teamId === target))
                  .map(grant => grant.permission),
              );
            }}
          >
            <SelectTrigger id={`share-${id}`}>
              <SelectValue placeholder="Choose a person or team" />
            </SelectTrigger>
            <SelectContent>
              {state.candidates.people.map(person => (
                <SelectItem key={person.id} value={`person:${person.id}`}>
                  {person.name}
                </SelectItem>
              ))}
              {state.candidates.teams.map(team => (
                <SelectItem key={team.id} value={`team:${team.id}`}>
                  Team: {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <fieldset disabled={busy || !principal} className="space-y-2">
            <legend>Permissions</legend>
            {choices.map(permission => (
              <Label key={permission}>
                <Checkbox
                  checked={permissions.includes(permission)}
                  onCheckedChange={checked =>
                    setPermissions(previous =>
                      checked ? [...previous, permission] : previous.filter(item => item !== permission),
                    )
                  }
                />
                {permission === 'invoke'
                  ? 'Run workflow'
                  : permission === 'read'
                    ? 'Read definition'
                    : permission === 'use'
                      ? 'Use integration'
                      : 'Manage and share'}
              </Label>
            ))}
          </fieldset>
          <Button
            disabled={busy || !principal}
            aria-busy={busy}
            onClick={() => {
              const [kind, target] = principal.split(':');
              void save(
                'grants',
                { principal: { kind, id: target }, permissions },
                'Sharing saved. Run histories remain private.',
              );
            }}
          >
            Save sharing
          </Button>
          <ul className="space-y-1 break-words text-sm">
            {state.grants.map(grant => (
              <li key={`${grant.membershipId ?? grant.teamId}:${grant.permission}`}>
                {state.candidates.people.find(person => person.id === grant.membershipId)?.name ??
                  state.candidates.teams.find(team => team.id === grant.teamId)?.name ??
                  'Unavailable recipient'}
                : {grant.permission}
              </li>
            ))}
          </ul>
          {workflow && !['manual', 'event'].includes(workflow.definition.trigger.kind) && (
            <section aria-label="Unattended execution" className="space-y-3 border-t pt-4">
              <h2 className="text-sm font-medium">Sponsor and run history</h2>
              <p className="text-sm">
                Choose the member this workflow acts as when it runs unattended. Another person must accept their
                sponsorship before activation. Changing this configuration pauses the workflow and gives no access to
                earlier histories.
              </p>
              {workflow.sponsor && (
                <p className="text-sm text-muted-foreground">Current unattended runs act as {workflow.sponsor.name}.</p>
              )}
              <Label htmlFor={`sponsor-${id}`}>Execution sponsor</Label>
              <Select
                value={sponsor}
                onValueChange={value => {
                  if (value) setSponsor(value);
                }}
              >
                <SelectTrigger id={`sponsor-${id}`}>
                  <SelectValue placeholder="Choose a sponsor" />
                </SelectTrigger>
                <SelectContent>
                  {state.candidates.people.map(person => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <fieldset disabled={busy} className="min-w-0 space-y-2">
                <legend>People who may read and respond to future scheduled histories</legend>
                {state.candidates.people.map(person => (
                  <Label key={person.id}>
                    <Checkbox
                      checked={audience.includes(person.id)}
                      onCheckedChange={checked =>
                        setAudience(previous =>
                          checked ? [...previous, person.id] : previous.filter(item => item !== person.id),
                        )
                      }
                    />
                    <span className="min-w-0 break-all">{person.name}</span>
                  </Label>
                ))}
              </fieldset>
              <p className="text-sm text-muted-foreground">
                Recipients need definition read access and, for provider workflows, integration use. Responding or
                cancelling also requires workflow run permission.
              </p>
              <Button
                disabled={busy || !sponsor || !audience.length}
                aria-busy={busy}
                onClick={() =>
                  void save(
                    'sponsorship',
                    { sponsorMembershipId: sponsor, historyAudience: audience },
                    sponsor === state.candidates.membershipId
                      ? 'You sponsor this revision. Activate the saved revision to start unattended runs.'
                      : 'Sponsor and audience saved. The named sponsor must accept before activation.',
                  )
                }
              >
                Save sponsor and audience
              </Button>
            </section>
          )}
        </>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={() => void load()}>
            Reload access
          </Button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function AcceptWorkflowSponsorship({
  workspaceId,
  workflow,
  changed,
}: {
  workspaceId: string;
  workflow: Workflow;
  changed: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!workflow.sponsorMembershipId || workflow.sponsorshipAccepted) return null;
  return (
    <section className="space-y-2">
      <p>
        Sponsorship is awaiting acceptance by the named sponsor. Future histories will be shared only with the selected
        audience.
      </p>
      <p className="text-sm">
        {workflow.historyAudience.length
          ? `${workflow.historyAudience.length} selected history ${workflow.historyAudience.length === 1 ? 'recipient' : 'recipients'}.`
          : 'Ask the manager for the selected audience.'}
      </p>
      <Button
        variant="outline"
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await workflowRequest(`/workspaces/${workspaceId}/workflows/${workflow.id}/sponsorship/accept`, 'POST', {
              expectedGeneration: workflow.generation,
            });
            await changed();
          } catch (failure) {
            setError(
              denied(failure)
                ? recordSourceDenied
                : 'Sponsorship could not be accepted. Only the named sponsor with current run and source access can accept.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Accept my sponsorship
      </Button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
