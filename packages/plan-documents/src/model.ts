import { planDocumentSectionsSchema, type PlanDocumentSections, type PlanDocumentSectionsInput } from './sections.ts';

export type PlanDocumentAssigneeInput =
  | { kind: 'coordinator' }
  | { kind: 'agent'; name?: string | null | undefined }
  | { kind: 'specialist'; name?: string | null | undefined };

export type PlanDocumentTaskInput = {
  key: string;
  parent?: string | null | undefined;
  kind?: 'group' | 'work' | undefined;
  order?: 'parallel' | 'serial' | undefined;
  title: string;
  brief?: string | undefined;
  criteria?: readonly string[] | undefined;
  dependsOn?: readonly string[] | undefined;
  assignee?: PlanDocumentAssigneeInput | null | undefined;
};

export type PlanPrerequisiteStatus = 'verified' | 'blocked' | 'unknown';

/** A plan snapshot. Objects may carry more fields, such as a `PlanView`'s; the model copies only those named here. */
export type PlanDocumentInput = {
  title: string;
  brief?: string | undefined;
  starterName: string;
  contentRevision: number;
  generatedAt: string | Date;
  requirements?: readonly { key: string; description: string }[] | undefined;
  prerequisites?:
    | readonly {
        key: string;
        title: string;
        status: PlanPrerequisiteStatus;
        reason?: string | null | undefined;
        resolution?: string | null | undefined;
      }[]
    | undefined;
  tasks: readonly PlanDocumentTaskInput[];
  budget: { toolCalls: number; activeMinutes: number; credits?: number | null | undefined };
  sections: PlanDocumentSectionsInput;
  approval?: { approverName: string; approvedAt: string | Date; revision: number } | null | undefined;
  changes?: readonly PlanDocumentChange[] | undefined;
};

export type PlanDocumentTask = {
  key: string;
  parent: string | null;
  kind: 'group' | 'work';
  order: 'parallel' | 'serial';
  title: string;
  brief: string;
  criteria: string[];
  dependsOn: string[];
  owner: string | null;
};

export type PlanDocumentModel = {
  title: string;
  brief: string;
  starterName: string;
  contentRevision: number;
  generatedAt: string;
  approval: { approverName: string; approvedAt: string; revision: number } | null;
  requirements: { key: string; description: string }[];
  prerequisites: {
    key: string;
    title: string;
    status: PlanPrerequisiteStatus;
    reason: string | null;
    resolution: string | null;
  }[];
  tasks: PlanDocumentTask[];
  budget: { toolCalls: number; activeMinutes: number; credits: number | null };
  sections: PlanDocumentSections;
  changes: PlanDocumentChange[];
};

export type PlanChangeOrigin = 'runtime' | 'starter';
export type PlanDocumentChange = { origin: PlanChangeOrigin; text: string };

const text = (value: string | null | undefined) => (typeof value === 'string' ? value.trim() : '');
const optional = (value: string | null | undefined) => text(value) || null;
const isoDate = (value: string | Date) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid plan document date');
  return date.toISOString();
};

function owner(assignee: PlanDocumentAssigneeInput | null | undefined): string | null {
  if (!assignee) return null;
  if (assignee.kind === 'coordinator') return 'Plan coordinator';
  return text(assignee.name) || (assignee.kind === 'agent' ? 'An agent' : 'A specialist');
}

/**
 * Builds the document model from an allowlist. Task results, evidence, specialist instructions and links to the app
 * never reach it, whatever else the snapshot carries.
 */
export function planDocumentModel(input: PlanDocumentInput): PlanDocumentModel {
  const keys = new Set(input.tasks.map(task => task.key));
  return {
    title: text(input.title),
    brief: text(input.brief),
    starterName: text(input.starterName),
    contentRevision: input.contentRevision,
    generatedAt: isoDate(input.generatedAt),
    approval: input.approval
      ? {
          approverName: text(input.approval.approverName),
          approvedAt: isoDate(input.approval.approvedAt),
          revision: input.approval.revision,
        }
      : null,
    requirements: (input.requirements ?? []).map(({ key, description }) => ({ key, description: text(description) })),
    prerequisites: (input.prerequisites ?? []).map(prerequisite => ({
      key: prerequisite.key,
      title: text(prerequisite.title),
      status: prerequisite.status,
      reason: optional(prerequisite.reason),
      resolution: optional(prerequisite.resolution),
    })),
    tasks: input.tasks.map(task => ({
      key: task.key,
      parent: task.parent && keys.has(task.parent) ? task.parent : null,
      kind: task.kind ?? 'work',
      order: task.order ?? 'parallel',
      title: text(task.title),
      brief: text(task.brief),
      criteria: (task.criteria ?? []).map(text).filter(Boolean),
      dependsOn: (task.dependsOn ?? []).filter(key => keys.has(key) && key !== task.key),
      owner: owner(task.assignee),
    })),
    budget: {
      toolCalls: input.budget.toolCalls,
      activeMinutes: input.budget.activeMinutes,
      credits: input.budget.credits ?? null,
    },
    sections: planDocumentSectionsSchema.parse(input.sections),
    changes: (input.changes ?? []).map(change => ({ origin: change.origin, text: text(change.text) })),
  };
}

type PlanContent = Pick<
  PlanDocumentModel,
  'title' | 'brief' | 'requirements' | 'prerequisites' | 'tasks' | 'budget' | 'sections'
>;

const quote = (value: string) => `“${value}”`;
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);
const statusLabel: Record<PlanPrerequisiteStatus, string> = {
  verified: 'checked',
  blocked: 'blocked',
  unknown: 'not checked',
};

