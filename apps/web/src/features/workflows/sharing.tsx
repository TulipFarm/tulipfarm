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
  const levels = provider
    ? [
        { value: 'use', label: 'Can use', permissions: ['use'] },
        { value: 'manage', label: 'Can manage', permissions: ['use', 'manage'] },
      ]
    : [
        { value: 'read', label: 'Can view', permissions: ['read'] },
        { value: 'invoke', label: 'Can run', permissions: ['read', 'invoke'] },
        { value: 'manage', label: 'Can manage', permissions: ['read', 'invoke', 'manage'] },
      ];
  const levelOf = (permissions: string[]) =>
    [...levels].reverse().find(level => permissions.includes(level.value))?.value ?? '';
  const share = (key: string, value: string) => {
    const [kind, target] = key.split(':');
    void save(
      'grants',
      { principal: { kind, id: target }, permissions: levels.find(item => item.value === value)?.permissions ?? [] },
      value ? 'Access saved.' : 'Access removed.',
    );
  };
  return (
    <section aria-label={provider ? 'Provider sharing' : 'Workflow sharing'} className="space-y-6">
      {state.kind === 'loading' && (
        <StatePanel kind="loading" title="Loading access" description="Checking who can use this." />
      )}
      {state.kind === 'error' && (
        <StatePanel kind="error" title="Access could not load" description="Check your access and retry.">
          <Button variant="outline" onClick={() => void load()}>
            Reload access
          </Button>
        </StatePanel>
      )}
      {state.kind === 'ready' &&
        (() => {
          const personName = (person: { id: string; name: string }) =>
            person.id === state.candidates.membershipId ? 'You' : person.name;
          const holders = new Map<string, { name: string; permissions: string[] }>();
          for (const grant of state.grants) {
            const key = grant.membershipId ? `person:${grant.membershipId}` : `team:${grant.teamId}`;
            const person = state.candidates.people.find(item => item.id === grant.membershipId);
            const team = state.candidates.teams.find(item => item.id === grant.teamId);
            const holder = holders.get(key) ?? {
              name: person ? personName(person) : team ? `Team: ${team.name}` : 'Unavailable recipient',
              permissions: [],
            };
            holder.permissions.push(grant.permission);
            holders.set(key, holder);
          }
          return (
            <>
              <div className="space-y-3">
                <div className="space-y-0.5">
                  <h2 className="font-medium">Access</h2>
                  <p className="text-sm text-muted-foreground">
                    {provider ? 'Credentials stay private.' : 'Each person’s run history stays private.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    items={[
                      ...state.candidates.people.map(person => ({
                        value: `person:${person.id}`,
                        label: personName(person),
                      })),
                      ...state.candidates.teams.map(team => ({
                        value: `team:${team.id}`,
                        label: `Team: ${team.name}`,
                      })),
                    ]}
                    value={principal}
                    onValueChange={value => {
                      if (!value) return;
                      setPrincipal(value);
                      setPermissions(
                        levels.find(level => level.value === levelOf(holders.get(value)?.permissions ?? []))
                          ?.permissions ?? levels[0]!.permissions,
                      );
                    }}
                  >
                    <SelectTrigger id={`share-${id}`} aria-label="Person or team">
                      <SelectValue placeholder="Add a person or team" />
                    </SelectTrigger>
                    <SelectContent>
                      {state.candidates.people.map(person => (
                        <SelectItem key={person.id} value={`person:${person.id}`}>
                          {personName(person)}
                        </SelectItem>
                      ))}
                      {state.candidates.teams.map(team => (
                        <SelectItem key={team.id} value={`team:${team.id}`}>
                          Team: {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    items={levels}
                    value={levelOf(permissions)}
                    disabled={busy || !principal}
                    onValueChange={value => {
                      if (value) setPermissions(levels.find(level => level.value === value)?.permissions ?? []);
                    }}
                  >
                    <SelectTrigger aria-label="Access level">
                      <SelectValue placeholder="Access" />
                    </SelectTrigger>
                    <SelectContent>
                      {levels.map(level => (
                        <SelectItem key={level.value} value={level.value}>
                          {level.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={busy || !principal || !permissions.length}
                    aria-busy={busy}
                    onClick={() => {
                      share(principal, levelOf(permissions));
                      setPrincipal('');
                    }}
                  >
                    Share
                  </Button>
                </div>
                {holders.size > 0 && (
                  <ul
                    aria-label="People with access"
                    className="divide-y divide-border rounded-lg border border-border"
                  >
                    {[...holders].map(([key, holder]) => (
                      <li key={key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 truncate">{holder.name}</span>
                        <Select
                          items={[...levels, { value: 'remove', label: 'Remove access' }]}
                          value={levelOf(holder.permissions)}
                          disabled={busy}
                          onValueChange={value => {
                            if (value) share(key, value === 'remove' ? '' : value);
                          }}
                        >
                          <SelectTrigger size="sm" aria-label={`Access for ${holder.name}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {levels.map(level => (
                              <SelectItem key={level.value} value={level.value}>
                                {level.label}
                              </SelectItem>
                            ))}
                            <SelectItem value="remove">Remove access</SelectItem>
                          </SelectContent>
                        </Select>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {workflow && !['manual', 'event'].includes(workflow.definition.trigger.kind) && (
                <section aria-label="Scheduled runs" className="space-y-4 border-t border-border pt-6">
                  <div className="space-y-0.5">
                    <h2 className="font-medium">Scheduled runs</h2>
                    <p className="text-sm text-muted-foreground">
                      Changes pause the workflow until the person it runs as accepts.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`sponsor-${id}`}>Runs as</Label>
                    <Select
                      items={state.candidates.people.map(person => ({ value: person.id, label: personName(person) }))}
                      value={sponsor}
                      onValueChange={value => {
                        if (value) setSponsor(value);
                      }}
                    >
                      <SelectTrigger id={`sponsor-${id}`}>
                        <SelectValue placeholder="Choose a person" />
                      </SelectTrigger>
                      <SelectContent>
                        {state.candidates.people.map(person => (
                          <SelectItem key={person.id} value={person.id}>
                            {personName(person)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <fieldset disabled={busy} className="min-w-0 space-y-2">
                    <legend className="mb-2 text-sm font-medium">Who sees scheduled runs</legend>
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
                        <span className="min-w-0 truncate">{personName(person)}</span>
                      </Label>
                    ))}
                  </fieldset>
                  <Button
                    variant="outline"
                    disabled={busy || !sponsor || !audience.length}
                    aria-busy={busy}
                    onClick={() =>
                      void save(
                        'sponsorship',
                        { sponsorMembershipId: sponsor, historyAudience: audience },
                        sponsor === state.candidates.membershipId
                          ? 'Saved. Activate the saved revision to start scheduled runs.'
                          : 'Saved. Waiting for them to accept.',
                      )
                    }
                  >
                    Save scheduled runs
                  </Button>
                </section>
              )}
            </>
          );
        })()}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Reload access
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </section>
  );
}

export function AcceptWorkflowSponsorship({
  workspaceId,
  workflow,
  userId,
  changed,
}: {
  workspaceId: string;
  workflow: Workflow;
  userId: string;
  changed: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!workflow.sponsorMembershipId || workflow.sponsorshipAccepted) return null;
  return (
    <section aria-label="Sponsorship" className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-0.5">
        <h2 className="font-medium">Waiting for sponsor</h2>
        <p className="text-sm text-muted-foreground">
          {workflow.sponsor?.userId === userId
            ? 'You were chosen as the sponsor. Scheduled runs start after you accept.'
            : `Scheduled runs start after ${workflow.sponsor?.name ?? 'the sponsor'} accepts.`}
        </p>
      </div>
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
                : 'Only the named sponsor, with current run and source access, can accept.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Accept sponsorship
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:basis-full">
          {error}
        </p>
      )}
    </section>
  );
}
