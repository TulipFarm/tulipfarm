import type { AgentDetail } from './api';
import type { AgentTab } from './tab-values.ts';
export { agentTabValues, type AgentTab } from './tab-values.ts';

export const agentTabs: readonly {
  value: AgentTab;
  label: string;
  description: string;
  requires: 'edit' | 'manage' | 'invoke' | null;
}[] = [
  {
    value: 'overview',
    label: 'Overview',
    description: 'Check setup, then start a task with this agent.',
    requires: null,
  },
  {
    value: 'instructions',
    label: 'Instructions',
    description: 'The role, model, skills, and actions this agent may use.',
    requires: 'edit',
  },
  {
    value: 'access',
    label: 'Access',
    description: 'Who can use or manage this agent, and whose team permissions it runs with.',
    requires: 'manage',
  },
  {
    value: 'execution',
    label: 'Execution',
    description:
      'Turn execution on, limit the tables and Slack channels it may use, then activate the saved instructions.',
    requires: 'manage',
  },
  {
    value: 'slack',
    label: 'Slack',
    description: 'Attach this agent to a Slack channel so people can ask it there.',
    requires: 'invoke',
  },
  {
    value: 'schedules',
    label: 'Triggers',
    description: 'Choose how this agent starts, including repeating schedules.',
    requires: 'manage',
  },
  { value: 'settings', label: 'Settings', description: 'Technical details and deletion.', requires: null },
];

export function visibleTabs(capabilities: readonly string[]) {
  return agentTabs.filter(tab => tab.requires === null || capabilities.includes(tab.requires));
}

export type AgentStatus = { kind: 'draft' | 'active' | 'earlier' | 'off'; label: string };
type Activation = 'current' | 'earlier' | 'none';

function activationOf(detail: Pick<AgentDetail, 'activations' | 'definitionRevision'>): Activation {
  if (detail.activations.some(activation => activation.revision === detail.definitionRevision)) return 'current';
  return detail.activations.length ? 'earlier' : 'none';
}

export function agentStatus(
  detail: Pick<AgentDetail, 'activations' | 'definitionRevision'>,
  execution: ExecutionCheck,
): AgentStatus {
  const activation = activationOf(detail);
  if (activation === 'none') return { kind: 'draft', label: 'Draft' };
  if (execution === 'off') return { kind: 'off', label: 'Execution off' };
  return activation === 'current'
    ? { kind: 'active', label: 'Active' }
    : { kind: 'earlier', label: 'Active, earlier instructions' };
}

export type SetupLink =
  | { kind: 'tab'; label: string; tab: AgentTab; target: string }
  | { kind: 'models'; label: string }
  | { kind: 'retry-models'; label: string };
export type SetupStep = {
  id: 'instructions' | 'execution' | 'activation' | 'access' | 'model';
  title: string;
  status: 'done' | 'todo' | 'waiting' | 'checking';
  detail: string;
  link?: SetupLink;
};
/** `hidden`: the person cannot read execution settings; only managers can. */
export type ExecutionCheck = 'on' | 'off' | 'checking' | 'error' | 'hidden';
export type ModelCheck =
  | { kind: 'checking' }
  | { kind: 'error' }
  | { kind: 'none' }
  | { kind: 'available'; name: string }
  | { kind: 'unavailable' };

const executionSteps: Record<Exclude<ExecutionCheck, 'hidden'>, Pick<SetupStep, 'status' | 'detail' | 'link'>> = {
  checking: { status: 'checking', detail: 'Checking execution settings…' },
  error: {
    status: 'todo',
    detail: 'Execution settings could not load.',
    link: { kind: 'tab', label: 'Go to Execution', tab: 'execution', target: 'agent-execution' },
  },
  on: { status: 'done', detail: 'Execution is on.' },
  off: {
    status: 'todo',
    detail: 'Check Enable execution, then save execution settings.',
    link: { kind: 'tab', label: 'Go to Enable execution', tab: 'execution', target: 'agent-enable-execution' },
  },
};

