import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createWorkflows } from '@tulipfarm/workflows';
import { hasGrant } from '@tulipfarm/workflows/authorization';
import { definitionSchema, type Definition, type Trigger, type Work } from '@tulipfarm/workflows/contracts';
import type { GitHubSubscriptions } from '@tulipfarm/workflows/github-triggers';
import { nextOccurrence } from '@tulipfarm/workflows/schedule';
import { afterCommit } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied, uuidSchema, type HumanActor } from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { AgentError } from './saved-contracts.ts';
import {
  agentWorkflowTriggerId,
  storedAgentSetupDraftSchema,
  unattendedTrigger,
  type AgentSetup,
  type AgentTrigger,
} from './setup-contracts.ts';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';

export type AgentWorkflowOptions = {
  workflowWake?: ((work: Work) => Promise<void>) | undefined;
  githubSubscriptions?: GitHubSubscriptions | undefined;
};
type WorkflowTransaction = AgentTransaction & { commonVersion: number };

/** A UUID derived from its parts, so a retried setup or migration finds the workflow it already made. */
export function derivedId(...parts: string[]) {
  const hash = createHash('sha256').update(parts.join(':')).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** The per-trigger Workflow an earlier setup command created; such Workflows are combined into the linked one. */
export const agentSetupWorkflowId = (commandId: string, triggerId: string) => derivedId(commandId, triggerId);
/** Every activating setup of an agent updates this one Workflow. */
export const agentLinkedWorkflowId = (agentId: string) => derivedId('agent', uuidSchema.parse(agentId).toLowerCase());
/** The setup trigger UUID a linked Workflow trigger ID was made from, or null for IDs kept from older Workflows. */
export function agentSetupTriggerId(workflowTriggerId: string) {
  const match = /^t_([0-9a-f]{32})$/.exec(workflowTriggerId);
  if (!match) return null;
  const hex = match[1]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Thrown when the linked Workflow changed after review; the setup ends as `conflict` and changes nothing. */
export class LinkedWorkflowConflict extends Error {}

/** An interval or cron trigger starts a private task owned by its sponsor, so it runs at most hourly. */
export const agentTriggerMinimumMinutes = 60;

function nextRun(trigger: Extract<Trigger, { kind: 'interval' | 'cron' }>, now: Date) {
  try {
    const occurrence = nextOccurrence(trigger, now);
    if (!occurrence) throw new Error('not scheduled');
    return occurrence;
  } catch {
    throw new AgentError('schedule-invalid', 400);
  }
}

export function previewAgentTriggerCadence(
  trigger: Extract<AgentTrigger, { kind: 'interval' | 'cron' }>,
  now = new Date(),
) {
  const scheduled = { ...trigger, id: trigger.kind };
  const allowed =
    scheduled.kind === 'interval'
      ? scheduled.minutes >= agentTriggerMinimumMinutes
      : (() => {
          const first = new Date(nextRun(scheduled, new Date('2024-01-01T00:00:00.000Z')));
          return new Date(nextRun(scheduled, first)).getTime() - first.getTime() >= agentTriggerMinimumMinutes * 60000;
        })();
  if (!allowed) throw new AgentError('task-schedule-interval', 400);
  return { trigger, nextRunAt: nextRun(scheduled, now) };
}

export function requireAgentTriggerCadence(trigger: AgentTrigger) {
  if (trigger.kind === 'interval' || trigger.kind === 'cron') previewAgentTriggerCadence(trigger);
}

const defaultRunLimits = { toolCalls: 100, activeMilliseconds: 300000, credits: 100 };
const workflowName = (agentName: string) => (agentName.length > 100 ? `${agentName.slice(0, 99)}…` : agentName);

/** The agent step every linked Workflow runs: the prompt, with the trigger that started the run passed as data. */
function agentStep(
  agentId: string,
  prompt: string,
  limits: AgentSetup['runLimits'],
  activationId?: string,
): Definition['steps'][number] {
  return {
    id: 'run_agent',
    kind: 'agent',
    agentId,
    prompt: { kind: 'literal', value: prompt },
    context: { kind: 'input', path: [] },
    triggerContext: true,
    ...(activationId ? { activationId } : {}),
    limits: limits ?? defaultRunLimits,
  };
}

/** The linked Workflow's definition for a setup: every setup trigger, then one step that runs the prompt. */
export function agentLinkedDefinition(
  agent: { id: string; name: string },
  setup: Pick<AgentSetup, 'prompt' | 'runLimits' | 'triggers'>,
): Definition {
  if (setup.prompt === undefined) throw new AgentError('setup-prompt-required', 400);
  return {
    version: 1,
    name: workflowName(agent.name),
    triggers: setup.triggers.map(item => ({
      ...item.trigger,
      id: agentWorkflowTriggerId(item.id),
      ...(item.label ? { label: item.label } : {}),
    })),
    steps: [agentStep(agent.id, setup.prompt, setup.runLimits)],
  };
}

function bindWorkflows(tx: WorkflowTransaction, storage: AgentStorage, options: AgentWorkflowOptions) {
  const wake = options.workflowWake;
  return createWorkflows(storage, {
    agentSteps: true,
    // A wake before commit could reach a run that rolls back, so it waits for the caller's commit.
    ...(wake
      ? { wake: (work: Work) => Promise.resolve(afterCommit(tx.client, () => void wake(work).catch(() => undefined))) }
      : {}),
    ...(options.githubSubscriptions ? { githubSubscriptions: options.githubSubscriptions } : {}),
  });
}

const workflowRowSchema = z.object({
  id: uuidSchema,
  revision: uuidSchema,
  generation: z.number().int(),
  enabled: z.boolean(),
  archived: z.boolean(),
});
/** The agent's linked Workflow as the setup review binds it, or null when it has none. */
export async function agentLinkedWorkflow(tx: AgentTransaction, agentId: string, lock = false) {
  return workflowRowSchema
    .nullable()
    .parse(
      (
        await tx.client.query(
          `SELECT id,revision,generation,enabled,(archived_at IS NOT NULL) AS archived FROM ${relation(tx, 'tf_workflows')} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
          [agentLinkedWorkflowId(agentId)],
        )
      ).rows[0] ?? null,
    );
}

const oldWorkflowSchema = z.object({
  id: uuidSchema,
  generation: z.number().int(),
  enabled: z.boolean(),
  active: z.boolean(),
  sponsor: uuidSchema.nullable(),
  name: z.string(),
  definition: definitionSchema,
});
type OldWorkflow = z.infer<typeof oldWorkflowSchema>;
/** The agent's other unarchived Workflows: per-trigger ones from before it had one linked Workflow. */
async function oldWorkflows(tx: WorkflowTransaction, agentId: string) {
  return oldWorkflowSchema
    .array()
    .parse(
      (
        await tx.client.query(
          `SELECT w.id,w.generation,w.enabled,(w.active_revision IS NOT NULL) AS active,w.sponsor_membership_id AS sponsor,r.definition->>'name' AS name,r.definition FROM ${relation(tx, 'tf_workflows')} w JOIN ${relation(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=COALESCE(w.active_revision,w.revision) WHERE w.agent_id=$1 AND w.id<>$2 AND w.archived_at IS NULL ORDER BY w.id FOR UPDATE OF w`,
          [agentId, agentLinkedWorkflowId(agentId)],
        )
      ).rows,
    );
}
/** Maps each earlier per-trigger Workflow ID to the setup trigger UUID it was created for. */
async function setupTriggerIds(tx: WorkflowTransaction, agentId: string) {
  const rows = (
    await tx.client.query(
      `SELECT c.id,d.input FROM ${relation(tx, 'tf_agent_setup_commands')} c JOIN ${relation(tx, 'tf_agent_setup_drafts')} d ON d.agent_id=c.agent_id AND d.membership_id=c.membership_id AND d.version=c.version WHERE c.agent_id=$1 AND c.status='active'`,
      [agentId],
    )
  ).rows;
  const ids = new Map<string, string>();
  for (const row of rows) {
    const draft = storedAgentSetupDraftSchema.safeParse(row.input);
    if (!draft.success) continue;
    for (const item of draft.data.setup.triggers)
      ids.set(agentSetupWorkflowId(uuidSchema.parse(row.id), item.id), item.id);
  }
  return ids;
}
async function lockedGeneration(tx: WorkflowTransaction, id: string) {
  return z
    .number()
    .int()
    .parse(
      (await tx.client.query(`SELECT generation FROM ${relation(tx, 'tf_workflows')} WHERE id=$1`, [id])).rows[0]
        ?.generation,
    );
}

/** Whether the actor may archive every old Workflow; a combination that would leave one running is not applied. */
async function managesAll(tx: WorkflowTransaction, membershipId: string, olds: readonly OldWorkflow[]) {
  for (const old of olds) if (!(await hasGrant(tx, membershipId, old.id, 'manage'))) return false;
  return true;
}

/**
 * Moves each old Workflow's webhook keys to the matching trigger of the linked Workflow, so its URL forwards there,
 * then archives it. An old Workflow the actor cannot manage would keep running beside the linked one, so it fails the
 * whole combination.
 */
async function absorb(
  tx: WorkflowTransaction,
  storage: AgentStorage,
  workspaceId: string,
  actor: HumanActor,
  linked: { id: string; triggers: readonly Trigger[] },
  olds: readonly OldWorkflow[],
  target: (old: OldWorkflow, trigger: Trigger) => string | null,
  commandId: string,
  options: AgentWorkflowOptions,
) {
  const workflows = bindWorkflows(tx, storage, options);
  for (const old of olds) {
    if (!(await hasGrant(tx, actor.membershipId, old.id, 'manage'))) throw new AccessDenied();
    for (const trigger of old.definition.triggers) {
      if (trigger.kind !== 'webhook') continue;
      const to = target(old, trigger);
      if (to && linked.triggers.some(item => item.id === to && item.kind === 'webhook'))
        await workflows.moveWebhookTrigger(tx, workspaceId, {
          from: { workflowId: old.id, triggerId: trigger.id },
          to: { workflowId: linked.id, triggerId: to },
          alias: true,
        });
    }
    await workflows.archive(workspaceId, actor.userId, old.id, {
      commandId: derivedId(old.id, commandId, 'archive'),
      expectedGeneration: await lockedGeneration(tx, old.id),
    });
  }
}

/**
 * Saves a revision of the linked Workflow, gives it the grants of `grantsFrom`, sponsors it when it has unattended
 * triggers, and sets it on or off. Grants come before sponsorship, which needs every audience member to read it.
 */
async function saveLinked(
  tx: WorkflowTransaction,
  storage: AgentStorage,
  workspaceId: string,
  actor: HumanActor,
  input: {
    agentId: string;
    definition: Definition;
    expectedRevision: string | null;
    commandId: string;
    enabled: boolean;
    sponsor?: { membershipId: string; audience: string[] } | undefined;
    switchedOff?: readonly string[];
    grantsFrom?: readonly string[];
  },
  options: AgentWorkflowOptions,
) {
  if (input.definition.triggers.some(trigger => trigger.kind === 'github') && !options.githubSubscriptions)
    throw new AgentError('github-trigger-unavailable', 503);
  const id = agentLinkedWorkflowId(input.agentId);
  const workflows = bindWorkflows(tx, storage, options);
  let workflow = await workflows.save(
    workspaceId,
    actor.userId,
    id,
    {
      revision: derivedId(id, input.commandId, 'revision'),
      expectedRevision: input.expectedRevision,
      definition: input.definition,
    },
    { forAgentId: input.agentId },
  );
  if (input.grantsFrom?.length)
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_workflow_grants')} (workflow_id,membership_id,team_id,permission) SELECT DISTINCT $1::uuid,membership_id,team_id,permission FROM ${relation(tx, 'tf_workflow_grants')} WHERE workflow_id=ANY($2::uuid[]) ON CONFLICT DO NOTHING`,
      [id, input.grantsFrom],
    );
  const sponsor = input.sponsor ?? { membershipId: actor.membershipId, audience: [actor.membershipId] };
  if (input.definition.triggers.some(unattendedTrigger))
    workflow = await workflows.sponsorship(workspaceId, actor.userId, id, {
      sponsorMembershipId: sponsor.membershipId,
      historyAudience: sponsor.audience,
    });
  if (input.switchedOff?.length)
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_workflow_triggers')} SET enabled=false WHERE workflow_id=$1 AND trigger_id=ANY($2::text[])`,
      [id, input.switchedOff],
    );
  if (workflow.enabled === input.enabled && workflow.activeRevision === workflow.revision) return workflow;
  return workflows.activate(workspaceId, actor.userId, id, {
    commandId: derivedId(id, input.commandId, 'activate'),
    expectedGeneration: workflow.generation,
    revision: workflow.revision,
    enabled: input.enabled,
  });
}

/**
 * Applies an activating setup to the agent's linked Workflow inside `tx`, so it commits or rolls back with the caller.
 * The Workflow must still be the revision and generation the setup reviewed. A setup with triggers or a prompt saves
 * and turns it on, sponsored by `actor` when a trigger is unattended, and combines the agent's older per-trigger
 * Workflows into it. A setup with neither turns an existing linked Workflow off. Returns the linked Workflow's ID.
 */
export async function applyAgentLinkedWorkflow(
  tx: WorkflowTransaction,
  storage: AgentStorage,
  workspaceId: string,
  actor: HumanActor,
  input: {
    agentId: string;
    agentName: string;
    setup: Pick<AgentSetup, 'prompt' | 'runLimits' | 'triggers'>;
    expectedRevision: string | null;
    expectedGeneration: number | null;
    commandId: string;
  },
  options: AgentWorkflowOptions,
) {
  const current = await agentLinkedWorkflow(tx, input.agentId, true);
  if (
    (current?.revision ?? null) !== input.expectedRevision ||
    (current?.generation ?? null) !== input.expectedGeneration
  )
    throw new LinkedWorkflowConflict('linked-workflow-changed');
  if (current?.archived) throw new LinkedWorkflowConflict('linked-workflow-archived');
  if (!input.setup.triggers.length && input.setup.prompt === undefined) {
    if (!current) return null;
    if (current.enabled)
      await bindWorkflows(tx, storage, options).activate(workspaceId, actor.userId, current.id, {
        commandId: derivedId(current.id, input.commandId, 'disable'),
        expectedGeneration: current.generation,
        revision: current.revision,
        enabled: false,
      });
    return current.id;
  }
  for (const item of input.setup.triggers) requireAgentTriggerCadence(item.trigger);
  const definition = agentLinkedDefinition({ id: input.agentId, name: input.agentName }, input.setup);
  const workflow = await saveLinked(
    tx,
    storage,
    workspaceId,
    actor,
    {
      agentId: input.agentId,
      definition,
      expectedRevision: current?.revision ?? null,
      commandId: input.commandId,
      enabled: true,
    },
    options,
  );
  const olds = await oldWorkflows(tx, input.agentId);
  if (olds.length) {
    const fromSetup = await setupTriggerIds(tx, input.agentId);
    const claimed = new Set<string>();
    const webhooks = definition.triggers.filter(trigger => trigger.kind === 'webhook');
    // An old webhook forwards to the reviewed trigger made from the same setup trigger, else to an unclaimed webhook
    // with the same payload.
    const target = (old: OldWorkflow, trigger: Trigger) => {
      const setupId = fromSetup.get(old.id);
      const exact = setupId ? agentWorkflowTriggerId(setupId) : null;
      const match =
        webhooks.find(item => item.id === exact && !claimed.has(item.id)) ??
        webhooks.find(
          item =>
            !claimed.has(item.id) &&
            canonicalJson(item.payload ?? null) ===
              canonicalJson(trigger.kind === 'webhook' ? (trigger.payload ?? null) : null),
        );
      if (!match) return null;
      claimed.add(match.id);
      return match.id;
    };
    await absorb(
      tx,
      storage,
      workspaceId,
      actor,
      { id: workflow.id, triggers: definition.triggers },
      olds,
      target,
      input.commandId,
      options,
    );
  }
  return workflow.id;
}

const membershipUserSchema = z.object({ user_id: z.string() });
/**
 * Combines an agent's per-trigger Workflows into its linked Workflow when they all run the same agent step (prompt,
 * limits and activation) for the same sponsor and audience. Triggers keep their labels, switch state and webhook
 * keys; a trigger made by a setup takes the ID the next setup gives it. Returns `separate` when they differ, which
 * leaves them for the agent's next setup.
 */
export async function combineAgentWorkflows(
  tx: WorkflowTransaction,
  storage: AgentStorage,
  workspaceId: string,
  agentId: string,
  options: AgentWorkflowOptions,
): Promise<'combined' | 'separate' | 'none'> {
  if (
    (
      await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_workflows')} WHERE id=$1`, [
        agentLinkedWorkflowId(agentId),
      ])
    ).rows.length
  )
    return 'none';
  const olds = await oldWorkflows(tx, agentId);
  if (!olds.length) return 'none';
  const audiences = new Map<string, string[]>();
  for (const row of (
    await tx.client.query(
      `SELECT workflow_id,membership_id FROM ${relation(tx, 'tf_workflow_history_audience')} WHERE workflow_id=ANY($1::uuid[]) ORDER BY membership_id`,
      [olds.map(old => old.id)],
    )
  ).rows)
    audiences.set(row.workflow_id, [...(audiences.get(row.workflow_id) ?? []), uuidSchema.parse(row.membership_id)]);
  const steps = olds.map(old => {
    const [step, ...rest] = old.definition.steps;
    return !rest.length &&
      step?.kind === 'agent' &&
      step.agentId === agentId &&
      step.prompt.kind === 'literal' &&
      typeof step.prompt.value === 'string'
      ? step
      : null;
  });
  const keys = new Set(
    olds.map((old, index) => {
      const step = steps[index];
      return step
        ? canonicalJson({
            prompt: step.prompt,
            limits: step.limits,
            activationId: step.activationId ?? null,
            sponsor: old.sponsor,
            audience: audiences.get(old.id) ?? [],
          })
        : `custom:${old.id}`;
    }),
  );
  const [first] = olds;
  const step = steps[0];
  if (keys.size !== 1 || !first || !step || step.prompt.kind !== 'literal') return 'separate';
  const actingMembership =
    first.sponsor ??
    (
      await tx.client.query(
        `SELECT membership_id FROM ${relation(tx, 'tf_workflow_grants')} WHERE workflow_id=$1 AND permission='manage' AND membership_id IS NOT NULL ORDER BY membership_id LIMIT 1`,
        [first.id],
      )
    ).rows[0]?.membership_id;
  const member = membershipUserSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT user_id FROM ${relation(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
          [actingMembership ?? null],
        )
      ).rows[0],
    );
  if (!member || !actingMembership) throw new AgentError('combine-actor-unavailable');
  const actor = { userId: member.user_id, membershipId: uuidSchema.parse(actingMembership) } as HumanActor;
  if (!(await managesAll(tx, actor.membershipId, olds))) return 'separate';
  const fromSetup = await setupTriggerIds(tx, agentId);
  const now = Date.now();
  const used = new Set<string>();
  const unique = (id: string) => {
    let candidate = id;
    for (let index = 2; used.has(candidate); index++) candidate = `${id.slice(0, 44)}_${index}`;
    used.add(candidate);
    return candidate;
  };
  const moved: { old: OldWorkflow; from: Trigger; to: string }[] = [];
  const switchedOff: string[] = [];
  const triggerStates = new Map<string, boolean>();
  for (const row of (
    await tx.client.query(
      `SELECT workflow_id,trigger_id,enabled FROM ${relation(tx, 'tf_workflow_triggers')} WHERE workflow_id=ANY($1::uuid[])`,
      [olds.map(old => old.id)],
    )
  ).rows)
    triggerStates.set(`${row.workflow_id} ${row.trigger_id}`, row.enabled === true);
  const triggers: Trigger[] = [];
  for (const old of olds)
    for (const trigger of old.definition.triggers) {
      // A once trigger whose time has passed never fires again, so it is not carried over.
      if (trigger.kind === 'once' && Date.parse(trigger.at) <= now) continue;
      const setupId = old.definition.triggers.length === 1 ? fromSetup.get(old.id) : undefined;
      const id = unique(setupId ? agentWorkflowTriggerId(setupId) : trigger.id);
      triggers.push({ ...trigger, id });
      moved.push({ old, from: trigger, to: id });
      if (!old.enabled || triggerStates.get(`${old.id} ${trigger.id}`) === false) switchedOff.push(id);
    }
  if (triggers.length > 20) return 'separate';
  const name = (
    await tx.client.query(
      `SELECT d.definition->>'name' AS name FROM ${relation(tx, 'tf_agents')} a JOIN ${relation(tx, 'tf_agent_saved_revisions')} s ON s.agent_id=a.id AND s.soul_revision=a.saved_revision JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=s.agent_id AND d.revision=s.definition_revision WHERE a.id=$1`,
      [agentId],
    )
  ).rows[0]?.name as unknown;
  const definition: Definition = {
    version: 1,
    name: workflowName(typeof name === 'string' && name ? name : (first.name.split(': ')[0] ?? first.name)),
    triggers,
    steps: [agentStep(agentId, step.prompt.value as string, step.limits, step.activationId)],
  };
  const commandId = derivedId('combine', agentId);
  const linkedId = agentLinkedWorkflowId(agentId);
  const enabled = olds.some(old => old.enabled && old.active);
  const audience = audiences.get(first.id) ?? [];
  await saveLinked(
    tx,
    storage,
    workspaceId,
    actor,
    {
      agentId,
      definition,
      expectedRevision: null,
      commandId,
      enabled,
      ...(first.sponsor && audience.length ? { sponsor: { membershipId: first.sponsor, audience } } : {}),
      switchedOff,
      // People who could see or manage the old Workflows keep that access to the combined one.
      grantsFrom: olds.map(old => old.id),
    },
    options,
  );
  await absorb(
    tx,
    storage,
    workspaceId,
    actor,
    { id: linkedId, triggers },
    olds,
    (old, trigger) => moved.find(item => item.old.id === old.id && item.from.id === trigger.id)?.to ?? null,
    commandId,
    options,
  );
  return 'combined';
}
