import { useState, type ReactNode } from 'react';
import { ActionGroup, type ButtonState } from '@tulipfarm/sprout/button';
import { CheckboxField, ChoiceGroup, Field, type ChoiceOption } from '@tulipfarm/sprout/field';
import { Form, FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Input } from '@tulipfarm/sprout/input';
import { Disclosure } from '@/components/disclosure';
import { TablePicker } from '@/features/tables/table-picker';
import { useTableWrite } from '@/features/tables/use-table-write';
import { UnsavedChanges, WriteFeedback } from '@/features/tables/feedback';
import { useAgentPolicy } from './queries';
import { AgentRead } from './feedback';
import type { agentApi, AgentContext } from './api';
import { SlackDestinations } from './slack-destinations';
import { DefinitionSharing } from './sharing';
import {
  enrollmentInput,
  executionInput,
  slackSenderLabel,
  sameAccess,
  sameTeams,
  type Policy,
  type RecordPermission,
  type TeamPermission,
} from './administration';
import { taskLimitFields } from '../tasks/limits';
import { ScopeSummary } from './reference-names';

type Api = ReturnType<typeof agentApi>;
type Operation =
  | { kind: 'policy'; input: Parameters<Api['updatePolicy']>[1] }
  | { kind: 'execution' | 'enrollment'; input: Parameters<Api['configure']>[1] };
type Section = Operation['kind'];

const sharingPermissions: readonly TeamPermission[] = ['read', 'edit', 'delete', 'invoke', 'manage'];
const recordPermissionOptions: ChoiceOption<RecordPermission>[] = [
  { value: 'table.row.read', label: 'Read rows', disabled: true },
  { value: 'table.row.create', label: 'Create rows' },
  { value: 'table.row.update', label: 'Update rows' },
  { value: 'table.row.delete', label: 'Delete rows' },
];
const readRecords: RecordPermission[] = ['table.row.read'];

export type PolicyParts = { notice: ReactNode; access: ReactNode; execution: ReactNode };