export function agentSetup({
  detail,
  execution,
  model,
}: {
  detail: Pick<AgentDetail, 'activations' | 'definitionRevision' | 'capabilities'>;
  execution: ExecutionCheck;
  model: ModelCheck;
}): SetupStep[] {
  const can = (capability: string) => detail.capabilities.includes(capability);
  const activation = activationOf(detail);
  const steps: SetupStep[] = [
    {
      id: 'instructions',
      title: 'Save instructions',
      status: 'done',
      detail: 'The instructions are saved.',
      ...(can('edit')
        ? { link: { kind: 'tab', label: 'Edit instructions', tab: 'instructions', target: 'agent-instructions' } }
        : {}),
    },
  ];

  if (execution !== 'hidden') steps.push({ id: 'execution', title: 'Turn on execution', ...executionSteps[execution] });

  if (execution === 'hidden')
    steps.push({
      id: 'activation',
      title: 'Activate the instructions',
      status: activation === 'none' ? 'waiting' : 'done',
      detail:
        activation === 'none'
          ? 'An agent manager must turn on execution and activate the saved instructions.'
          : `${activation === 'current' ? 'The current saved instructions are' : 'An earlier version of the instructions is'} active. An agent manager controls execution, which is checked when work starts.`,
    });
  else if (activation === 'current')
    steps.push({
      id: 'activation',
      title: 'Activate the instructions',
      status: 'done',
      detail: 'The current saved instructions are active.',
    });
  else if (execution === 'checking' || execution === 'error')
    steps.push({
      id: 'activation',
      title: 'Activate the instructions',
      status: execution === 'checking' ? 'checking' : 'waiting',
      detail: 'Available after execution settings load.',
    });
  else if (execution === 'off')
    steps.push({
      id: 'activation',
      title: 'Activate the instructions',
      status: 'waiting',
      detail: 'Available after execution is turned on and saved in step 2.',
    });
  else
    steps.push({
      id: 'activation',
      title: 'Activate the instructions',
      status: 'todo',
      detail:
        activation === 'earlier'
          ? 'An earlier version is active. Activate the current saved instructions to use your latest changes.'
          : 'Activate the saved instructions so the agent can run.',
      link: { kind: 'tab', label: 'Go to Activate', tab: 'execution', target: 'agent-activate' },
    });

  if (can('invoke'))
    steps.push({
      id: 'access',
      title: 'Get run access',
      status: 'done',
      detail: 'You can start tasks with this agent.',
    });
  else if (can('manage'))
    steps.push({
      id: 'access',
      title: 'Get run access',
      status: 'todo',
      detail: 'Give yourself or one of your teams the invoke permission, then save sharing.',
      link: { kind: 'tab', label: 'Go to Access', tab: 'access', target: 'agent-ownership' },
    });
  else
    steps.push({
      id: 'access',
      title: 'Get run access',
      status: 'waiting',
      detail: 'Ask an agent manager to share run access with you.',
    });

  if (model.kind === 'checking')
    steps.push({ id: 'model', title: 'Model available', status: 'checking', detail: 'Checking model availability…' });
  else if (model.kind === 'error')
    steps.push({
      id: 'model',
      title: 'Model available',
      status: 'todo',
      detail: 'Model availability could not be checked.',
      link: { kind: 'retry-models', label: 'Check model availability again' },
    });
  else if (model.kind === 'available')
    steps.push({ id: 'model', title: 'Model available', status: 'done', detail: `${model.name} is available.` });
  else if (model.kind === 'none')
    steps.push({
      id: 'model',
      title: 'Model available',
      status: 'done',
      detail: 'No saved preference. The runtime must supply an available model.',
    });
  else
    steps.push({
      id: 'model',
      title: 'Model available',
      status: 'todo',
      detail: 'The saved model preference is unavailable.',
      link: { kind: 'models', label: 'Open model access' },
    });

  return steps;
}
