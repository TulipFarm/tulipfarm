import type {
  InstallationNode,
  SystemPackage,
  SystemPackageInstallation,
} from '@tulipfarm/agents/system-package-contracts';
import {
  PlanOutline,
  type PlanOutlineMark,
  type PlanOutlineTone,
  type PlanOutlineTask,
} from '@tulipfarm/sprout/plan-outline';
import type { ReactNode } from 'react';
import { Database } from 'reicon-react/icons/Database';
import { BookOpen } from 'reicon-react/icons/BookOpen';
import { Users } from 'reicon-react/icons/Users';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { AddCircle } from 'reicon-react/icons/AddCircle';
import { Files } from 'reicon-react/icons/Files';
import { Plug } from 'reicon-react/icons/Plug';

const verificationCriteria = [
  'The server reads back every installed resource and verifies its requested configuration.',
];
type Resource = SystemPackage['resources'][number];
export const resourceTypes = {
  table: { icon: <Database />, label: 'Table' },
  'seed-row': { icon: <AddCircle />, label: 'Starter record' },
  skill: { icon: <BookOpen />, label: 'Skill' },
  agent: { icon: <Users />, label: 'Agent' },
  workflow: { icon: <BranchDown />, label: 'Workflow' },
  integration: { icon: <Plug />, label: 'Integration' },
  file: { icon: <Files />, label: 'File' },
} satisfies Record<Resource['kind'], NonNullable<PlanOutlineTask['typeIcon']>>;

