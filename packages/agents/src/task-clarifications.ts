import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, canAccessAsset, requireTablePermission, type HumanActor } from '@tulipfarm/access';
import { writeRunState } from '@tulipfarm/tables/store';
import { relationInstalled } from '@tulipfarm/workspace-storage/transaction-reads';
import { agentCompatibility, relation, type AgentStorage, type AgentTransaction } from './store.ts';
import {
  githubAccountChoiceSchema,
  taskClarificationAnswerInputSchema,
  taskClarificationDraftSchema,
  taskClarificationFieldSchema,
  taskClarificationViewSchema,
  type GitHubAccountChoice,
  type TaskClarificationDraft,
  type TaskClarificationField,
  type TaskClarificationView,
} from './task-clarification-contracts.ts';

const clarificationRowSchema = z.object({
  id: z.uuid(),
  table_id: z.uuid(),
  row_id: z.uuid(),
  agent_task_id: z.uuid().nullable(),
  agent_id: z.uuid(),
  sponsor_membership_id: z.uuid(),
  title: z.string(),
  summary: z.string(),
  fields: z.array(taskClarificationFieldSchema),
  answers: z.record(z.string(), z.string()).nullable(),
  status: z.enum(['open', 'answered', 'cancelled']),
  created_at: z.date(),
  answered_at: z.date().nullable(),
  answered_via: z.enum(['web', 'slack']).nullable(),
});

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class TaskClarificationError extends Error {
  readonly code: 'not-found' | 'already-answered' | 'invalid-answer';
  readonly fieldId?: string | undefined;
  constructor(code: TaskClarificationError['code'], message?: string, fieldId?: string) {
    super(message ?? code);
    this.code = code;
    this.fieldId = fieldId;
  }
}

/**
 * Extracts an optional `CLARIFICATION:` JSON block from an agent's reply and strips it from the visible note.
 * Accepts either a fenced JSON block right after `CLARIFICATION:` or an inline JSON object on the same line.
 */
