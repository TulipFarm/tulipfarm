import { useMemo } from 'react';
import { useFeatureRead } from '@/lib/query';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { agentApi } from './api';
import { AgentRead } from './feedback';

export function useSharingCandidates(workspaceId: string) {
  const api = useMemo(() => agentApi(workspaceId), [workspaceId]);
  return useFeatureRead({
    key: ['agents', 'sharing-candidates'],
    load: (signal: AbortSignal) => api.sharingCandidates(signal),
  });
}

export function DefinitionSharing<P extends string>({
  workspaceId,
  permissions,
  people,
  teams,
  setPeople,
  setTeams,
  disabled,
}: {
  workspaceId: string;
  permissions: readonly P[];
  people: { membershipId: string; permissions: P[] }[];
  teams: { teamId: string; permissions: P[] }[];
  setPeople: (value: { membershipId: string; permissions: P[] }[]) => void;
  setTeams: (value: { teamId: string; permissions: P[] }[]) => void;
  disabled: boolean;
}) {
  const read = useSharingCandidates(workspaceId);
  const toggle = (current: P[], permission: P, checked: boolean) => {
    const next = new Set(current);
    if (checked) {
      next.add(permission);
      const read = permissions.find(item => item === 'read');
      if (read) next.add(read);
    } else if (permission === 'read') next.clear();
    else next.delete(permission);
    return [...next];
  };
  const locked = disabled || read.state.kind !== 'ready' || read.state.refreshing;
  return (
    <section aria-label="Definition sharing" className="space-y-4">
      <h3 className="font-medium">People and teams</h3>
      <p className="text-sm text-muted-foreground">
        Managers can edit and share this definition. Sharing never reveals another person's task or run history. Keep at
        least one manager.
      </p>
      <AgentRead state={read.state} refresh={read.refresh}>
        {candidates => (
          <fieldset disabled={locked} className="space-y-4">
            <legend className="sr-only">Definition access</legend>
            {candidates.people.map(person => (
              <div key={person.membershipId} className="space-y-2">
                <p>
                  {person.name} {person.email && <span className="text-sm text-muted-foreground">{person.email}</span>}
                </p>
                <div className="flex flex-wrap gap-4">
                  {permissions.map(permission => (
                    <Label key={permission}>
                      <Checkbox
                        disabled={locked}
                        checked={people.some(
                          grant => grant.membershipId === person.membershipId && grant.permissions.includes(permission),
                        )}
                        onCheckedChange={checked =>
                          setPeople([
                            ...people.filter(grant => grant.membershipId !== person.membershipId),
                            {
                              membershipId: person.membershipId,
                              permissions: toggle(
                                people.find(grant => grant.membershipId === person.membershipId)?.permissions ?? [],
                                permission,
                                checked,
                              ),
                            },
                          ])
                        }
                      />
                      {permission}
                    </Label>
                  ))}
                </div>
              </div>
            ))}
            {candidates.teams.map(team => (
              <div key={team.id} className="space-y-2">
                <p>{team.name}</p>
                <div className="flex flex-wrap gap-4">
                  {permissions.map(permission => (
                    <Label key={permission}>
                      <Checkbox
                        disabled={locked}
                        checked={teams.some(
                          grant => grant.teamId === team.id && grant.permissions.includes(permission),
                        )}
                        onCheckedChange={checked =>
                          setTeams([
                            ...teams.filter(grant => grant.teamId !== team.id),
                            {
                              teamId: team.id,
                              permissions: toggle(
                                teams.find(grant => grant.teamId === team.id)?.permissions ?? [],
                                permission,
                                checked,
                              ),
                            },
                          ])
                        }
                      />
                      {permission}
                    </Label>
                  ))}
                </div>
              </div>
            ))}
            {!candidates.teams.length && (
              <p className="text-sm text-muted-foreground">
                You do not manage any teams. You can share with people above.
              </p>
            )}
          </fieldset>
        )}
      </AgentRead>
    </section>
  );
}
