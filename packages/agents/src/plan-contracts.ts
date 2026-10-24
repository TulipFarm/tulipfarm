import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { maximumTaskLimits } from './contracts.ts';

/** Structural ceilings shared by tools, storage and the canvas. Inputs over a ceiling are refused, never truncated. */
export const planLimits = {
  tasks: 100,
  depth: 4,
  dependencies: 16,
  mutations: 40,
  specialists: 12,
  workers: 3,
  title: 120,
  brief: 4000,
  criteria: 8,
  criterion: 400,
  reason: 600,
  specialistName: 80,
  specialistRole: 400,
  specialistInstructions: 8000,
  specialistTools: 12,
} as const;

export const planTaskStates = [
  'pending',
  'ready',
  'running',
  'verifying',
  'waiting-input',
  'waiting-approval',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export const planTaskStateSchema = z.enum(planTaskStates);
export type PlanTaskState = z.infer<typeof planTaskStateSchema>;
export const planLifecycleSchema = z.enum(['draft', 'active', 'paused', 'stopped', 'completed', 'failed']);
export type PlanLifecycle = z.infer<typeof planLifecycleSchema>;

/** Model-chosen identifiers keep graphs readable in tool calls; the service binds each key to a stored UUID. */
export const planKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'Use 1-48 lowercase letters, digits or hyphens.');
const title = z.string().trim().min(1).max(planLimits.title);
const brief = z.string().trim().max(planLimits.brief);
const criteria = z.array(z.string().trim().min(1).max(planLimits.criterion)).max(planLimits.criteria);
const reason = z.string().trim().min(1).max(planLimits.reason);
const uniqueKeys = z
  .array(planKeySchema)
  .min(1)
  .max(planLimits.tasks)
  .refine(keys => new Set(keys).size === keys.length, 'Keys must be unique.');
export const planEvidenceSchema = z.strictObject({ callId: uuidSchema, summary: reason });
const evidence = z.array(planEvidenceSchema).max(16);
const withinJsonBytes = (value: unknown, maximum: number) =>
  new TextEncoder().encode(JSON.stringify(value, null, 1)).byteLength <= maximum;
export const planSpecificationSchema = z
  .strictObject({
    requirements: z
      .array(z.strictObject({ key: planKeySchema, description: reason, tasks: uniqueKeys }))
      .min(1)
      .max(planLimits.tasks),
    prerequisites: z
      .array(
        z.strictObject({
          key: planKeySchema,
          title,
          tasks: uniqueKeys,
          status: z.enum(['verified', 'blocked', 'unknown']),
          evidence,
          reason: reason.optional(),
        }),
      )
      .max(planLimits.tasks),
    verificationTask: planKeySchema,
  })
  .refine(value => withinJsonBytes(value, 262144), 'Planning evidence must fit within 256 KiB of formatted JSON.');
export type PlanSpecification = z.infer<typeof planSpecificationSchema>;
const reportOutcome = z.enum(['passed', 'blocked', 'failed', 'unknown']);
export const planWorkerReportSchema = z.strictObject({
  outcome: reportOutcome,
  summary: brief.min(1),
  checks: z
    .array(
      z.strictObject({
        criterion: z
          .number()
          .int()
          .min(0)
          .max(planLimits.criteria - 1),
        outcome: reportOutcome,
        summary: reason,
      }),
    )
    .max(planLimits.criteria),
});
export type PlanWorkerReport = z.infer<typeof planWorkerReportSchema>;
export function parsePlanWorkerReport(text: string, criterionCount: number): PlanWorkerReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('model-invalid-decision');
  }
  const parsed = planWorkerReportSchema.safeParse(value);
  if (!parsed.success) throw new Error('model-invalid-decision');
  const report = parsed.data;
  if (
    new Set(report.checks.map(check => check.criterion)).size !== report.checks.length ||
    report.checks.some(check => check.criterion >= criterionCount) ||
    (report.outcome === 'passed' &&
      (criterionCount === 0 ||
        report.checks.length !== criterionCount ||
        report.checks.some(check => check.outcome !== 'passed')))
  ) {
    throw new Error('model-invalid-decision');
  }
  return report;
}
export const planReportSchema = z
  .strictObject({
    outcome: reportOutcome,
    summary: brief.min(1),
    checks: z
      .array(
        z.strictObject({
          criterion: z
            .number()
            .int()
            .min(0)
            .max(planLimits.criteria - 1),
          outcome: reportOutcome,
          evidence,
        }),
      )
      .max(planLimits.criteria),
    requirements: z
      .array(z.strictObject({ key: planKeySchema, outcome: reportOutcome, evidence }))
      .max(planLimits.tasks)
      .default([]),
  })
  .refine(value => withinJsonBytes(value, 131072), 'A report must fit within 128 KiB of formatted JSON.');