export function parseClarificationBlock(text: string): {
  draft: TaskClarificationDraft | null;
  text: string;
} {
  const fenced = /(?:^|\n)\s*\**CLARIFICATION:\**\s*\n```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  const inline = fenced ? null : /(?:^|\n)\s*\**CLARIFICATION:\**\s*(\{[\s\S]*?\})\s*(?=\n|$)/i.exec(text);
  const match = fenced ?? inline;
  if (!match?.[1]) return { draft: null, text };
  try {
    const parsed = taskClarificationDraftSchema.safeParse(JSON.parse(match[1].trim()));
    if (!parsed.success) return { draft: null, text };
    const stripped = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim();
    return { draft: parsed.data, text: stripped };
  } catch {
    return { draft: null, text };
  }
}

async function listGitHubAccountChoices(tx: AgentTransaction, actor: HumanActor): Promise<GitHubAccountChoice[]> {
  const choices: GitHubAccountChoice[] = [];
  if (await relationInstalled(tx.client, relation(tx, 'tf_github_accounts'))) {
    const personal = z
      .array(
        z.object({
          id: z.uuid(),
          generation: z.number().int().positive(),
          verified_login: z.string().nullable(),
          display_name: z.string().nullable(),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT id, generation, identity->>'login' AS verified_login, identity->>'name' AS display_name
             FROM ${relation(tx, 'tf_github_accounts')}
             WHERE owner_membership_id = $1 AND state = 'active'
             ORDER BY created_at ASC`,
            [actor.membershipId],
          )
        ).rows,
      );
    for (const account of personal) {
      const name = account.verified_login
        ? `@${account.verified_login}`
        : (account.display_name ?? `Personal account ${account.id.slice(0, 8)}`);
      choices.push(
        githubAccountChoiceSchema.parse({
          value: `personal:${account.id}:${account.generation}`,
          kind: 'personal',
          id: account.id,
          generation: account.generation,
          label: `${name} (Personal GitHub)`,
        }),
      );
    }
  }
  if (await relationInstalled(tx.client, relation(tx, 'tf_integrations'))) {
    const teamRows = z
      .array(
        z.object({
          id: z.uuid(),
          generation: z.number().int().positive(),
          name: z.string(),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT id, generation, name
             FROM ${relation(tx, 'tf_integrations')}
             WHERE enabled AND deleted_at IS NULL AND credential IS NOT NULL
             ORDER BY name ASC`,
          )
        ).rows,
      );
    for (const integration of teamRows) {
      const canUse =
        (await canAccessAsset(tx, actor, integration.id, 'integration.read')) &&
        (await canAccessAsset(tx, actor, integration.id, 'integration.use'));
      if (!canUse) continue;
      choices.push(
        githubAccountChoiceSchema.parse({
          value: `team:${integration.id}:${integration.generation}`,
          kind: 'team',
          id: integration.id,
          generation: integration.generation,
          label: `${integration.name} (Team GitHub)`,
        }),
      );
    }
  }
  return choices;
}

function toView(
  row: z.infer<typeof clarificationRowSchema>,
  githubAccounts: GitHubAccountChoice[],
): TaskClarificationView {
  return taskClarificationViewSchema.parse({
    id: row.id,
    tableId: row.table_id,
    rowId: row.row_id,
    agentTaskId: row.agent_task_id,
    agentId: row.agent_id,
    title: row.title,
    summary: row.summary,
    fields: row.fields,
    githubAccounts,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    answeredAt: row.answered_at?.toISOString() ?? null,
    answeredVia: row.answered_via,
    answers: row.answers,
  });
}

function formatAnswerLine(field: TaskClarificationField, rawValue: string, accounts: GitHubAccountChoice[]): string {
  if (field.kind === 'github_account') {
    const matched = accounts.find(account => account.value === rawValue);
    return `- **${field.label}:** ${matched ? matched.label : rawValue}`;
  }
  if (field.kind === 'select') {
    const matched = field.options.find(option => option.value === rawValue);
    return `- **${field.label}:** ${matched ? matched.label : rawValue}`;
  }
  return `- **${field.label}:** ${rawValue}`;
}

export async function createRowClarification(
  tx: AgentTransaction,
  input: {
    tableId: string;
    rowId: string;
    agentTaskId: string | null;
    agentId: string;
    sponsorMembershipId: string;
    draft: TaskClarificationDraft;
  },
): Promise<string | null> {
  if (!(await relationInstalled(tx.client, relation(tx, 'tf_row_clarifications')))) return null;
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_row_clarifications')}
     SET status = 'cancelled'
     WHERE table_id = $1 AND row_id = $2 AND status = 'open'`,
    [input.tableId, input.rowId],
  );
  const id = randomUUID();
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_row_clarifications')}
      (id, table_id, row_id, agent_task_id, agent_id, sponsor_membership_id, title, summary, fields, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')`,
    [
      id,
      input.tableId,
      input.rowId,
      input.agentTaskId,
      input.agentId,
      input.sponsorMembershipId,
      input.draft.title,
      input.draft.summary,
      JSON.stringify(input.draft.fields),
    ],
  );
  return id;
}

export function createTaskClarifications(options: {
  runtime: AgentStorage;
  /** Optional callback to bind a selected personal GitHub account onto the underlying agent task. */
  bindPersonalGitHubAccount?: (
    workspaceId: string,
    actor: HumanActor,
    taskId: string,
    accountId: string,
  ) => Promise<void>;
}) {
  const { runtime } = options;

  async function listOpen(
    workspaceId: string,
    actor: HumanActor,
    tableId: string,
    rowId: string,
  ): Promise<TaskClarificationView[]> {
    return runtime.transaction(workspaceId, agentCompatibility, async tx => {
      await requireTablePermission(tx, actor, tableId, 'table.row.read');
      if (!(await relationInstalled(tx.client, relation(tx, 'tf_row_clarifications')))) return [];
      const rows = z.array(clarificationRowSchema).parse(
        (
          await tx.client.query(
            `SELECT id, table_id, row_id, agent_task_id, agent_id, sponsor_membership_id,
                    title, summary, fields, answers, status, created_at, answered_at, answered_via
             FROM ${relation(tx, 'tf_row_clarifications')}
             WHERE table_id = $1 AND row_id = $2 AND status = 'open'
             ORDER BY created_at DESC LIMIT 5`,
            [tableId, rowId],
          )
        ).rows,
      );
      if (!rows.length) return [];
      const needsGitHub = rows.some(row => row.fields.some(field => field.kind === 'github_account'));
      const accounts = needsGitHub ? await listGitHubAccountChoices(tx, actor) : [];
      return rows.map(row => toView(row, accounts));
    });
  }

  async function readById(
    workspaceId: string,
    actor: HumanActor,
    clarificationId: string,
  ): Promise<TaskClarificationView | null> {
    return runtime.transaction(workspaceId, agentCompatibility, async tx => {
      if (!(await relationInstalled(tx.client, relation(tx, 'tf_row_clarifications')))) return null;
      const row = clarificationRowSchema.optional().parse(
        (
          await tx.client.query(
            `SELECT id, table_id, row_id, agent_task_id, agent_id, sponsor_membership_id,
                    title, summary, fields, answers, status, created_at, answered_at, answered_via
             FROM ${relation(tx, 'tf_row_clarifications')}
             WHERE id = $1`,
            [clarificationId],
          )
        ).rows[0],
      );
      if (!row) return null;
      await requireTablePermission(tx, actor, row.table_id, 'table.row.read');
      const needsGitHub = row.fields.some(field => field.kind === 'github_account');
      const accounts = needsGitHub ? await listGitHubAccountChoices(tx, actor) : [];
      return toView(row, accounts);
    });
  }

  async function answer(
    workspaceId: string,
    actor: HumanActor,
    clarificationId: string,
    rawInput: unknown,
    via: 'web' | 'slack',
    expectedRow?: { tableId: string; rowId: string },
  ): Promise<TaskClarificationView> {
    const parsedInput = taskClarificationAnswerInputSchema.parse(rawInput);
    let bindGitHub: { taskId: string; accountId: string } | null = null;
    const view = await runtime.transaction(workspaceId, agentCompatibility, async tx => {
      if (!(await relationInstalled(tx.client, relation(tx, 'tf_row_clarifications')))) {
        throw new TaskClarificationError('not-found');
      }
      const row = clarificationRowSchema.optional().parse(
        (
          await tx.client.query(
            `SELECT id, table_id, row_id, agent_task_id, agent_id, sponsor_membership_id,
                    title, summary, fields, answers, status, created_at, answered_at, answered_via
             FROM ${relation(tx, 'tf_row_clarifications')}
             WHERE id = $1 FOR UPDATE`,
            [clarificationId],
          )
        ).rows[0],
      );
      if (!row) throw new TaskClarificationError('not-found');
      if (expectedRow && (row.table_id !== expectedRow.tableId || row.row_id !== expectedRow.rowId)) {
        throw new TaskClarificationError('not-found');
      }
      await requireTablePermission(tx, actor, row.table_id, 'table.row.read');
      if (row.sponsor_membership_id !== actor.membershipId) {
        const canEdit = await requireTablePermission(tx, actor, row.table_id, 'table.row.update').then(
          () => true,
          error => {
            if (error instanceof AccessDenied) return false;
            throw error;
          },
        );
        if (!canEdit) throw new AccessDenied();
      }
      if (row.status !== 'open')
        throw new TaskClarificationError('already-answered', 'This form was already answered.');

      const needsGitHub = row.fields.some(field => field.kind === 'github_account');
      const accounts = needsGitHub ? await listGitHubAccountChoices(tx, actor) : [];
      const normalizedAnswers: Record<string, string> = {};

      for (const field of row.fields) {
        const value = (parsedInput.answers[field.id] ?? '').trim();
        if (!value) {
          if (field.required) {
            throw new TaskClarificationError('invalid-answer', `${field.label} is required.`, field.id);
          }
          continue;
        }
        if (field.kind === 'github_repository' && !repoPattern.test(value)) {
          throw new TaskClarificationError('invalid-answer', `${field.label} must be in owner/repo format.`, field.id);
        }
        if (field.kind === 'select' && !field.options.some(option => option.value === value)) {
          throw new TaskClarificationError('invalid-answer', `Choose a valid option for ${field.label}.`, field.id);
        }
        if (field.kind === 'github_account') {
          const picked = accounts.find(account => account.value === value);
          if (!picked) {
            throw new TaskClarificationError(
              'invalid-answer',
              `Choose a connected account for ${field.label}.`,
              field.id,
            );
          }
          if (picked.kind === 'personal' && row.agent_task_id) {
            bindGitHub = { taskId: row.agent_task_id, accountId: picked.id };
          }
        }
        normalizedAnswers[field.id] = value;
      }

      const updated = clarificationRowSchema.parse(
        (
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_row_clarifications')}
             SET status = 'answered',
                 answers = $2,
                 answered_at = clock_timestamp(),
                 answered_by_membership_id = $3,
                 answered_via = $4
             WHERE id = $1
             RETURNING id, table_id, row_id, agent_task_id, agent_id, sponsor_membership_id,
                       title, summary, fields, answers, status, created_at, answered_at, answered_via`,
            [clarificationId, JSON.stringify(normalizedAnswers), actor.membershipId, via],
          )
        ).rows[0],
      );

      // Post a clean summary comment to the task thread so the agent reads the submitted details on wake.
      const lines = row.fields
        .filter(field => normalizedAnswers[field.id] !== undefined)
        .map(field => formatAnswerLine(field, normalizedAnswers[field.id]!, accounts));
      const body = [`Answered "${row.title}"${via === 'slack' ? ' (via Slack)' : ''}:`, ...lines].join('\n');

      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_row_thread_items')}
          (id, table_id, row_id, kind, author_membership_id, body)
         VALUES ($1, $2, $3, 'comment', $4, $5)`,
        [randomUUID(), row.table_id, row.row_id, actor.membershipId, body.slice(0, 20000)],
      );

      // Wake only if the same agent is still assigned and waiting on this row; never reopen completed or reassigned work.
      if (await relationInstalled(tx.client, relation(tx, 'tf_row_assignments'))) {
        const assignment = (
          await tx.client.query(
            `SELECT agent_id, run_state
             FROM ${relation(tx, 'tf_row_assignments')}
             WHERE table_id = $1 AND row_id = $2
             FOR UPDATE`,
            [row.table_id, row.row_id],
          )
        ).rows[0] as { agent_id: string; run_state: string } | undefined;

        if (assignment && assignment.agent_id === row.agent_id && assignment.run_state === 'waiting') {
          if (await relationInstalled(tx.client, relation(tx, 'tf_inbox_items'))) {
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_inbox_items')}
               SET resolved_at = clock_timestamp()
               WHERE table_id = $1 AND row_id = $2 AND kind = 'waiting' AND resolved_at IS NULL`,
              [row.table_id, row.row_id],
            );
          }
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_row_assignments')}
             SET pending_wakes = pending_wakes + 1,
                 run_state = 'queued',
                 reason = NULL,
                 updated_at = clock_timestamp()
             WHERE table_id = $1 AND row_id = $2`,
            [row.table_id, row.row_id],
          );
          await writeRunState(tx, { tableId: row.table_id, recordId: row.row_id, state: 'queued' });
        }
      }

      return toView(updated, accounts);
    });

    if (bindGitHub && options.bindPersonalGitHubAccount) {
      const { taskId, accountId } = bindGitHub as { taskId: string; accountId: string };
      await options.bindPersonalGitHubAccount(workspaceId, actor, taskId, accountId);
    }
    return view;
  }

  return { listOpen, readById, answer };
}
