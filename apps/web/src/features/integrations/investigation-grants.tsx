import { useState } from 'react';
import { investigationGrantSchema, type IntegrationDetail } from '@tulipfarm/integrations/contracts';
import type { IntegrationCollaborators } from '@/lib/integrations';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';

const githubInvestigationPermissionSchema = investigationGrantSchema.shape.permissions.element;
type GitHubInvestigationPermission = NonNullable<
  IntegrationDetail['investigationGrants']
>[number]['permissions'][number];
const labels: Record<GitHubInvestigationPermission, string> = {
  'github.code.read': 'Code and files',
  'github.issues.read': 'Issues and comments',
  'github.pulls.read': 'Pull requests',
  'github.actions.read': 'Actions and checks',
  'github.releases.read': 'Releases',
  'github.discussions.read': 'Discussions',
};
export function InvestigationGrants({
  data,
  teams,
  members,
  locked,
  save,
}: {
  data: IntegrationDetail;
  teams: IntegrationCollaborators['teams'];
  members: IntegrationCollaborators['members'];
  locked: boolean;
  save: (input: unknown) => Promise<void>;
}) {
  const [teamGrants, setTeamGrants] = useState(data.investigationGrants ?? []);
  const [personGrants, setPersonGrants] = useState(data.investigationPersonGrants ?? []);
  const [recipient, setRecipient] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const team = recipient.startsWith('team:');
  const id = recipient.slice(recipient.indexOf(':') + 1);
  const selected = team
    ? (teamGrants.find(grant => grant.teamId === id && grant.sourceId === sourceId)?.permissions ?? [])
    : (personGrants.find(grant => grant.memberId === id && grant.sourceId === sourceId)?.permissions ?? []);
  const recipients = [
    ...teams.map(item => ({ value: `team:${item.id}`, label: `Team · ${item.name}` })),
    ...members.map(item => ({ value: `person:${item.id}`, label: `Person · ${item.name}` })),
  ];
  function update(values: string[]) {
    const permissions = githubInvestigationPermissionSchema.array().parse(values);
    if (team)
      setTeamGrants(previous => [
        ...previous.filter(grant => grant.teamId !== id || grant.sourceId !== sourceId),
        ...(permissions.length ? [{ teamId: id, sourceId, permissions }] : []),
      ]);
    else
      setPersonGrants(previous => [
        ...previous.filter(grant => grant.memberId !== id || grant.sourceId !== sourceId),
        ...(permissions.length ? [{ memberId: id, sourceId, permissions }] : []),
      ]);
    setDirty(true);
  }
  return (
    <section aria-label="GitHub investigation permissions" className="space-y-4">
      <h3 className="text-base font-medium">Investigation permissions</h3>
      <p className="text-sm text-muted-foreground">
        Grant each read capability separately for each repository. Integration use is also required. Existing
        individual-issue grants stay unchanged.
      </p>
      <Form
        label="Investigation permissions"
        disabled={locked || saving}
        onSubmit={() => {
          if (locked || saving || !dirty) return;
          setSaving(true);
          void save({
            expectedGrantsVersion: data.grantsVersion,
            grants: data.grants ?? [],
            sourceGrants: data.sourceGrants ?? [],
            investigationGrants: teamGrants,
            investigationPersonGrants: personGrants,
          }).finally(() => setSaving(false));
        }}
      >
        <div className="grid gap-4">
          <Field id={`investigation-recipient-${data.id}`} label="Person or team" required>
            <Select value={recipient} onValueChange={value => setRecipient(value ?? '')}>
              <SelectTrigger width="full">
                <SelectValue placeholder="Choose a person or team">
                  {recipients.find(item => item.value === recipient)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {recipients.map(item => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id={`investigation-repository-${data.id}`} label="Repository" required>
            <Select value={sourceId} onValueChange={value => setSourceId(value ?? '')}>
              <SelectTrigger width="full">
                <SelectValue placeholder="Choose a repository">
                  {sourceId
                    ? `${data.repositories.find(item => item.id === sourceId)?.owner}/${data.repositories.find(item => item.id === sourceId)?.repo}`
                    : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {data.repositories.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.owner}/{item.repo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {recipient && sourceId && (
            <ChoiceGroup
              type="checkbox"
              legend="Allowed GitHub reads"
              optional
              value={selected}
              onValueChange={update}
              options={githubInvestigationPermissionSchema.options.map(value => ({ value, label: labels[value] }))}
            />
          )}
          <FormFooter
            dirty={dirty}
            submit={{
              label: 'Save investigation permissions',
              pendingLabel: 'Saving permissions…',
              state: saving
                ? { kind: 'busy' }
                : locked
                  ? { kind: 'blocked', reason: 'Check the current integration status before changing permissions.' }
                  : !dirty
                    ? {
                        kind: 'blocked',
                        reason: 'Choose a person or team and repository, then change a read permission.',
                      }
                    : { kind: 'ready' },
            }}
          />
        </div>
      </Form>
    </section>
  );
}