export type PlanReport = z.infer<typeof planReportSchema>;
export const planClaimSchema = z.strictObject({
  planId: uuidSchema,
  task: planKeySchema,
  expectedVersion: z.number().int().nonnegative(),
});
export const planSubmitReportSchema = z.strictObject({
  planId: uuidSchema,
  attemptId: uuidSchema,
  report: planReportSchema,
});
export const coordinatorOriginSchema = z.strictObject({
  conversationId: uuidSchema,
  turnId: uuidSchema,
  generation: z.number().int().nonnegative(),
  epoch: z.number().int().positive(),
  callId: uuidSchema,
});
export type CoordinatorOrigin = z.infer<typeof coordinatorOriginSchema>;

/** Read-only chat tools a plan specialist may hold. Each runs with the starter's permissions and changes nothing. */
export const specialistToolSchema = z.enum([
  'schema.inspect',
  'schema.status',
  'rows.list',
  'rows.get',
  'rows.reverse',
  'skills.list',
  'skills.read',
  'web.fetch',
  'web.search',
  'knowledge.search',
  'knowledge.read',
  'knowledge.retrieve',
]);
export const specialistInputSchema = z.strictObject({
  key: planKeySchema,
  name: z.string().trim().min(1).max(planLimits.specialistName),
  role: z.string().trim().min(1).max(planLimits.specialistRole),
  instructions: z.string().trim().min(1).max(planLimits.specialistInstructions),
  /** The family this step runs on, and so the image model its work resolves to. Without it, the plan role's model. */
  modelFamilyId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,99}$/)
    .optional(),
  tools: z
    .array(specialistToolSchema)
    .min(1)
    .max(planLimits.specialistTools)
    .refine(tools => new Set(tools).size === tools.length, 'Tools must be unique.'),
});
export type SpecialistInput = z.infer<typeof specialistInputSchema>;

export const planAssigneeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('coordinator') }),
  z.strictObject({ kind: z.literal('agent'), agentId: uuidSchema }),
  z.strictObject({ kind: z.literal('specialist'), specialist: planKeySchema }),
]);
export type PlanAssignee = z.infer<typeof planAssigneeSchema>;

export const planTaskInputSchema = z.strictObject({
  key: planKeySchema,
  parent: planKeySchema.nullable().default(null),
  kind: z.enum(['group', 'work']).default('work'),
  order: z.enum(['parallel', 'serial']).default('parallel'),
  title,
  brief: brief.default(''),
  criteria: criteria.default([]),
  dependsOn: z.array(planKeySchema).max(planLimits.dependencies).default([]),
  assignee: planAssigneeSchema.nullable().default(null),
});
export type PlanTaskInput = z.infer<typeof planTaskInputSchema>;

export const planMutationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), task: planTaskInputSchema }),
  z.strictObject({
    op: z.literal('revise'),
    key: planKeySchema,
    title: title.optional(),
    brief: brief.optional(),
    criteria: criteria.optional(),
  }),
  z.strictObject({ op: z.literal('depend'), key: planKeySchema, on: planKeySchema }),
  z.strictObject({ op: z.literal('undepend'), key: planKeySchema, on: planKeySchema }),
  z.strictObject({ op: z.literal('assign'), key: planKeySchema, assignee: planAssigneeSchema }),
  z.strictObject({ op: z.literal('cancel'), key: planKeySchema, reason }),
  z.strictObject({ op: z.literal('retry'), key: planKeySchema }),
]);
export type PlanMutation = z.infer<typeof planMutationSchema>;

export const planBudgetSchema = z.strictObject({
  toolCalls: z.number().int().min(1).max(maximumTaskLimits.toolCalls).default(300),
  activeMilliseconds: z.number().int().min(1000).max(maximumTaskLimits.activeMilliseconds).default(1800000),
  credits: z.number().int().min(1).max(maximumTaskLimits.credits).default(300),
});
export type PlanBudget = z.infer<typeof planBudgetSchema>;

export const createPlanSchema = z.strictObject({
  title,
  brief: brief.default(''),
  execution: z.enum(['plan-only', 'execute']).default('execute'),
  planning: planSpecificationSchema.optional(),
  tasks: z.array(planTaskInputSchema).min(1).max(planLimits.tasks),
  specialists: z.array(specialistInputSchema).max(planLimits.specialists).default([]),
  budget: planBudgetSchema.default({ toolCalls: 300, activeMilliseconds: 1800000, credits: 300 }),
});
export const updatePlanSchema = z
  .strictObject({
    expectedVersion: z.number().int().nonnegative(),
    planning: planSpecificationSchema.optional(),
    specialists: z.array(specialistInputSchema).max(planLimits.specialists).default([]),
    mutations: z.array(planMutationSchema).max(planLimits.mutations).default([]),
  })
  .refine(
    input => input.mutations.length > 0 || input.planning !== undefined,
    'Provide mutations or updated planning checks.',
  );