function keyed<T extends { key: string }>(previous: readonly T[], current: readonly T[]) {
  const before = new Map(previous.map(item => [item.key, item]));
  const after = new Map(current.map(item => [item.key, item]));
  return {
    added: current.filter(item => !before.has(item.key)),
    removed: previous.filter(item => !after.has(item.key)),
    kept: current.flatMap(item => {
      const old = before.get(item.key);
      return old ? [[old, item] as const] : [];
    }),
  };
}

function taskChanges(previous: PlanContent['tasks'], current: PlanContent['tasks']): string[] {
  const titles = new Map([...previous, ...current].map(task => [task.key, task.title]));
  const name = (key: string) => quote(titles.get(key) ?? key);
  const noun = (task: PlanDocumentTask) => (task.kind === 'group' ? 'group' : 'task');
  const { added, removed, kept } = keyed(previous, current);
  const lines = [
    ...added.map(task => `Added ${noun(task)} ${quote(task.title)}`),
    ...removed.map(task => `Removed ${noun(task)} ${quote(task.title)}`),
  ];
  for (const [old, task] of kept) {
    const label = quote(task.title);
    if (old.title !== task.title) lines.push(`Renamed ${noun(task)} ${quote(old.title)} to ${label}`);
    if (old.brief !== task.brief) lines.push(`Changed the brief of ${label}`);
    if (!same(old.criteria, task.criteria)) lines.push(`Changed what done means for ${label}`);
    if (old.parent !== task.parent)
      lines.push(task.parent ? `Moved ${label} into ${name(task.parent)}` : `Moved ${label} out of its group`);
    if (old.owner !== task.owner) lines.push(task.owner ? `Assigned ${label} to ${task.owner}` : `Unassigned ${label}`);
    const waits = task.dependsOn.filter(key => !old.dependsOn.includes(key));
    const freed = old.dependsOn.filter(key => !task.dependsOn.includes(key));
    if (waits.length) lines.push(`${label} now waits for ${waits.map(name).join(', ')}`);
    if (freed.length) lines.push(`${label} no longer waits for ${freed.map(name).join(', ')}`);
  }
  return lines;
}

function sectionChanges(previous: PlanDocumentSections, current: PlanDocumentSections): string[] {
  const lines: string[] = [];
  if (previous.summary !== current.summary) lines.push('Updated the summary');
  if ((previous.approach ?? '') !== (current.approach ?? ''))
    lines.push(
      !current.approach ? 'Removed the approach' : previous.approach ? 'Updated the approach' : 'Added the approach',
    );
  const risks = keyed(
    previous.risks.map(item => ({ ...item, key: item.risk })),
    current.risks.map(item => ({ ...item, key: item.risk })),
  );
  lines.push(...risks.added.map(item => `Added risk ${quote(item.risk)}`));
  lines.push(...risks.removed.map(item => `Removed risk ${quote(item.risk)}`));
  for (const [old, item] of risks.kept)
    if (old.mitigation !== item.mitigation) lines.push(`Changed the mitigation for risk ${quote(item.risk)}`);
  const diagrams = keyed(previous.diagrams, current.diagrams);
  lines.push(...diagrams.added.map(diagram => `Added diagram ${quote(diagram.title)}`));
  lines.push(...diagrams.removed.map(diagram => `Removed diagram ${quote(diagram.title)}`));
  for (const [old, diagram] of diagrams.kept)
    if (old.title !== diagram.title || old.mermaid !== diagram.mermaid || old.caption !== diagram.caption)
      lines.push(`Changed diagram ${quote(diagram.title)}`);
  return lines;
}

/** Short descriptions of what changed between two snapshots of a plan, each marked with who made the change. */
export function changeList(
  previous: PlanContent,
  current: PlanContent,
  origin: PlanChangeOrigin,
): PlanDocumentChange[] {
  const lines: string[] = [];
  if (previous.title !== current.title) lines.push(`Renamed the plan to ${quote(current.title)}`);
  if (previous.brief !== current.brief) lines.push('Changed the plan brief');
  lines.push(...taskChanges(previous.tasks, current.tasks));

  const requirements = keyed(previous.requirements, current.requirements);
  lines.push(...requirements.added.map(item => `Added requirement ${quote(item.description)}`));
  lines.push(...requirements.removed.map(item => `Removed requirement ${quote(item.description)}`));
  for (const [old, item] of requirements.kept)
    if (old.description !== item.description) lines.push(`Changed requirement ${quote(item.description)}`);

  const prerequisites = keyed(previous.prerequisites, current.prerequisites);
  lines.push(...prerequisites.added.map(item => `Added prerequisite ${quote(item.title)}`));
  lines.push(...prerequisites.removed.map(item => `Removed prerequisite ${quote(item.title)}`));
  for (const [old, item] of prerequisites.kept) {
    if (old.title !== item.title) lines.push(`Renamed prerequisite ${quote(old.title)} to ${quote(item.title)}`);
    if (old.status !== item.status) lines.push(`Prerequisite ${quote(item.title)} is now ${statusLabel[item.status]}`);
    else if (old.reason !== item.reason || old.resolution !== item.resolution)
      lines.push(`Updated the notes on prerequisite ${quote(item.title)}`);
  }

  const budget = [
    ['tool calls', previous.budget.toolCalls, current.budget.toolCalls],
    ['active minutes', previous.budget.activeMinutes, current.budget.activeMinutes],
    ['credits', previous.budget.credits, current.budget.credits],
  ] as const;
  for (const [label, before, after] of budget)
    if (before !== after)
      lines.push(
        after === null
          ? `Removed the ${label} budget`
          : before === null
            ? `Set the ${label} budget to ${after}`
            : `Changed the ${label} budget from ${before} to ${after}`,
      );

  lines.push(...sectionChanges(previous.sections, current.sections));
  return lines.map(line => ({ origin, text: line }));
}
