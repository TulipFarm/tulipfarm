import { useId, useState } from 'react';
import type { z } from 'zod';
import { workflowSchema, type Definition } from '@tulipfarm/workflows/contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { useGitHubAccounts } from '@/features/integrations/queries';
import { accountLabel, useOwnPlans, type PlanProvider } from '@/features/models/plan-accounts';
import { providerLabels } from '@/features/models/subscription-sharing';
import { workflowRequest, WorkflowRequestError } from './api';
import { describeValue } from './definition-description';

type Workflow = z.infer<typeof workflowSchema>;
type CodingStep = Extract<Definition['steps'][number], { kind: 'coding' }>;

const agents: Record<CodingStep['agent'], { name: string; provider: PlanProvider }> = {
  'claude-code': { name: 'Claude Code', provider: 'claude' },
  codex: { name: 'Codex', provider: 'chatgpt' },
  copilot: { name: 'Copilot', provider: 'copilot' },
};

const firstOn = 'first';

/**
 * Lets the workflow's manager pick, per coding step, which of their accounts runs it first: the plan account the
 * coding agent uses and the GitHub login that clones and pushes. Unpicked, a run uses the first account on for coding.
 */
export function CodingStepAccounts({
  workspaceId,
  workflow,
  blocked,
  onSaved,
  onDenied,
}: {
  workspaceId: string;
  workflow: Workflow;
  blocked: boolean;
  onSaved: (workflow: Workflow) => void;
  onDenied: () => void;
}) {
  const steps = workflow.definition.steps.filter((step): step is CodingStep => step.kind === 'coding');
  const editable = workflow.capabilities.manage && !workflow.archivedAt;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!steps.length || !editable) return null;

  async function save(step: CodingStep, change: Partial<Pick<CodingStep, 'githubAccount' | 'planConnectionId'>>) {
    setBusy(true);
    setFailure(null);
    const next: CodingStep = { ...step, ...change };
    if (!next.githubAccount) delete next.githubAccount;
    if (!next.planConnectionId) delete next.planConnectionId;
    try {
      const result = await workflowRequest(`/workspaces/${workspaceId}/workflows/${workflow.id}`, 'PUT', {
        revision: crypto.randomUUID(),
        expectedRevision: workflow.revision,
        definition: {
          ...workflow.definition,
          steps: workflow.definition.steps.map(item => (item.id === step.id ? next : item)),
        },
      });
      onSaved(workflowSchema.parse(result));
    } catch (error) {
      if (error instanceof WorkflowRequestError && [401, 403, 404].includes(error.status)) return onDenied();
      setFailure(
        error instanceof WorkflowRequestError && ['stale-revision', 'revision-conflict'].includes(error.code)
          ? 'This workflow changed since you opened it. Refresh the page and pick the account again.'
          : 'Couldn’t save your account choice. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="coding-step-accounts" className="space-y-3">
      <div className="space-y-1">
        <h2 id="coding-step-accounts" className="text-base font-semibold">
          Coding accounts
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Pick the account each coding step tries first. If it runs out of usage, the next account with Coding on takes
          over.
        </p>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {steps.map(step => (
          <CodingStepRow
            key={step.id}
            workspaceId={workspaceId}
            step={step}
            disabled={blocked || busy}
            onChange={change => void save(step, change)}
          />
        ))}
      </ul>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function CodingStepRow({
  workspaceId,
  step,
  disabled,
  onChange,
}: {
  workspaceId: string;
  step: CodingStep;
  disabled: boolean;
  onChange: (change: Partial<Pick<CodingStep, 'githubAccount' | 'planConnectionId'>>) => void;
}) {
  const id = useId();
  const agent = agents[step.agent];
  const plans = useOwnPlans(workspaceId, agent.provider).filter(
    plan => plan.state === 'connected' && (plan.useForCoding || plan.connectionId === step.planConnectionId),
  );
  const github = useGitHubAccounts(workspaceId);
  const logins =
    github.state.kind === 'ready'
      ? github.state.data.accounts.flatMap(account =>
          account.identity &&
          account.state === 'active' &&
          (account.useForCoding || account.identity.login === step.githubAccount)
            ? [{ login: account.identity.login, on: account.useForCoding }]
            : [],
        )
      : [];
  const planOptions = [
    { value: firstOn, label: 'First account with Coding on' },
    ...plans.map(plan => ({
      value: plan.connectionId,
      label: `${accountLabel(agent.provider, plan.account)}${plan.useForCoding ? '' : ' (Coding off)'}`,
    })),
  ];
  const loginOptions = [
    { value: firstOn, label: 'First login with Coding on' },
    ...logins.map(item => ({ value: item.login, label: `@${item.login}${item.on ? '' : ' (Coding off)'}` })),
  ];
  const repository =
    step.repository.kind === 'literal' ? String(step.repository.value) : describeValue(step.repository);
  return (
    <li className="grid gap-3 px-4 py-3 sm:grid-cols-3 sm:items-end">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-sm font-medium">{agent.name}</p>
        <p className="truncate text-sm text-muted-foreground">{repository}</p>
      </div>
      <AccountSelect
        id={`${id}-plan`}
        label={`${providerLabels[agent.provider]} account`}
        options={planOptions}
        value={step.planConnectionId ?? firstOn}
        disabled={disabled}
        onChange={value => onChange({ planConnectionId: value === firstOn ? undefined : value })}
      />
      <AccountSelect
        id={`${id}-github`}
        label="GitHub login"
        options={loginOptions}
        value={step.githubAccount ?? firstOn}
        disabled={disabled}
        onChange={value => onChange({ githubAccount: value === firstOn ? undefined : value })}
      />
    </li>
  );
}

function AccountSelect({
  id,
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  options: { value: string; label: string }[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const chosen = options.find(option => option.value === value);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={next => {
          if (typeof next === 'string' && next !== value) onChange(next);
        }}
      >
        <SelectTrigger id={id} width="full" size="sm">
          <SelectValue>{chosen?.label ?? 'Account no longer connected'}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