/**
 * A person's control of their plan. Pause stops new work and cancels running specialists, which start again on resume.
 * Resume may raise the budget; only a person can do that. Stop cancels all unfinished work and cannot be undone.
 */
export const planControlSchema = z.discriminatedUnion('action', [
  z.strictObject({
    requestId: uuidSchema,
    action: z.literal('start'),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    requestId: uuidSchema,
    action: z.literal('pause'),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    requestId: uuidSchema,
    action: z.literal('resume'),
    expectedVersion: z.number().int().nonnegative(),
    budget: planBudgetSchema.optional(),
  }),
  z.strictObject({ requestId: uuidSchema, action: z.literal('stop'), expectedVersion: z.number().int().nonnegative() }),
]);
export type PlanControl = z.infer<typeof planControlSchema>;
/** Why a plan is paused: its starter paused it, it used its budget, or its starter lost access to the chat. */
export const planPauseSchema = z.enum(['starter', 'budget', 'starter-access', 'progress']);

export type PlanGraphErrorCode =
  | 'duplicate-key'
  | 'missing-task'
  | 'missing-specialist'
  | 'self-dependency'
  | 'hierarchy-cycle'
  | 'hierarchy-dependency'
  | 'dependency-cycle'
  | 'too-deep'
  | 'too-many-tasks'
  | 'too-many-dependencies'
  | 'too-many-specialists'
  | 'group-assignee'
  | 'settled-task'
  | 'settled-prerequisite'
  | 'outside-scope'
  | 'invalid-transition'
  | 'planning-required'
  | 'planning-coverage'
  | 'planning-verification'
  | 'planning-prerequisite'
  | 'planning-evidence'
  | 'planning-budget'
  | 'plan-only';
const instructions: Record<PlanGraphErrorCode, string> = {
  'duplicate-key': 'Choose a key no other task or specialist in this plan uses.',
  'missing-task': 'Read the plan and refer only to existing task keys.',
  'missing-specialist': 'Create the specialist in the same update before assigning it.',
  'self-dependency': 'Remove the dependency of the task on itself.',
  'hierarchy-cycle': 'Choose a parent that is not the task or one of its subtasks.',
  'hierarchy-dependency':
    'A task already relates to its parent and subtasks through the outline. Remove this dependency.',
  'dependency-cycle': 'Remove one dependency so that work can start in some order.',
  'too-deep': `Keep the outline at most ${planLimits.depth} levels deep.`,
  'too-many-tasks': `Keep the plan at most ${planLimits.tasks} tasks. Combine small steps.`,
  'too-many-dependencies': `Give a task at most ${planLimits.dependencies} direct dependencies. Depend on a group instead.`,
  'too-many-specialists': `Use at most ${planLimits.specialists} specialists in one plan.`,
  'group-assignee': 'Assign work tasks, not groups.',
  'settled-task': 'This task has started or finished. Create a follow-up task instead.',
  'settled-prerequisite':
    'This change would add a prerequisite to work that has started or finished. Create a follow-up task instead.',
  'outside-scope': 'Change only tasks under your assigned task. Ask the coordinator for other changes.',
  'invalid-transition': 'Read the plan again; this task is not in a state that allows the change.',
  'planning-required':
    'Read the Planning skill and provide the original requirements, prerequisite checks, and final verification task.',
  'planning-coverage': 'Keep each original requirement and map every deliverable to the requirement it satisfies.',
  'planning-verification':
    'Assign final verification to the main agent after every deliverable. Verify all required work before completing it.',
  'planning-prerequisite':
    'Name real affected tasks and provide evidence for a verified prerequisite or a reason it remains unresolved.',
  'planning-evidence':
    'Report every criterion and original requirement with real authorized receipts. Missing or unresolved evidence is not success.',
  'planning-budget': 'The plan has no available allowance. Pause work; only the starter can raise its budget.',
  'plan-only':
    'Plan mode permits research and a plan-only draft. It cannot start work or change a plan that is executing.',
};
export class PlanGraphError extends Error {
  readonly code: PlanGraphErrorCode;
  readonly key: string | undefined;
  readonly instruction: string;
  constructor(code: PlanGraphErrorCode, key?: string) {
    super(key ? `${code}: ${key}` : code);
    this.code = code;
    this.key = key;
    this.instruction = instructions[code];
  }
}

