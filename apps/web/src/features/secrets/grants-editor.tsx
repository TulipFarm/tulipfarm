import { useId } from 'react';
import { X } from 'reicon-react/icons/X';
import { Button } from '@tulipfarm/sprout/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import type { SecretGrant } from '@/features/secrets/contracts';
import { Labelled } from '@/features/secrets/fields';

/** The people and teams a share can name; `you` is the signed-in member. */
export type People = {
  you: string;
  name: (membershipId: string) => string;
  members: { id: string; name: string }[];
  teams: { id: string; name: string }[];
};

/** The server lets only individual people manage a shared item; teams and everyone can only use it. */
export const canManage = (grant: SecretGrant) => grant.grantee.kind === 'member';

export type RoleOptions = Record<SecretGrant['role'], { label: string; hint: string }>;
export const roleOptions = {
  use: { label: 'Use it', hint: 'In their chats and tasks' },
  manage: { label: 'Use and manage it', hint: 'Also replace, change or delete it' },
} as const satisfies RoleOptions;

export function granteeKey(grant: SecretGrant) {
  return grant.grantee.kind === 'workspace'
    ? 'workspace'
    : grant.grantee.kind === 'team'
      ? `team:${grant.grantee.teamId}`
      : `member:${grant.grantee.membershipId}`;
}

export function GrantsEditor({
  value,
  owner,
  people,
  disabled,
  onChange,
  description = 'They can use it in their chats and tasks. Nobody can read it back.',
  roles = roleOptions,
}: {
  value: SecretGrant[];
  owner: string;
  people: People;
  disabled: boolean;
  onChange: (value: SecretGrant[]) => void;
  description?: string;
  roles?: RoleOptions;
}) {
  const id = useId();
  const granted = new Set(value.map(granteeKey));
  const candidates: { key: string; label: string; hint: string; grant: SecretGrant }[] = [
    {
      key: 'workspace',
      label: 'Everyone',
      hint: 'Everyone in the workspace',
      grant: { grantee: { kind: 'workspace' }, role: 'use' } satisfies SecretGrant,
    },
    ...people.teams.map(team => ({
      key: `team:${team.id}`,
      label: team.name,
      hint: 'Team',
      grant: { grantee: { kind: 'team', teamId: team.id }, role: 'use' } satisfies SecretGrant,
    })),
    ...people.members
      .filter(member => member.id !== owner)
      .map(member => ({
        key: `member:${member.id}`,
        label: member.name,
        hint: 'Person',
        grant: { grantee: { kind: 'member', membershipId: member.id }, role: 'use' } satisfies SecretGrant,
      })),
  ].filter(candidate => !granted.has(candidate.key));
  const label = (grant: SecretGrant) =>
    grant.grantee.kind === 'workspace'
      ? 'Everyone'
      : grant.grantee.kind === 'team'
        ? (people.teams.find(team => team.id === (grant.grantee.kind === 'team' ? grant.grantee.teamId : ''))?.name ??
          'A team')
        : people.name(grant.grantee.membershipId);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{description}</p>
      <ul className="space-y-2" aria-label="Who can use it">
        <li className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{owner === people.you ? 'You' : people.name(owner)}</span>
          <span className="text-muted-foreground">Owner</span>
        </li>
        {value.map((grant, index) => (
          <li key={granteeKey(grant)} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{label(grant)}</span>
            <div className="w-44">
              {!canManage(grant) ? (
                <span className="text-sm text-muted-foreground">{roles.use.label}</span>
              ) : (
                <Labelled id={`${id}-${index}`} label={`What ${label(grant)} can do`} hidden>
                  <Select
                    value={grant.role}
                    disabled={disabled}
                    onValueChange={role => {
                      if (role)
                        onChange(
                          value.map((current, position) => (position === index ? { ...current, role } : current)),
                        );
                    }}
                  >
                    <SelectTrigger id={`${id}-${index}`} width="full" size="sm">
                      <SelectValue>{roles[grant.role].label}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(['use', 'manage'] as const).map(option => (
                        <SelectItem key={option} value={option}>
                          <span className="flex flex-col">
                            <span>{roles[option].label}</span>
                            <span className="text-xs text-muted-foreground">{roles[option].hint}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Labelled>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Stop sharing with ${label(grant)}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((_, position) => position !== index))}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {candidates.length > 0 && (
        <Labelled id={`${id}-add`} label="Add someone">
          <Select
            value=""
            disabled={disabled}
            onValueChange={key => {
              const candidate = candidates.find(item => item.key === key);
              if (candidate) onChange([...value, candidate.grant]);
            }}
          >
            <SelectTrigger id={`${id}-add`} width="full">
              <SelectValue>Choose a person or team</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {candidates.map(candidate => (
                <SelectItem key={candidate.key} value={candidate.key}>
                  <span className="flex flex-col">
                    <span>{candidate.label}</span>
                    <span className="text-xs text-muted-foreground">{candidate.hint}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Labelled>
      )}
    </div>
  );
}