export function AgentPolicy({
  api,
  id,
  workspaceId,
  slug,
  teams,
  concealed,
  refresh,
  children,
}: {
  api: Api;
  id: string;
  workspaceId: string;
  slug: string;
  teams: AgentContext['teams'];
  concealed: boolean;
  refresh: () => Promise<void>;
  children: (parts: PolicyParts) => ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Policy | null>(null);
  const read = useAgentPolicy(api, id, !concealed);
  if (read.state.kind === 'ready' && snapshot !== read.state.data) setSnapshot(read.state.data);
  const status = !concealed && (
    <AgentRead state={read.state} refresh={read.refresh}>
      {() => null}
    </AgentRead>
  );
  if (!snapshot) return children({ notice: null, access: status, execution: status });
  return (
    <PolicyForm
      api={api}
      id={id}
      workspaceId={workspaceId}
      slug={slug}
      policy={snapshot}
      teams={teams}
      status={status}
      concealed={concealed || read.state.kind !== 'ready'}
      refreshing={read.state.kind === 'ready' && read.state.refreshing}
      refresh={async () => {
        await read.refresh();
        await refresh();
      }}
    >
      {children}
    </PolicyForm>
  );
}

function PolicyForm({
  api,
  id,
  workspaceId,
  slug,
  policy,
  teams,
  status,
  refresh,
  concealed,
  refreshing,
  children,
}: {
  api: Api;
  id: string;
  workspaceId: string;
  slug: string;
  policy: Policy;
  teams: AgentContext['teams'];
  status: ReactNode;
  refresh: () => Promise<void>;
  concealed: boolean;
  refreshing: boolean;
  children: (parts: PolicyParts) => ReactNode;
}) {
  const [base, setBase] = useState(policy);
  const [owner, setOwner] = useState(policy.owningTeamId);
  const [grants, setGrants] = useState(policy.grants);
  const [personGrants, setPersonGrants] = useState(policy.personGrants);
  const [enrollment, setEnrollment] = useState(policy.enrollment);
  const [enabled, setEnabled] = useState(policy.enabled);
  const [readTable, setReadTable] = useState('');
  const [tablePermissions, setTablePermissions] = useState(readRecords);
  const [limits, setLimits] = useState(policy.limits);
  const [taskLimits, setTaskLimits] = useState(policy.taskLimits);
  const [slackSender, setSlackSender] = useState(policy.slackSender);
  const [review, setReview] = useState<{ policy: Policy; reloaded: boolean } | null>(null);
  const [submitted, setSubmitted] = useState<Section | null>(null);
  const write = useTableWrite(
    async (operation: Operation) => {
      setSubmitted(operation.kind);
      try {
        if (operation.kind === 'policy') await api.updatePolicy(id, operation.input);
        if (operation.kind === 'execution' || operation.kind === 'enrollment') await api.configure(id, operation.input);
      } catch (error) {
        setReview({ policy, reloaded: false });
        throw error;
      }
      return operation;
    },
    operation => {
      if (operation.kind === 'policy')
        setBase(previous => ({ ...previous, ...operation.input, version: operation.input.version + 1 }));
      if (operation.kind === 'execution' || operation.kind === 'enrollment') {
        setBase(previous => ({
          ...previous,
          version: operation.input.version + 1,
          enrollment: operation.input.teamIds,
          limits: operation.input.limits,
          taskLimits: operation.input.taskLimits,
          enabled: operation.input.enabled,
          slackSender: operation.input.slackSender ?? previous.slackSender,
        }));
        if (operation.kind === 'execution') {
          setLimits(operation.input.limits);
          setTaskLimits(operation.input.taskLimits);
          setEnabled(operation.input.enabled);
          setReadTable('');
          setTablePermissions(readRecords);
        }
      }
      setReview(null);
    },
  );
  const dirty = {
    ownership:
      owner !== base.owningTeamId ||
      !sameAccess(grants, base.grants, grant => grant.teamId) ||
      !sameAccess(personGrants, base.personGrants, grant => grant.membershipId),
    enrollment: !sameTeams(enrollment, base.enrollment),
    execution:
      enabled !== base.enabled ||
      !sameAccess(limits, base.limits, limit => limit.assetId) ||
      taskLimitFields.some(field => taskLimits[field.key] !== base.taskLimits[field.key]) ||
      !!readTable ||
      slackSender !== base.slackSender,
  };
  const unsaved = (
    <UnsavedChanges
      dirty={dirty.ownership || dirty.enrollment || dirty.execution || write.state.kind === 'uncertain'}
    />
  );
  if (concealed) return children({ notice: unsaved, access: status, execution: status });

  async function reload() {
    await refresh();
    setReview(current => current && { ...current, reloaded: true });
  }
  const changedElsewhere = policy.version > base.version;
  const sending = write.state.kind === 'sending';
  const state: ButtonState = sending
    ? { kind: 'busy' }
    : write.state.kind === 'uncertain'
      ? { kind: 'blocked', reason: 'Check whether the last change went through first.' }
      : review || changedElsewhere
        ? {
            kind: 'blocked',
            reason: 'Choose which settings to keep above first.',
            fix: { kind: 'jump', label: 'Go to review', target: 'agent-admin-review' },
          }
        : refreshing
          ? { kind: 'blocked', reason: 'Wait for the refresh to finish.' }
          : { kind: 'ready' };
  const locked = state.kind !== 'ready';
  const reviewState: ButtonState =
    refreshing || sending
      ? { kind: 'busy' }
      : review && !review.reloaded && policy === review.policy
        ? {
            kind: 'blocked',
            reason: 'Refresh administration to load the latest settings.',
            fix: { kind: 'action', label: 'Refresh administration', onClick: () => void reload() },
          }
        : { kind: 'ready' };
  const teamName = (teamId: string | null) => teams.find(team => team.id === teamId)?.name ?? 'Personal agent';
  const save = (section: Section, label: string, pendingLabel: string) => ({
    label,
    pendingLabel: submitted === section ? pendingLabel : label,
    state,
  });
  const discard = (onReset: () => void) => ({ kind: 'reset' as const, label: 'Discard changes', onReset });
  const feedback = (section: Section): ReactNode =>
    submitted === section && (
      <>
        <WriteFeedback state={write.state} checkStatus={() => void reload()} />
        {write.state.kind === 'accepted' && (
          <p role="status" className="text-sm text-muted-foreground">
            Administration saved.
          </p>
        )}
      </>
    );
  const submit = (operation: Operation) => {
    void write.submit(operation);
  };
  const keepDraft = () => {
    setBase(policy);
    setLimits(policy.limits);
    setTaskLimits(policy.taskLimits);
    setReview(null);
    write.reset();
  };
  const adoptCurrent = () => {
    setBase(policy);
    setOwner(policy.owningTeamId);
    setGrants(policy.grants);
    setPersonGrants(policy.personGrants);
    setEnrollment(policy.enrollment);
    setEnabled(policy.enabled);
    setLimits(policy.limits);
    setTaskLimits(policy.taskLimits);
    setSlackSender(policy.slackSender);
    setReadTable('');
    setTablePermissions(readRecords);
    setReview(null);
    write.reset();
  };

  return children({
    notice: (
      <>
        {unsaved}
        {(changedElsewhere || review) && (
          <section
            id="agent-admin-review"
            aria-label="Review agent administration"
            className="grid gap-3 rounded-xl border bg-warning-subtle p-4 sm:p-5"
          >
            <h2 className="text-base font-medium text-foreground">Review current administration</h2>
            <p className="text-sm text-foreground">
              {changedElsewhere
                ? 'Newer settings were saved. Your draft is kept; choose which settings to use.'
                : write.state.kind === 'uncertain'
                  ? 'We could not confirm your last change. Your draft is kept; refresh administration, then choose which settings to use.'
                  : 'Your last change was not saved. Your draft is kept; refresh administration, then choose which settings to use.'}
            </p>
            <ActionGroup
              state={reviewState}
              actions={[
                { label: 'Keep my draft against this version', variant: 'outline', onClick: keepDraft },
                { label: 'Use current administration', variant: 'outline', onClick: adoptCurrent },
              ]}
            />
          </section>
        )}
      </>
    ),
    access: (
      <div className="grid gap-4">
        {status}
        <FormSection
          id="agent-ownership"
          title="Placement and sharing"
          description="Where this agent is listed and who can use or manage it."
        >
          <Form
            disabled={locked}
            onSubmit={() =>
              submit({ kind: 'policy', input: { version: base.version, owningTeamId: owner, grants, personGrants } })
            }
          >
            <div className="grid gap-5">
              <Field
                id="transfer-agent-owner"
                label="Team placement"
                optional
                helper="Placement grants no access. Share the agent below to grant access."
              >
                <Select
                  value={owner ?? 'personal'}
                  onValueChange={value => {
                    if (value) setOwner(value === 'personal' ? null : value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>{teamName(owner)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">Personal agent</SelectItem>
                    {teams.map(team => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <DefinitionSharing
                workspaceId={workspaceId}
                permissions={sharingPermissions}
                people={personGrants}
                teams={grants}
                setPeople={setPersonGrants}
                setTeams={setGrants}
                disabled={locked}
              />
              <FormFooter
                dirty={dirty.ownership}
                cancel={discard(() => {
                  setOwner(base.owningTeamId);
                  setGrants(base.grants);
                  setPersonGrants(base.personGrants);
                })}
                submit={save('policy', 'Save sharing', 'Saving sharing…')}
              >
                {feedback('policy')}
              </FormFooter>
            </div>
          </Form>
        </FormSection>
        <FormSection
          id="agent-enrollment"
          title="Team enrollment"
          description="Teams whose permissions this agent uses when it runs."
        >
          <Form
            disabled={locked}
            onSubmit={() => submit({ kind: 'enrollment', input: enrollmentInput(base, enrollment) })}
          >
            <div className="grid gap-5">
              <ChoiceGroup
                type="checkbox"
                layout="columns"
                optional
                legend="Teams"
                helper="Removing a team can stop runs that rely on its access."
                options={teams.map(team => ({ value: team.id, label: team.name }))}
                value={enrollment}
                onValueChange={setEnrollment}
              />
              <FormFooter
                dirty={dirty.enrollment}
                cancel={discard(() => setEnrollment(base.enrollment))}
                submit={save('enrollment', 'Save enrollment', 'Saving enrollment…')}
              >
                {feedback('enrollment')}
              </FormFooter>
            </div>
          </Form>
        </FormSection>
      </div>
    ),
    execution: (
      <div className="grid gap-4">
        {status}
        <FormSection
          id="agent-execution"
          title="Execution"
          description="Whether this agent can run, and the rows it may use."
        >
          <Form
            disabled={locked}
            onSubmit={() =>
              submit({
                kind: 'execution',
                input: executionInput(base, {
                  enabled,
                  limits,
                  taskLimits,
                  slackSender,
                  resource: readTable,
                  tablePermissions,
                }),
              })
            }
          >
            <div className="grid gap-5">
              <CheckboxField
                id="agent-enable-execution"
                label="Enable execution"
                helper="Applies to every task and schedule for this agent."
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <TablePicker
                workspaceId={workspaceId}
                teams={teams}
                id="agent-read-resource"
                label="Add table read limit"
                required={false}
                value={readTable}
                disabled={locked}
                onChange={setReadTable}
              />
              {readTable && (
                <ChoiceGroup
                  type="checkbox"
                  optional
                  legend="Permissions for this table"
                  helper="The agent's teams still need access to this table."
                  options={recordPermissionOptions}
                  value={tablePermissions}
                  onValueChange={setTablePermissions}
                />
              )}
              <Disclosure title={`Saved execution limits (${limits.length})`}>
                <p className="break-words text-sm">
                  <ScopeSummary workspaceId={workspaceId} scope={limits} />
                </p>
              </Disclosure>
              <div className="grid gap-4 sm:grid-cols-3">
                {taskLimitFields.map(field => (
                  <Field
                    key={field.key}
                    id={`agent-${field.key}`}
                    label={`Maximum ${field.label.toLowerCase()}`}
                    helper={`Up to ${field.max.toLocaleString('en-US')} ${field.unit}.`}
                    required
                  >
                    <Input
                      type="number"
                      min={field.min}
                      max={field.max}
                      value={taskLimits[field.key] / field.storedPerShown}
                      onChange={event =>
                        setTaskLimits(previous => ({
                          ...previous,
                          [field.key]: Number(event.target.value) * field.storedPerShown,
                        }))
                      }
                    />
                  </Field>
                ))}
              </div>
              <Field
                id="agent-slack-sender"
                label="Post Slack messages as"
                required
                helper="The TulipFarm app must be added to each channel. Your personal account posts under your name."
              >
                <Select
                  value={slackSender}
                  onValueChange={value => {
                    if (value === 'app' || value === 'user') setSlackSender(value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>{slackSenderLabel(slackSender)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="app">{slackSenderLabel('app')}</SelectItem>
                    <SelectItem value="user">{slackSenderLabel('user')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <FormFooter
                dirty={dirty.execution}
                cancel={discard(() => {
                  setEnabled(base.enabled);
                  setLimits(base.limits);
                  setTaskLimits(base.taskLimits);
                  setReadTable('');
                  setTablePermissions(readRecords);
                  setSlackSender(base.slackSender);
                })}
                submit={save('execution', 'Save execution settings', 'Saving execution settings…')}
              >
                {feedback('execution')}
              </FormFooter>
            </div>
          </Form>
        </FormSection>
        <SlackDestinations
          workspaceId={workspaceId}
          slug={slug}
          teams={teams}
          administration={state}
          addLimit={(assetId, permissions) =>
            setLimits(previous => [...previous.filter(item => item.assetId !== assetId), { assetId, permissions }])
          }
        />
      </div>
    ),
  });
}