/** The graph facts the scheduler needs. Group `state` is ignored; groups summarize their descendants. */
export type PlanNode = {
  key: string;
  parent: string | null;
  position: number;
  kind: 'group' | 'work';
  order: 'parallel' | 'serial';
  dependsOn: readonly string[];
  state: PlanTaskState;
  assignee: PlanAssignee | null;
  title?: string;
  brief?: string;
  criteria?: readonly string[];
  reason?: string | null;
  prerequisiteBlock?: string | null;
};

const settledStates = new Set<PlanTaskState>(['completed', 'cancelled']);
const editableStates = new Set<PlanTaskState>(['pending', 'ready', 'blocked']);
const failingStates = new Set<PlanTaskState>(['failed', 'cancelled', 'blocked']);
const transitions: Record<PlanTaskState, readonly PlanTaskState[]> = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['pending', 'running', 'blocked', 'cancelled'],
  running: ['pending', 'verifying', 'waiting-input', 'waiting-approval', 'completed', 'failed', 'cancelled'],
  verifying: ['completed', 'blocked', 'failed', 'cancelled'],
  'waiting-input': ['running', 'pending', 'failed', 'cancelled'],
  'waiting-approval': ['running', 'pending', 'failed', 'cancelled'],
  blocked: ['pending', 'ready', 'cancelled'],
  completed: [],
  failed: ['pending', 'cancelled'],
  cancelled: ['pending'],
};
export function canTransition(from: PlanTaskState, to: PlanTaskState) {
  return transitions[from].includes(to);
}
export function assertTransition(key: string, from: PlanTaskState, to: PlanTaskState) {
  if (!canTransition(from, to)) throw new PlanGraphError('invalid-transition', key);
}

type Index = { nodes: Map<string, PlanNode>; children: Map<string, PlanNode[]> };
function index(nodes: readonly PlanNode[]): Index {
  const map = new Map<string, PlanNode>();
  for (const node of nodes) {
    if (map.has(node.key)) throw new PlanGraphError('duplicate-key', node.key);
    map.set(node.key, node);
  }
  const children = new Map<string, PlanNode[]>();
  for (const node of nodes) {
    if (node.parent === null) continue;
    if (!map.has(node.parent)) throw new PlanGraphError('missing-task', node.parent);
    children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
  return { nodes: map, children };
}
function ancestors(index: Index, key: string) {
  const chain: string[] = [];
  const seen = new Set([key]);
  for (
    let parent = index.nodes.get(key)?.parent ?? null;
    parent !== null;
    parent = index.nodes.get(parent)?.parent ?? null
  ) {
    if (seen.has(parent)) throw new PlanGraphError('hierarchy-cycle', key);
    seen.add(parent);
    chain.push(parent);
  }
  return chain;
}
/** A work task stands for itself because it already waits for its subtasks; a group stands for all of its work. */
function expand(index: Index, key: string): string[] {
  const node = index.nodes.get(key);
  if (!node) throw new PlanGraphError('missing-task', key);
  if (node.kind === 'work') return [key];
  return (index.children.get(key) ?? []).flatMap(child => expand(index, child.key));
}
function workUnder(index: Index, key: string): string[] {
  const node = index.nodes.get(key)!;
  const below = (index.children.get(key) ?? []).flatMap(child => workUnder(index, child.key));
  return node.kind === 'work' ? [key, ...below] : below;
}

/**
 * Compiles the outline into execution prerequisites for each work task: its own and inherited dependencies, serial
 * barriers between earlier and later siblings, and the subtasks a work task waits for. Throws on any invalid graph.
 */
export function compilePlan(nodes: readonly PlanNode[]) {
  if (nodes.length > planLimits.tasks) throw new PlanGraphError('too-many-tasks');
  const idx = index(nodes);
  const lineage = new Map<string, string[]>();
  for (const node of nodes) {
    const chain = ancestors(idx, node.key);
    if (chain.length + 1 > planLimits.depth) throw new PlanGraphError('too-deep', node.key);
    if (node.kind === 'group' && node.assignee) throw new PlanGraphError('group-assignee', node.key);
    if (node.dependsOn.length > planLimits.dependencies) throw new PlanGraphError('too-many-dependencies', node.key);
    lineage.set(node.key, chain);
  }
  for (const node of nodes) {
    for (const target of node.dependsOn) {
      if (target === node.key) throw new PlanGraphError('self-dependency', node.key);
      if (!idx.nodes.has(target)) throw new PlanGraphError('missing-task', target);
      if (lineage.get(node.key)!.includes(target) || lineage.get(target)!.includes(node.key))
        throw new PlanGraphError('hierarchy-dependency', node.key);
    }
  }
  const prerequisites = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.kind !== 'work') continue;
    const needs = new Set<string>();
    for (const member of [node.key, ...lineage.get(node.key)!]) {
      const current = idx.nodes.get(member)!;
      for (const target of current.dependsOn) for (const work of expand(idx, target)) needs.add(work);
      const parent = current.parent === null ? null : idx.nodes.get(current.parent)!;
      if (parent?.order === 'serial') {
        const siblings = idx.children.get(parent.key)!;
        const previous = siblings[siblings.findIndex(sibling => sibling.key === member) - 1];
        if (previous) for (const work of expand(idx, previous.key)) needs.add(work);
      }
    }
    for (const child of idx.children.get(node.key) ?? []) for (const work of expand(idx, child.key)) needs.add(work);
    needs.delete(node.key);
    prerequisites.set(node.key, needs);
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (key: string) => {
    if (done.has(key)) return;
    if (visiting.has(key)) throw new PlanGraphError('dependency-cycle', key);
    visiting.add(key);
    for (const need of prerequisites.get(key)!) visit(need);
    visiting.delete(key);
    done.add(key);
  };
  for (const key of prerequisites.keys()) visit(key);
  return { prerequisites, children: idx.children, lineage };
}