export function resourceTitle(resource: Resource, resources: Resource[], assets: SystemPackage['assets']): string {
  switch (resource.kind) {
    case 'table':
      return `Create ${resource.label}`;
    case 'seed-row': {
      const table = resources.find(item => item.key === resource.table.key);
      const name = resource.values.name ?? resource.values.title;
      return `Add ${name?.kind === 'text' ? name.value : 'starter record'} to ${table?.kind === 'table' ? table.label : 'the selected table'}`;
    }
    case 'skill': {
      const file = resource.files.find(file => file.path === 'SKILL.md');
      const asset = assets.find(asset => asset.key === file?.asset);
      const name =
        asset?.encoding === 'utf8'
          ? /^name:\s*(.+)$/m
              .exec(asset.content)?.[1]
              ?.replace(/^["']|["']$/g, '')
              .replaceAll('-', ' ')
          : undefined;
      return name ? `Install ${name}` : 'Install the packaged procedure';
    }
    case 'agent':
      return `Set up ${resource.definition.name}`;
    case 'workflow':
      return `${resource.requestedState === 'enabled' ? 'Enable' : 'Save'} ${resource.name}`;
    case 'integration':
      return 'Bind the authorized connection';
    case 'file':
      return `Save ${resource.name}`;
  }
}

const groups = {
  records: {
    title: 'Records and starter data',
    brief: 'Create record structures and add the packaged starter records.',
  },
  automation: {
    title: 'Procedure and automation',
    brief: 'Set up the packaged procedure, agents and workflows in their requested states.',
  },
  connections: {
    title: 'Authorized connections',
    brief: 'Use existing connections without changing credentials or consent.',
  },
  files: { title: 'Packaged files', brief: 'Save the files included in this package.' },
};

function groupKind(kind: InstallationNode['kind']): keyof typeof groups | null {
  if (kind === 'verify') return null;
  if (kind === 'table' || kind === 'seed-row') return 'records';
  if (kind === 'integration') return 'connections';
  if (kind === 'file') return 'files';
  return 'automation';
}

function groupedTasks(rows: { kind: InstallationNode['kind']; task: PlanOutlineTask }[]): PlanOutlineTask[] {
  const result: PlanOutlineTask[] = [];
  let current: { kind: keyof typeof groups; children: PlanOutlineTask[]; group: PlanOutlineTask } | undefined;
  for (const { kind, task } of rows) {
    const category = groupKind(kind);
    if (!category) {
      current = undefined;
      result.push(task);
      continue;
    }
    if (current?.kind !== category) {
      const children: PlanOutlineTask[] = [];
      const group: PlanOutlineTask = {
        id: `$group:${task.id}`,
        ...groups[category],
        mark: 'pending',
        label: '',
        children,
      };
      current = { kind: category, children, group };
      result.push(group);
    }
    current.children.push(task);
    const children = current.children;
    const done = children.filter(child => child.mark === 'done').length;
    current.group.label = `${done} of ${current.children.length} complete`;
    current.group.mark =
      done === current.children.length
        ? 'done'
        : ((['failed', 'blocked', 'attention', 'running'] as const).find(mark =>
            children.some(child => child.mark === mark),
          ) ?? 'pending');
  }
  return result;
}

const nodeMarks: Record<InstallationNode['state'], PlanOutlineMark> = {
  pending: 'pending',
  'waiting-review': 'attention',
  running: 'running',
  saved: 'attention',
  completed: 'done',
  failed: 'failed',
  blocked: 'blocked',
};
const nodeLabels: Record<InstallationNode['state'], string> = {
  pending: 'Not started',
  'waiting-review': 'Needs review in chat',
  running: 'Installing',
  saved: 'Saved; setup remains',
  completed: 'Done',
  failed: 'Needs attention',
  blocked: 'Blocked',
};
const installationStatus: Record<SystemPackageInstallation['status'], { status: string; tone: PlanOutlineTone }> = {
  pending: { status: 'Ready to start', tone: 'neutral' },
  'waiting-review': { status: 'Needs review in chat', tone: 'attention' },
  running: { status: 'Installing', tone: 'active' },
  blocked: { status: 'Blocked', tone: 'attention' },
  failed: { status: 'Needs attention', tone: 'failed' },
  completed: { status: 'Verified', tone: 'done' },
};

export function PackagePlanOutline({ document, order }: { document: SystemPackage; order?: string[] | undefined }) {
  const resources = order
    ? order.flatMap(key => document.resources.filter(resource => resource.key === key))
    : document.resources;
  return (
    <PlanOutline
      title="Installation plan"
      brief={`${document.package.description} ${order ? 'Steps follow the checked dependency order.' : 'Shown in file order, not execution order. Check package and access in chat to confirm the order.'}`}
      status="Not installed"
      tone="neutral"
      tasks={groupedTasks([
        ...resources.map(resource => ({
          kind: resource.kind,
          task: {
            id: resource.key,
            title: resourceTitle(resource, document.resources, document.assets),
            typeIcon: resourceTypes[resource.kind],
            mark: 'pending' as const,
            label: 'Not started',
            brief: `Package reference: ${resource.key}`,
          },
        })),
        {
          kind: 'verify',
          task: {
            id: '$verify',
            title: 'Final verification',
            mark: 'pending' as const,
            label: 'Required final step',
            criteria: verificationCriteria,
          },
        },
      ])}
      progress={`${document.resources.length} resources, followed by verification`}
    />
  );
}

export function InstallationOutline({ view, stale }: { view: SystemPackageInstallation; stale?: ReactNode }) {
  const resources = view.nodes.flatMap(node => (node.definition ? [node.definition] : []));
  const titles = new Map(
    view.nodes.map(node => [
      node.key,
      node.kind === 'verify'
        ? 'Final verification'
        : node.definition
          ? resourceTitle(node.definition, resources, view.assets)
          : node.title,
    ]),
  );
  const ordered = [
    ...view.nodes.filter(node => node.kind !== 'verify'),
    ...view.nodes.filter(node => node.kind === 'verify'),
  ];
  const verification = view.nodes.find(node => node.key === '$verify' && node.kind === 'verify');
  const verified = installationVerified(view);
  const status =
    view.status === 'completed' && !verified
      ? { status: 'Verification missing', tone: 'attention' as const }
      : installationStatus[view.status];
  return (
    <PlanOutline
      title="Installation progress"
      brief={`${view.package.description} Groups are for reading only; steps retain the server's execution order and dependencies.`}
      status={status.status}
      tone={status.tone}
      stale={stale}
      progress={`${view.nodes.filter(node => node.state === 'completed').length} of ${view.nodes.length + (verification ? 0 : 1)} steps complete`}
      tasks={groupedTasks([
        ...ordered.map(node => ({
          kind: node.kind,
          task: {
            id: node.key,
            title: titles.get(node.key)!,
            typeIcon: node.kind === 'verify' ? undefined : resourceTypes[node.kind],
            brief:
              node.kind === 'verify'
                ? 'Read back every installed resource before this installation can finish.'
                : `Package reference: ${node.key}`,
            mark: nodeMarks[node.state],
            label:
              node.state === 'waiting-review'
                ? node.attempt > 0
                  ? `Needs fresh review (attempt ${node.attempt + 1})`
                  : 'Needs review in chat'
                : node.kind === 'verify' && node.state === 'completed'
                  ? 'Verified'
                  : nodeLabels[node.state],
            reason: node.error ?? undefined,
            criteria: node.kind === 'verify' ? verificationCriteria : undefined,
            dependencies: node.dependsOn.map(key => {
              const dependency = view.nodes.find(candidate => candidate.key === key);
              return {
                id: key,
                title: titles.get(key) ?? key,
                label: dependency ? nodeLabels[dependency.state] : 'Unavailable',
              };
            }),
          },
        })),
        ...(!verification
          ? [
              {
                kind: 'verify' as const,
                task: {
                  id: '$verify',
                  title: 'Final verification',
                  mark: 'blocked' as const,
                  label: 'Server verification is unavailable',
                  criteria: verificationCriteria,
                },
              },
            ]
          : []),
      ])}
    />
  );
}

export function installationVerified(view: SystemPackageInstallation): boolean {
  return (
    view.status === 'completed' &&
    view.nodes.some(node => node.key === '$verify' && node.kind === 'verify' && node.state === 'completed') &&
    view.nodes.every(node => node.state === 'completed')
  );
}