export type PlanTransition = { key: string; from: PlanTaskState; to: PlanTaskState };
/** Derives readiness: only completed prerequisites release work; a failed, cancelled or blocked prerequisite blocks it. */
export function advancePlan(nodes: readonly PlanNode[]): PlanTransition[] {
  const { prerequisites } = compilePlan(nodes);
  const state = new Map(nodes.map(node => [node.key, node.state]));
  const changes = new Map<string, PlanTransition>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, needs] of prerequisites) {
      const from = state.get(key)!;
      if (from !== 'pending' && from !== 'ready' && from !== 'blocked') continue;
      const states = [...needs].map(need => state.get(need)!);
      const to: PlanTaskState =
        nodes.find(node => node.key === key)?.prerequisiteBlock || states.some(item => failingStates.has(item))
          ? 'blocked'
          : states.every(item => item === 'completed')
            ? 'ready'
            : 'pending';
      if (to === from) continue;
      state.set(key, to);
      changes.set(key, { key, from: changes.get(key)?.from ?? from, to });
      changed = true;
    }
  }
  return [...changes.values()].filter(change => change.from !== change.to);
}

export type PlanCounts = Record<PlanTaskState, number> & { total: number };
export type PlanOutcome = 'empty' | 'active' | 'waiting' | 'completed' | 'failed';
function count(states: readonly PlanTaskState[]): PlanCounts {
  const counts = Object.fromEntries(planTaskStates.map(state => [state, 0])) as PlanCounts;
  for (const state of states) counts[state] += 1;
  counts.total = states.length - counts.cancelled;
  return counts;
}
function outcomeOf(counts: PlanCounts): PlanOutcome {
  if (counts.total === 0) return 'empty';
  if (counts.running + counts.ready + counts.pending > 0) return 'active';
  if (counts.verifying + counts['waiting-input'] + counts['waiting-approval'] > 0) return 'waiting';
  return counts.failed + counts.blocked > 0 ? 'failed' : 'completed';
}
/** Counts work tasks once; each group reports the states of the work beneath it, never its own copy. */
export function summarizePlan(nodes: readonly PlanNode[], specification?: PlanSpecification) {
  const idx = index(nodes);
  const all = count(nodes.filter(node => node.kind === 'work').map(node => node.state));
  const groups = new Map<string, { counts: PlanCounts; outcome: PlanOutcome }>();
  for (const node of nodes) {
    if (node.kind !== 'group') continue;
    const counts = count(workUnder(idx, node.key).map(key => idx.nodes.get(key)!.state));
    groups.set(node.key, { counts, outcome: outcomeOf(counts) });
  }
  const counted = outcomeOf(all);
  const outcome =
    (counted === 'completed' || counted === 'empty') &&
    specification &&
    nodes.some(node => node.kind === 'work' && node.state !== 'completed')
      ? 'failed'
      : counted;
  return {
    counts: all,
    outcome:
      outcome === 'failed' && all.failed === 0 && nodes.some(node => node.state === 'blocked' && node.prerequisiteBlock)
        ? ('waiting' as const)
        : outcome,
    groups,
  };
}

export type PlanActor = { kind: 'coordinator' } | { kind: 'worker'; task: string };
export type MutationContext = { actor: PlanActor; specialists: ReadonlySet<string> };

/**
 * Applies a batch atomically and returns the new outline. Started or finished work never gains prerequisites, so a
 * worker that adds subtasks under its own running task yields it back to pending until those subtasks finish.
 */
export function applyPlanMutations(
  nodes: readonly PlanNode[],
  mutations: readonly PlanMutation[],
  context: MutationContext,
) {
  const before = compilePlan(nodes).prerequisites;
  const next = new Map(nodes.map(node => [node.key, { ...node, dependsOn: [...node.dependsOn] }]));
  const added: string[] = [];
  const owner = context.actor.kind === 'worker' ? context.actor.task : null;
  if (owner !== null && !next.has(owner)) throw new PlanGraphError('missing-task', owner);
  const within = (key: string | null, inclusive: boolean) => {
    if (owner === null) return true;
    if (key === null) return false;
    if (key === owner) return inclusive;
    for (
      let parent = next.get(key)?.parent ?? null, depth = 0;
      parent !== null && depth <= planLimits.tasks;
      parent = next.get(parent)?.parent ?? null, depth += 1
    )
      if (parent === owner) return true;
    return false;
  };
  const existing = (key: string) => {
    const node = next.get(key);
    if (!node) throw new PlanGraphError('missing-task', key);
    if (!within(key, false)) throw new PlanGraphError('outside-scope', key);
    return node;
  };
  const checkAssignee = (assignee: PlanAssignee | null) => {
    if (assignee?.kind === 'specialist' && !context.specialists.has(assignee.specialist))
      throw new PlanGraphError('missing-specialist', assignee.specialist);
  };
  for (const mutation of mutations) {
    if (mutation.op === 'add') {
      const task = mutation.task;
      if (next.has(task.key) || context.specialists.has(task.key)) throw new PlanGraphError('duplicate-key', task.key);
      if (!within(task.parent, true)) throw new PlanGraphError('outside-scope', task.key);
      for (const target of task.dependsOn)
        if (!within(target, false)) throw new PlanGraphError('outside-scope', target);
      checkAssignee(task.assignee);
      const position =
        Math.max(-1, ...[...next.values()].filter(node => node.parent === task.parent).map(node => node.position)) + 1;
      next.set(task.key, {
        key: task.key,
        parent: task.parent,
        position,
        kind: task.kind,
        order: task.order,
        dependsOn: [...task.dependsOn],
        state: 'pending',
        assignee: task.assignee,
        title: task.title,
        brief: task.brief,
        criteria: task.criteria,
        reason: null,
      });
      added.push(task.key);
      continue;
    }
    const node = existing(mutation.key);
    const work = node.kind === 'work';
    switch (mutation.op) {
      case 'revise':
        if (work && !editableStates.has(node.state)) throw new PlanGraphError('settled-task', node.key);
        if (mutation.title !== undefined) node.title = mutation.title;
        if (mutation.brief !== undefined) node.brief = mutation.brief;
        if (mutation.criteria !== undefined) node.criteria = mutation.criteria;
        break;
      case 'depend':
        if (!within(mutation.on, false)) throw new PlanGraphError('outside-scope', mutation.on);
        if (!next.has(mutation.on)) throw new PlanGraphError('missing-task', mutation.on);
        if (!node.dependsOn.includes(mutation.on)) node.dependsOn.push(mutation.on);
        break;
      case 'undepend':
        node.dependsOn = node.dependsOn.filter(target => target !== mutation.on);
        break;
      case 'assign':
        if (!work) throw new PlanGraphError('group-assignee', node.key);
        if (!editableStates.has(node.state) && node.state !== 'failed' && node.state !== 'cancelled')
          throw new PlanGraphError('settled-task', node.key);
        checkAssignee(mutation.assignee);
        node.assignee = mutation.assignee;
        break;
      case 'cancel':
        for (const key of [node.key, ...[...next.keys()].filter(key => isBelow(next, key, node.key))]) {
          const target = next.get(key)!;
          if (target.kind === 'work' && !settledStates.has(target.state)) {
            target.state = 'cancelled';
            target.reason = mutation.reason;
          }
        }
        break;
      case 'retry':
        if (!work || (node.state !== 'failed' && node.state !== 'cancelled'))
          throw new PlanGraphError('invalid-transition', node.key);
        node.state = 'pending';
        node.reason = null;
        break;
    }
  }
  let yielded = false;
  const result = [...next.values()];
  const after = compilePlan(result).prerequisites;
  for (const [key, needs] of after) {
    const node = next.get(key)!;
    if (editableStates.has(node.state)) continue;
    const previous = before.get(key) ?? new Set<string>();
    if ([...needs].every(need => previous.has(need))) continue;
    if (key === owner && node.state === 'running') {
      node.state = 'pending';
      yielded = true;
      continue;
    }
    throw new PlanGraphError('settled-prerequisite', key);
  }
  const transitions = advancePlan(result);
  for (const change of transitions) next.get(change.key)!.state = change.to;
  return { nodes: [...next.values()], added, yielded };
}
function isBelow(nodes: ReadonlyMap<string, PlanNode>, key: string, ancestor: string) {
  for (
    let parent = nodes.get(key)?.parent ?? null, depth = 0;
    parent !== null && depth <= planLimits.tasks;
    parent = nodes.get(parent)?.parent ?? null, depth += 1
  )
    if (parent === ancestor) return true;
  return false;
}

/** Validates a new plan, including that specialist and task keys are distinct and every assignment resolves. */
export function buildInitialPlan(input: z.infer<typeof createPlanSchema>) {
  const specialists = new Set<string>();
  for (const specialist of input.specialists) {
    if (specialists.has(specialist.key)) throw new PlanGraphError('duplicate-key', specialist.key);
    specialists.add(specialist.key);
  }
  const built = applyPlanMutations(
    [],
    input.tasks.map(task => ({ op: 'add' as const, task })),
    { actor: { kind: 'coordinator' }, specialists },
  );
  validatePlanning(built.nodes, input.planning);
  const nodes = applyPlanningPrerequisites(built.nodes, input.planning);
  for (const change of advancePlan(nodes)) nodes.find(node => node.key === change.key)!.state = change.to;
  return { ...built, nodes };
}

export function validatePlanning(
  nodes: readonly PlanNode[],
  specification: PlanSpecification | undefined,
  previous?: PlanSpecification,
) {
  if (!specification) {
    if (previous || nodes.some(node => node.assignee?.kind === 'coordinator'))
      throw new PlanGraphError('planning-required');
    return;
  }
  const requirements = new Map(specification.requirements.map(item => [item.key, item]));
  if (!requirements.size || requirements.size !== specification.requirements.length)
    throw new PlanGraphError('planning-coverage');
  for (const original of previous?.requirements ?? []) {
    if (requirements.get(original.key)?.description !== original.description)
      throw new PlanGraphError('planning-coverage', original.key);
  }
  for (const original of previous?.prerequisites ?? []) {
    const current = specification.prerequisites.find(check => check.key === original.key);
    if (!current || current.title !== original.title || original.tasks.some(key => !current.tasks.includes(key)))
      throw new PlanGraphError('planning-prerequisite', original.key);
  }
  const work = new Map(nodes.filter(node => node.kind === 'work').map(node => [node.key, node]));
  const verification = work.get(specification.verificationTask);
  if (!verification || verification.assignee?.kind !== 'coordinator') throw new PlanGraphError('planning-verification');
  if ([...work.values()].some(node => !node.assignee || !node.criteria?.length))
    throw new PlanGraphError('planning-coverage');
  const covered = new Set(specification.requirements.flatMap(item => item.tasks));
  if (
    [...covered].some(key => !work.has(key) || key === verification.key) ||
    [...work.keys()].some(key => key !== verification.key && !covered.has(key))
  )
    throw new PlanGraphError('planning-coverage');
  const prerequisites = compilePlan(nodes).prerequisites;
  const ancestors = new Set<string>();
  const collect = (key: string) => {
    for (const dependency of prerequisites.get(key) ?? []) {
      if (ancestors.has(dependency)) continue;
      ancestors.add(dependency);
      collect(dependency);
    }
  };
  collect(verification.key);
  if ([...work.keys()].some(key => key !== verification.key && !ancestors.has(key)))
    throw new PlanGraphError('planning-verification');
  const keys = new Set<string>();
  for (const check of specification.prerequisites) {
    if (
      keys.has(check.key) ||
      check.tasks.some(key => !work.has(key)) ||
      (check.status === 'verified' ? !check.evidence.length : !check.reason)
    )
      throw new PlanGraphError('planning-prerequisite', check.key);
    keys.add(check.key);
  }
}

export function applyPlanningPrerequisites(nodes: readonly PlanNode[], specification?: PlanSpecification): PlanNode[] {
  return nodes.map(node => {
    const unresolved =
      specification?.prerequisites.filter(check => check.status !== 'verified' && check.tasks.includes(node.key)) ?? [];
    const prerequisiteBlock = unresolved.length
      ? unresolved
          .map(check => `${check.title}: ${check.reason}`)
          .join('; ')
          .slice(0, planLimits.reason)
      : null;
    return {
      ...node,
      prerequisiteBlock,
      ...(editableStates.has(node.state)
        ? prerequisiteBlock
          ? { state: 'blocked' as const, reason: prerequisiteBlock }
          : node.prerequisiteBlock
            ? { reason: null }
            : {}
        : {}),
    };
  });
}

export function validatePlanReport(
  node: PlanNode,
  specification: PlanSpecification,
  report: PlanReport,
  nodes: readonly PlanNode[],
) {
  const checks = new Map(report.checks.map(check => [check.criterion, check]));
  if (
    checks.size !== report.checks.length ||
    report.checks.some(check => check.criterion >= (node.criteria?.length ?? 0))
  )
    throw new PlanGraphError('planning-evidence', node.key);
  if (report.outcome !== 'passed') return;
  if (
    !node.criteria?.length ||
    checks.size !== node.criteria.length ||
    report.checks.some(check => check.outcome !== 'passed' || !check.evidence.length)
  )
    throw new PlanGraphError('planning-evidence', node.key);
  if (node.key !== specification.verificationTask) return;
  if (
    nodes.some(task => task.kind === 'work' && task.key !== node.key && task.state !== 'completed') ||
    specification.prerequisites.some(check => check.status !== 'verified')
  )
    throw new PlanGraphError('planning-verification', node.key);
  const verified = new Map(report.requirements.map(requirement => [requirement.key, requirement]));
  if (
    verified.size !== report.requirements.length ||
    verified.size !== specification.requirements.length ||
    specification.requirements.some(requirement => {
      const check = verified.get(requirement.key);
      return !check || check.outcome !== 'passed' || !check.evidence.length;
    })
  )
    throw new PlanGraphError('planning-evidence', node.key);
}

const countsSchema = z.object({
  ...(Object.fromEntries(
    [...planTaskStates, 'total'].filter(key => key !== 'verifying').map(key => [key, z.number().int().nonnegative()]),
  ) as Record<Exclude<PlanTaskState, 'verifying'> | 'total', z.ZodNumber>),
  verifying: z.number().int().nonnegative().default(0),
});
const outcomeSchema = z.enum(['empty', 'active', 'waiting', 'completed', 'failed']);
/** The read-only projection shown in chat and the canvas. It never carries specialist instructions. */
export const planViewSchema = z.object({
  id: uuidSchema,
  chatId: uuidSchema,
  title: z.string(),
  brief: z.string(),
  lifecycle: planLifecycleSchema,
  version: z.number().int().nonnegative(),
  canControl: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  counts: countsSchema,
  outcome: outcomeSchema,
  pause: planPauseSchema.nullable(),
  budget: planBudgetSchema,
  planning: planSpecificationSchema.nullable().default(null),
  specialists: z.array(z.object({ key: planKeySchema, name: z.string(), role: z.string() })),
  tasks: z.array(
    z.object({
      id: uuidSchema,
      key: planKeySchema,
      parent: planKeySchema.nullable(),
      position: z.number().int().nonnegative(),
      kind: z.enum(['group', 'work']),
      order: z.enum(['parallel', 'serial']),
      title: z.string(),
      brief: z.string(),
      criteria: z.array(z.string()),
      dependsOn: z.array(planKeySchema),
      state: planTaskStateSchema,
      reason: z.string().nullable(),
      report: planReportSchema.nullable().default(null),
      assignee: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('coordinator') }),
          z.object({ kind: z.literal('agent'), agentId: uuidSchema, name: z.string().nullable() }),
          z.object({ kind: z.literal('specialist'), specialist: planKeySchema, name: z.string() }),
        ])
        .nullable(),
      summary: z.object({ counts: countsSchema, outcome: outcomeSchema }).nullable(),
      /** The saved task where the starter answers this task's question or approval. Null for everyone else. */
      waitingTaskId: uuidSchema.nullable(),
    }),
  ),
});
export type PlanView = z.infer<typeof planViewSchema>;
export const planListItemSchema = planViewSchema.pick({
  id: true,
  title: true,
  lifecycle: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  counts: true,
  outcome: true,
});
export const planReceiptSchema = z.object({
  id: uuidSchema,
  version: z.number().int().nonnegative(),
  added: z.array(planKeySchema),
  yielded: z.boolean(),
});
export class AgentPlanError extends Error {
  readonly code:
    | 'idempotency-conflict'
    | 'version-conflict'
    | 'plan-open'
    | 'plan-closed'
    | 'not-starter'
    | 'budget-lowered';
  constructor(code: AgentPlanError['code']) {
    super(code);
    this.code = code;
  }
}
