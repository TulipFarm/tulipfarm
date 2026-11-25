import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AccessDenied, currentMember, lockAuthorization, uuidSchema, type HumanActor } from '@tulipfarm/access';
import { commonCompatibility, qualified, type SqlClient } from '@tulipfarm/workspace-storage/runtime';

export const codeSessionCompatibility = {
  minimum: 114,
  maximum: commonCompatibility.maximum,
} as const;
import { codingAgents, type CodingAgent } from './coding-run-contracts.ts';
import {
  buildSessionBranchName,
  canTransitionCodeSessionStage,
  codeSessionCheckSchema,
  codeSessionRequestAnswerSchema,
  codeSessionRequestPayloadSchema,
  codeSessionStageLabels,
  codeSessionStageRunState,
  codeSessionStageSchema,
  codeSessionStartInputSchema,
  codeTerminalStreamKindSchema,
  DEFAULT_CODE_SESSION_BUDGET_MINUTES,
  defaultMemberCodeSettings,
  deriveSessionTitle,
  memberCodeSettingsSchema,
  sessionReviewerSchema,
  turnModeSchema,
  type CodeSessionCheck,
  type CodeSessionRequestAnswer,
  type CodeSessionRequestPayload,
  type CodeSessionRequestView,
  type CodeSessionStage,
  type CodeSessionStartInput,
  type CodeSessionStepView,
  type CodeSessionView,
  type CodeTerminalChunk,
  type CodeTerminalStreamKind,
  type MemberCodeSettings,
  type SessionReviewer,
  type TurnMode,
} from './code-session-contracts.ts';

export type CodeSessionTransaction = { client: SqlClient; schema: string };
export type CodeSessionStorage = {
  transaction<T>(
    workspaceId: string,
    range: { minimum: number; maximum: number },
    action: (tx: CodeSessionTransaction) => Promise<T>,
  ): Promise<T>;
};

export class CodeSessionError extends Error {
  readonly code:
    | 'code-session-not-found'
    | 'code-session-request-not-found'
    | 'code-session-request-already-answered'
    | 'code-session-invalid-transition'
    | 'code-session-invalid-answer'
    | 'code-session-digest-mismatch'
    | 'code-session-not-owner';
  constructor(code: CodeSessionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const sessionRowSchema = z.object({
  id: uuidSchema,
  table_id: uuidSchema.nullable(),
  row_id: uuidSchema.nullable(),
  owner_membership_id: uuidSchema,
  origin_conversation_id: uuidSchema.nullable(),
  origin_turn_id: uuidSchema.nullable(),
  title: z.string(),
  request: z.string(),
  agent: z.enum(codingAgents),
  repository: z.string(),
  base_branch: z.string(),
  session_branch: z.string(),
  github_account: z.string().nullable(),
  pull_request_number: z.number().int().nullable(),
  pull_request_url: z.string().nullable(),
  stage: codeSessionStageSchema,
  reviewers: z.unknown(),
  open_pull_requests: z.boolean(),
  open_as_draft: z.boolean(),
  budget_ms: z.coerce.number().int().positive(),
  active_ms: z.coerce.number().int().nonnegative(),
  fix_attempts: z.number().int().nonnegative(),
  review_rounds: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  plan_markdown: z.string().nullable(),
  plan_approved_at: z.date().nullable(),
  usage_limit_until: z.date().nullable(),
  workflow_id: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
type SessionRow = z.infer<typeof sessionRowSchema>;

const stepRowSchema = z.object({
  id: uuidSchema,
  session_id: uuidSchema,
  stage: codeSessionStageSchema,
  agent: z.enum(codingAgents),
  model: z.string().nullable(),
  outcome: z.enum(['questions', 'plan', 'done', 'blocked', 'limit', 'failed']),
  final_message: z.string().nullable(),
  changed_files: z.array(z.string()),
  diff_summary: z.string().nullable(),
  checks: z.unknown(),
  screenshots: z.unknown(),
  active_ms: z.coerce.number().int().nonnegative(),
  created_at: z.date(),
});

const requestRowSchema = z.object({
  id: uuidSchema,
  session_id: uuidSchema,
  kind: z.enum(['question', 'plan-approval', 'pr-approval', 'merge-approval', 'stuck', 'budget']),
  payload: z.unknown(),
  decision_digest: z.string(),
  answer: z.unknown().nullable(),
  answered_by: uuidSchema.nullable(),
  answered_at: z.date().nullable(),
  created_at: z.date(),
});

const settingsRowSchema = z.object({
  branch_prefix: z.string(),
  open_pull_requests: z.boolean(),
  open_as_draft: z.boolean(),
  reviewers: z.unknown(),
});

function hashDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseReviewers(raw: unknown): SessionReviewer[] {
  const parsed = z.array(sessionReviewerSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function toRequestView(row: z.infer<typeof requestRowSchema>): CodeSessionRequestView {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    payload: codeSessionRequestPayloadSchema.parse(row.payload),
    decisionDigest: row.decision_digest,
    answer: row.answer ? codeSessionRequestAnswerSchema.parse(row.answer) : null,
    answeredAt: row.answered_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function toStepView(row: z.infer<typeof stepRowSchema>): CodeSessionStepView {
  const checks = z.array(codeSessionCheckSchema).safeParse(row.checks);
  const screenshots = z.array(z.string()).safeParse(row.screenshots);
  return {
    id: row.id,
    sessionId: row.session_id,
    stage: row.stage,
    agent: row.agent,
    model: row.model,
    outcome: row.outcome,
    finalMessage: row.final_message,
    changedFiles: row.changed_files,
    diffSummary: row.diff_summary,
    checks: checks.success ? checks.data : [],
    screenshots: screenshots.success ? screenshots.data : [],
    activeMs: row.active_ms,
    createdAt: row.created_at.toISOString(),
  };
}

function toSessionView(
  row: SessionRow,
  viewerMembershipId: string,
  canReadDetails: boolean,
  openRequest: CodeSessionRequestView | null,
  steps: CodeSessionStepView[],
): CodeSessionView {
  const isOwner = row.owner_membership_id === viewerMembershipId;
  const allowDetails = isOwner || canReadDetails;
  return {
    id: row.id,
    tableId: row.table_id,
    rowId: row.row_id,
    ownerMembershipId: row.owner_membership_id,
    isOwner,
    canReadDetails: allowDetails,
    originConversationId: allowDetails ? row.origin_conversation_id : null,
    title: row.title,
    request: allowDetails ? row.request : null,
    agent: row.agent,
    repository: row.repository,
    baseBranch: row.base_branch,
    sessionBranch: allowDetails ? row.session_branch : 'protected',
    githubAccount: allowDetails ? row.github_account : null,
    pullRequestNumber: row.pull_request_number,
    pullRequestUrl: row.pull_request_url,
    stage: row.stage,
    stageLabel: codeSessionStageLabels[row.stage],
    runState: codeSessionStageRunState[row.stage],
    reviewers: parseReviewers(row.reviewers),
    openPullRequests: row.open_pull_requests,
    openAsDraft: row.open_as_draft,
    budgetMs: row.budget_ms,
    activeMs: row.active_ms,
    fixAttempts: row.fix_attempts,
    reviewRounds: row.review_rounds,
    summary: allowDetails ? row.summary : null,
    planMarkdown: allowDetails ? row.plan_markdown : null,
    planApprovedAt: row.plan_approved_at?.toISOString() ?? null,
    usageLimitUntil: row.usage_limit_until?.toISOString() ?? null,
    errorMessage: allowDetails ? row.error_message : null,
    openRequest: isOwner ? openRequest : null,
    steps: allowDetails ? steps : [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function resolveMember(tx: CodeSessionTransaction, actor: HumanActor) {
  await lockAuthorization(tx);
  const member = await currentMember(tx, actor);
  if (!member) throw new AccessDenied();
  return member;
}

export async function getMemberCodeSettingsInTx(
  tx: CodeSessionTransaction,
  membershipId: string,
): Promise<MemberCodeSettings> {
  const table = qualified(tx.schema, 'tf_member_code_settings');
  const result = await tx.client.query(
    `SELECT branch_prefix, open_pull_requests, open_as_draft, reviewers FROM ${table} WHERE membership_id = $1`,
    [membershipId],
  );
  const row = settingsRowSchema.optional().parse(result.rows[0]);
  if (!row) return defaultMemberCodeSettings;
  return {
    branchPrefix: row.branch_prefix,
    openPullRequests: row.open_pull_requests,
    openAsDraft: row.open_as_draft,
    reviewers: parseReviewers(row.reviewers),
  };
}

export async function getMemberCodeSettings(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
): Promise<MemberCodeSettings> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    return getMemberCodeSettingsInTx(tx, member.id);
  });
}

export async function updateMemberCodeSettings(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  input: MemberCodeSettings,
): Promise<MemberCodeSettings> {
  const settings = memberCodeSettingsSchema.parse(input);
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    const table = qualified(tx.schema, 'tf_member_code_settings');
    await tx.client.query(
      `INSERT INTO ${table} (membership_id, branch_prefix, open_pull_requests, open_as_draft, reviewers, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp())
       ON CONFLICT (membership_id) DO UPDATE
       SET branch_prefix = EXCLUDED.branch_prefix,
           open_pull_requests = EXCLUDED.open_pull_requests,
           open_as_draft = EXCLUDED.open_as_draft,
           reviewers = EXCLUDED.reviewers,
           updated_at = clock_timestamp()`,
      [
        member.id,
        settings.branchPrefix,
        settings.openPullRequests,
        settings.openAsDraft,
        JSON.stringify(settings.reviewers),
      ],
    );
    return settings;
  });
}

async function assertConversationAccessible(
  tx: CodeSessionTransaction,
  conversationId: string,
  membershipId: string,
): Promise<void> {
  const conversationsTable = qualified(tx.schema, 'tf_conversations');
  const projectsTable = qualified(tx.schema, 'tf_projects');
  const projectMembersTable = qualified(tx.schema, 'tf_project_members');
  const found = await tx.client.query(
    `SELECT c.id
     FROM ${conversationsTable} c
     LEFT JOIN ${projectsTable} p ON p.id = c.project_id
     LEFT JOIN ${projectMembersTable} pm ON pm.project_id = c.project_id AND pm.membership_id = $2
     WHERE c.id = $1
       AND (
         c.owner_membership_id = $2
         OR (c.project_id IS NOT NULL AND p.archived_at IS NULL AND pm.membership_id IS NOT NULL)
       )`,
    [conversationId, membershipId],
  );
  if (found.rows.length === 0) {
    throw new CodeSessionError('code-session-not-found', 'Conversation not found.');
  }
}

export async function getConversationTurnMode(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  conversationId: string,
): Promise<TurnMode> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    await assertConversationAccessible(tx, conversationId, member.id);
    const table = qualified(tx.schema, 'tf_conversation_turn_modes');
    const result = await tx.client.query(
      `SELECT mode FROM ${table} WHERE conversation_id = $1 AND membership_id = $2`,
      [conversationId, member.id],
    );
    const parsed = turnModeSchema.safeParse(result.rows[0]?.mode);
    return parsed.success ? parsed.data : 'normal';
  });
}

export async function setConversationTurnMode(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  conversationId: string,
  mode: TurnMode,
): Promise<TurnMode> {
  const validMode = turnModeSchema.parse(mode);
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    await assertConversationAccessible(tx, conversationId, member.id);
    const table = qualified(tx.schema, 'tf_conversation_turn_modes');
    await tx.client.query(
      `INSERT INTO ${table} (conversation_id, membership_id, mode, updated_at)
       VALUES ($1, $2, $3, clock_timestamp())
       ON CONFLICT (conversation_id, membership_id) DO UPDATE
       SET mode = EXCLUDED.mode, updated_at = clock_timestamp()`,
      [conversationId, member.id, validMode],
    );
    return validMode;
  });
}

export async function createCodeSessionInTx(
  tx: CodeSessionTransaction,
  input: {
    id?: string;
    ownerMembershipId: string;
    originConversationId?: string | null;
    originTurnId?: string | null;
    tableId?: string | null;
    rowId?: string | null;
    title?: string;
    request: string;
    start: CodeSessionStartInput;
  },
): Promise<CodeSessionView> {
  const validStart = codeSessionStartInputSchema.parse(input.start);
  const settings = await getMemberCodeSettingsInTx(tx, input.ownerMembershipId);
  const id = input.id ?? randomUUID();
  const title = input.title?.trim() || deriveSessionTitle(input.request);
  const sessionBranch = buildSessionBranchName(settings.branchPrefix, title, id);
  const reviewers = validStart.reviewers ?? settings.reviewers;
  const budgetMs = (validStart.budgetMinutes ?? DEFAULT_CODE_SESSION_BUDGET_MINUTES) * 60 * 1000;
  const workflowId = `code-session-${id}`;
  const table = qualified(tx.schema, 'tf_code_sessions');

  const result = await tx.client.query(
    `INSERT INTO ${table} (
       id, table_id, row_id, owner_membership_id, origin_conversation_id, origin_turn_id,
       title, request, agent, repository, base_branch, session_branch, github_account,
       stage, reviewers, open_pull_requests, open_as_draft, budget_ms, workflow_id
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'brainstorm',$14::jsonb,$15,$16,$17,$18)
     RETURNING *`,
    [
      id,
      input.tableId ?? null,
      input.rowId ?? null,
      input.ownerMembershipId,
      input.originConversationId ?? null,
      input.originTurnId ?? null,
      title,
      input.request,
      validStart.agent,
      validStart.repository,
      validStart.baseBranch,
      sessionBranch,
      validStart.githubAccount ?? null,
      JSON.stringify(reviewers),
      settings.openPullRequests,
      settings.openAsDraft,
      budgetMs,
      workflowId,
    ],
  );
  const row = sessionRowSchema.parse(result.rows[0]);
  const agentCli = validStart.agent === 'claude-code' ? 'claude' : validStart.agent === 'codex' ? 'codex' : 'copilot';
  await appendCodeSessionTerminalChunkInTx(tx, {
    sessionId: row.id,
    stage: 'brainstorm',
    stream: 'system',
    chunk: `$ ${agentCli} --repo ${validStart.repository} --base ${validStart.baseBranch} --branch ${sessionBranch}\n❯ ${input.request}`,
  });
  return toSessionView(row, input.ownerMembershipId, true, null, []);
}

export async function createCodeSession(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  input: {
    id?: string;
    originConversationId?: string | null;
    originTurnId?: string | null;
    tableId?: string | null;
    rowId?: string | null;
    title?: string;
    request: string;
    start: CodeSessionStartInput;
  },
): Promise<CodeSessionView> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    return createCodeSessionInTx(tx, { ...input, ownerMembershipId: member.id });
  });
}

async function loadOpenRequest(tx: CodeSessionTransaction, sessionId: string): Promise<CodeSessionRequestView | null> {
  const table = qualified(tx.schema, 'tf_code_session_requests');
  const result = await tx.client.query(
    `SELECT * FROM ${table} WHERE session_id = $1 AND answered_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  const row = requestRowSchema.optional().parse(result.rows[0]);
  return row ? toRequestView(row) : null;
}

async function loadSteps(tx: CodeSessionTransaction, sessionId: string): Promise<CodeSessionStepView[]> {
  const table = qualified(tx.schema, 'tf_code_session_steps');
  const result = await tx.client.query(`SELECT * FROM ${table} WHERE session_id = $1 ORDER BY created_at ASC`, [
    sessionId,
  ]);
  return result.rows.map(row => toStepView(stepRowSchema.parse(row)));
}

export async function readCodeSession(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  sessionId: string,
  options?: { canReadRepo?: (repository: string) => Promise<boolean> },
): Promise<CodeSessionView> {
  const loaded = await storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    const table = qualified(tx.schema, 'tf_code_sessions');
    const result = await tx.client.query(`SELECT * FROM ${table} WHERE id = $1`, [sessionId]);
    const row = sessionRowSchema.optional().parse(result.rows[0]);
    if (!row) throw new CodeSessionError('code-session-not-found', 'Code session not found.');
    const [openRequest, steps] = await Promise.all([loadOpenRequest(tx, row.id), loadSteps(tx, row.id)]);
    return { member, row, openRequest, steps };
  });
  const isOwner = loaded.row.owner_membership_id === loaded.member.id;
  const canReadDetails = isOwner || (options?.canReadRepo ? await options.canReadRepo(loaded.row.repository) : false);
  return toSessionView(loaded.row, loaded.member.id, canReadDetails, loaded.openRequest, loaded.steps);
}

export async function readCodeSessionSystem(
  storage: CodeSessionStorage,
  workspaceId: string,
  sessionId: string,
): Promise<CodeSessionView> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const table = qualified(tx.schema, 'tf_code_sessions');
    const result = await tx.client.query(`SELECT * FROM ${table} WHERE id = $1`, [sessionId]);
    const row = sessionRowSchema.optional().parse(result.rows[0]);
    if (!row) throw new CodeSessionError('code-session-not-found', 'Code session not found.');
    const [openRequest, steps] = await Promise.all([loadOpenRequest(tx, row.id), loadSteps(tx, row.id)]);
    return toSessionView(row, row.owner_membership_id, true, openRequest, steps);
  });
}

export async function listCodeSessions(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  filters?: { conversationId?: string; rowId?: string; scope?: 'mine' | 'workspace'; limit?: number },
): Promise<CodeSessionView[]> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    const table = qualified(tx.schema, 'tf_code_sessions');
    const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 100);
    const scope = filters?.scope ?? (filters?.rowId ? 'workspace' : 'mine');
    const result = filters?.conversationId
      ? await tx.client.query(
          `SELECT * FROM ${table}
           WHERE origin_conversation_id = $1 AND owner_membership_id = $2
           ORDER BY created_at DESC LIMIT $3`,
          [filters.conversationId, member.id, limit],
        )
      : filters?.rowId
        ? await tx.client.query(
            `SELECT * FROM ${table}
             WHERE row_id = $1
             ORDER BY created_at DESC LIMIT $2`,
            [filters.rowId, limit],
          )
        : scope === 'workspace'
          ? await tx.client.query(
              `SELECT * FROM ${table}
               WHERE row_id IS NOT NULL OR owner_membership_id = $1
               ORDER BY created_at DESC LIMIT $2`,
              [member.id, limit],
            )
          : await tx.client.query(
              `SELECT * FROM ${table}
               WHERE owner_membership_id = $1
               ORDER BY created_at DESC LIMIT $2`,
              [member.id, limit],
            );
    const sessions: CodeSessionView[] = [];
    for (const raw of result.rows) {
      const row = sessionRowSchema.parse(raw);
      const isOwner = row.owner_membership_id === member.id;
      const openRequest = isOwner ? await loadOpenRequest(tx, row.id) : null;
      sessions.push(toSessionView(row, member.id, isOwner, openRequest, []));
    }
    return sessions;
  });
}

export async function advanceCodeSessionStage(
  storage: CodeSessionStorage,
  workspaceId: string,
  sessionId: string,
  patch: {
    stage: CodeSessionStage;
    addActiveMs?: number | undefined;
    fixAttempts?: number | undefined;
    reviewRounds?: number | undefined;
    summary?: string | null | undefined;
    planMarkdown?: string | null | undefined;
    planApproved?: boolean | undefined;
    pullRequestNumber?: number | null | undefined;
    pullRequestUrl?: string | null | undefined;
    usageLimitUntil?: Date | null | undefined;
    errorMessage?: string | null | undefined;
    agent?: CodingAgent | undefined;
    addBudgetMs?: number | undefined;
  },
): Promise<CodeSessionView> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const table = qualified(tx.schema, 'tf_code_sessions');
    const currentResult = await tx.client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [sessionId]);
    const current = sessionRowSchema.optional().parse(currentResult.rows[0]);
    if (!current) throw new CodeSessionError('code-session-not-found', 'Code session not found.');
    if (current.stage === 'stopped' && patch.stage === 'stopped') {
      const [openRequest, steps] = await Promise.all([loadOpenRequest(tx, current.id), loadSteps(tx, current.id)]);
      return toSessionView(current, current.owner_membership_id, true, openRequest, steps);
    }
    if (!canTransitionCodeSessionStage(current.stage, patch.stage)) {
      throw new CodeSessionError(
        'code-session-invalid-transition',
        `Cannot transition code session from ${current.stage} to ${patch.stage}.`,
      );
    }
    const updatedResult = await tx.client.query(
      `UPDATE ${table}
       SET stage = $2,
           active_ms = active_ms + $3,
           fix_attempts = COALESCE($4, fix_attempts),
           review_rounds = COALESCE($5, review_rounds),
           summary = COALESCE($6, summary),
           plan_markdown = COALESCE($7, plan_markdown),
           plan_approved_at = CASE WHEN $8 THEN COALESCE(plan_approved_at, clock_timestamp()) ELSE plan_approved_at END,
           pull_request_number = COALESCE($9, pull_request_number),
           pull_request_url = COALESCE($10, pull_request_url),
           usage_limit_until = $11,
           error_message = $12,
           agent = COALESCE($13, agent),
           budget_ms = budget_ms + $14,
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING *`,
      [
        sessionId,
        patch.stage,
        patch.addActiveMs ?? 0,
        patch.fixAttempts ?? null,
        patch.reviewRounds ?? null,
        patch.summary ?? null,
        patch.planMarkdown ?? null,
        patch.planApproved ?? false,
        patch.pullRequestNumber ?? null,
        patch.pullRequestUrl ?? null,
        patch.usageLimitUntil ?? null,
        patch.errorMessage ?? null,
        patch.agent ?? null,
        patch.addBudgetMs ?? 0,
      ],
    );
    const updated = sessionRowSchema.parse(updatedResult.rows[0]);
    const [openRequest, steps] = await Promise.all([loadOpenRequest(tx, updated.id), loadSteps(tx, updated.id)]);
    return toSessionView(updated, updated.owner_membership_id, true, openRequest, steps);
  });
}

export async function recordCodeSessionStep(
  storage: CodeSessionStorage,
  workspaceId: string,
  input: {
    sessionId: string;
    stage: CodeSessionStage;
    agent: CodingAgent;
    model?: string | null;
    outcome: 'questions' | 'plan' | 'done' | 'blocked' | 'limit' | 'failed';
    finalMessage?: string | null;
    changedFiles?: string[];
    diffSummary?: string | null;
    checks?: CodeSessionCheck[];
    screenshots?: string[];
    activeMs: number;
  },
): Promise<CodeSessionStepView> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const table = qualified(tx.schema, 'tf_code_session_steps');
    const result = await tx.client.query(
      `INSERT INTO ${table} (
         id, session_id, stage, agent, model, outcome, final_message,
         changed_files, diff_summary, checks, screenshots, active_ms
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
       RETURNING *`,
      [
        randomUUID(),
        input.sessionId,
        input.stage,
        input.agent,
        input.model ?? null,
        input.outcome,
        input.finalMessage ?? null,
        input.changedFiles ?? [],
        input.diffSummary ?? null,
        JSON.stringify(input.checks ?? []),
        JSON.stringify(input.screenshots ?? []),
        Math.max(0, Math.round(input.activeMs)),
      ],
    );
    return toStepView(stepRowSchema.parse(result.rows[0]));
  });
}

export async function openCodeSessionRequest(
  storage: CodeSessionStorage,
  workspaceId: string,
  sessionId: string,
  payload: CodeSessionRequestPayload,
): Promise<CodeSessionRequestView> {
  const validPayload = codeSessionRequestPayloadSchema.parse(payload);
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const sessionsTable = qualified(tx.schema, 'tf_code_sessions');
    const sessionRes = await tx.client.query(`SELECT * FROM ${sessionsTable} WHERE id = $1 FOR UPDATE`, [sessionId]);
    const session = sessionRowSchema.optional().parse(sessionRes.rows[0]);
    if (!session) throw new CodeSessionError('code-session-not-found', 'Code session not found.');
    if (session.stage === 'stopped' || session.stage === 'merged' || session.stage === 'failed') {
      throw new CodeSessionError(
        'code-session-invalid-transition',
        `Cannot open request while session is ${session.stage}.`,
      );
    }

    const requestsTable = qualified(tx.schema, 'tf_code_session_requests');
    const digest = hashDigest({ sessionId, kind: validPayload.kind, payload: validPayload });
    const existingRes = await tx.client.query(
      `SELECT * FROM ${requestsTable}
       WHERE session_id = $1 AND decision_digest = $2 AND answered_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId, digest],
    );
    const existing = requestRowSchema.optional().parse(existingRes.rows[0]);
    if (existing) return toRequestView(existing);

    const id = randomUUID();
    const reqRes = await tx.client.query(
      `INSERT INTO ${requestsTable} (id, session_id, kind, payload, decision_digest)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [id, sessionId, validPayload.kind, JSON.stringify(validPayload), digest],
    );

    if (session.table_id && session.row_id) {
      const inboxTable = qualified(tx.schema, 'tf_inbox_items');
      const summary =
        validPayload.kind === 'question'
          ? validPayload.question.slice(0, 480)
          : validPayload.kind === 'plan-approval'
            ? `Approve plan: ${validPayload.planTitle}`.slice(0, 480)
            : validPayload.kind === 'merge-approval'
              ? `Ready to merge PR #${validPayload.pullRequestNumber}`
              : validPayload.kind === 'pr-approval'
                ? `Open pull request for ${session.session_branch}?`
                : validPayload.kind === 'budget'
                  ? `Active-time budget reached (${validPayload.activeMinutes} min)`
                  : `Session paused: ${validPayload.summary}`.slice(0, 480);
      await tx.client.query(
        `INSERT INTO ${inboxTable} (id, membership_id, kind, table_id, row_id, source_id, summary)
         VALUES ($1, $2, 'waiting', $3, $4, $5, $6)
         ON CONFLICT (membership_id, kind, source_id) DO NOTHING`,
        [randomUUID(), session.owner_membership_id, session.table_id, session.row_id, id, summary],
      );
    }
    await appendCodeSessionTerminalChunkInTx(tx, {
      sessionId,
      stage: session.stage,
      stream: 'prompt',
      chunk: formatRequestForTerminal(validPayload),
    });
    return toRequestView(requestRowSchema.parse(reqRes.rows[0]));
  });
}

export async function answerCodeSessionRequest(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  input: {
    sessionId: string;
    requestId: string;
    decisionDigest?: string;
    answer: CodeSessionRequestAnswer;
  },
): Promise<{ session: CodeSessionView; request: CodeSessionRequestView }> {
  const validAnswer = codeSessionRequestAnswerSchema.parse(input.answer);
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    const sessionsTable = qualified(tx.schema, 'tf_code_sessions');
    const sessionRes = await tx.client.query(`SELECT * FROM ${sessionsTable} WHERE id = $1 FOR UPDATE`, [
      input.sessionId,
    ]);
    const session = sessionRowSchema.optional().parse(sessionRes.rows[0]);
    if (!session) throw new CodeSessionError('code-session-not-found', 'Code session not found.');
    if (session.owner_membership_id !== member.id) {
      throw new CodeSessionError('code-session-not-owner', 'Only the session owner can answer this request.');
    }

    const requestsTable = qualified(tx.schema, 'tf_code_session_requests');
    const reqRes = await tx.client.query(
      `SELECT * FROM ${requestsTable} WHERE id = $1 AND session_id = $2 FOR UPDATE`,
      [input.requestId, input.sessionId],
    );
    const reqRow = requestRowSchema.optional().parse(reqRes.rows[0]);
    if (!reqRow) throw new CodeSessionError('code-session-request-not-found', 'Request not found.');
    if (reqRow.answered_at) {
      if (isDeepStrictEqual(reqRow.answer, validAnswer)) {
        const steps = await loadSteps(tx, session.id);
        return {
          session: toSessionView(session, member.id, true, null, steps),
          request: toRequestView(reqRow),
        };
      }
      throw new CodeSessionError('code-session-request-already-answered', 'This request was already answered.');
    }
    if (validAnswer.kind !== reqRow.kind) {
      throw new CodeSessionError(
        'code-session-invalid-answer',
        `Expected a ${reqRow.kind} answer, received ${validAnswer.kind}.`,
      );
    }
    if (input.decisionDigest && input.decisionDigest !== reqRow.decision_digest) {
      throw new CodeSessionError('code-session-digest-mismatch', 'The request changed before your answer arrived.');
    }

    const updatedReqRes = await tx.client.query(
      `UPDATE ${requestsTable}
       SET answer = $2::jsonb, answered_by = $3, answered_at = clock_timestamp()
       WHERE id = $1
       RETURNING *`,
      [input.requestId, JSON.stringify(validAnswer), member.id],
    );

    const inboxTable = qualified(tx.schema, 'tf_inbox_items');
    await tx.client.query(
      `UPDATE ${inboxTable} SET resolved_at = clock_timestamp() WHERE source_id = $1 AND resolved_at IS NULL`,
      [input.requestId],
    );

    await appendCodeSessionTerminalChunkInTx(tx, {
      sessionId: session.id,
      stage: session.stage,
      stream: 'answer',
      chunk: formatAnswerForTerminal(validAnswer),
    });

    const steps = await loadSteps(tx, session.id);
    const requestView = toRequestView(requestRowSchema.parse(updatedReqRes.rows[0]));
    return {
      session: toSessionView(session, member.id, true, null, steps),
      request: requestView,
    };
  });
}

export async function stopCodeSession(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  sessionId: string,
): Promise<CodeSessionView> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    const sessionsTable = qualified(tx.schema, 'tf_code_sessions');
    const sessionRes = await tx.client.query(`SELECT * FROM ${sessionsTable} WHERE id = $1 FOR UPDATE`, [sessionId]);
    const session = sessionRowSchema.optional().parse(sessionRes.rows[0]);
    if (!session) throw new CodeSessionError('code-session-not-found', 'Code session not found.');
    if (session.owner_membership_id !== member.id) {
      throw new CodeSessionError('code-session-not-owner', 'Only the session owner can stop this session.');
    }
    if (session.stage === 'merged' || session.stage === 'stopped') {
      const steps = await loadSteps(tx, session.id);
      return toSessionView(session, member.id, true, null, steps);
    }
    const updatedRes = await tx.client.query(
      `UPDATE ${sessionsTable} SET stage = 'stopped', updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
      [sessionId],
    );
    const requestsTable = qualified(tx.schema, 'tf_code_session_requests');
    const inboxTable = qualified(tx.schema, 'tf_inbox_items');
    await tx.client.query(
      `UPDATE ${inboxTable} SET resolved_at = clock_timestamp()
       WHERE source_id IN (SELECT id FROM ${requestsTable} WHERE session_id = $1)
         AND resolved_at IS NULL`,
      [sessionId],
    );
    const updated = sessionRowSchema.parse(updatedRes.rows[0]);
    await appendCodeSessionTerminalChunkInTx(tx, {
      sessionId: updated.id,
      stage: 'stopped',
      stream: 'system',
      chunk: 'Session stopped by member.',
    });
    const steps = await loadSteps(tx, updated.id);
    return toSessionView(updated, member.id, true, null, steps);
  });
}

export async function listOpenCodeSessionRequestsForMember(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
): Promise<Array<{ session: CodeSessionView; request: CodeSessionRequestView }>> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    const sessionsTable = qualified(tx.schema, 'tf_code_sessions');
    const requestsTable = qualified(tx.schema, 'tf_code_session_requests');
    const result = await tx.client.query(
      `SELECT r.*, s.id AS s_id
       FROM ${requestsTable} r
       JOIN ${sessionsTable} s ON s.id = r.session_id
       WHERE s.owner_membership_id = $1 AND r.answered_at IS NULL
         AND s.stage NOT IN ('merged', 'stopped', 'failed')
       ORDER BY r.created_at DESC`,
      [member.id],
    );
    const out: Array<{ session: CodeSessionView; request: CodeSessionRequestView }> = [];
    for (const raw of result.rows) {
      const reqRow = requestRowSchema.parse(raw);
      const sessRes = await tx.client.query(`SELECT * FROM ${sessionsTable} WHERE id = $1`, [reqRow.session_id]);
      const sessRow = sessionRowSchema.parse(sessRes.rows[0]);
      const reqView = toRequestView(reqRow);
      out.push({
        session: toSessionView(sessRow, member.id, true, reqView, []),
        request: reqView,
      });
    }
    return out;
  });
}

export async function readConversationCodeSummaries(
  storage: CodeSessionStorage,
  workspaceId: string,
  conversationId: string,
): Promise<string> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const sessionsTable = qualified(tx.schema, 'tf_code_sessions');
    const result = await tx.client.query(
      `SELECT * FROM ${sessionsTable} WHERE origin_conversation_id = $1 ORDER BY created_at ASC LIMIT 10`,
      [conversationId],
    );
    if (result.rows.length === 0) return '';
    const lines: string[] = ['Code sessions started in this chat:'];
    for (const raw of result.rows) {
      const row = sessionRowSchema.parse(raw);
      const pr = row.pull_request_url ? `, PR: ${row.pull_request_url}` : '';
      const summary = row.summary ? ` — ${row.summary}` : '';
      lines.push(
        `- ${row.title} (${row.agent} on ${row.repository}@${row.session_branch}, stage: ${row.stage}${pr})${summary}`,
      );
    }
    return lines.join('\n');
  });
}

const terminalChunkRowSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(value => Number(value)),
  session_id: uuidSchema,
  stage: codeSessionStageSchema,
  stream: codeTerminalStreamKindSchema,
  chunk: z.string(),
  created_at: z.date(),
});

function toTerminalChunk(row: z.infer<typeof terminalChunkRowSchema>): CodeTerminalChunk {
  return {
    id: row.id,
    sessionId: row.session_id,
    stage: row.stage,
    stream: row.stream,
    chunk: row.chunk,
    createdAt: row.created_at.toISOString(),
  };
}

function formatRequestForTerminal(payload: CodeSessionRequestPayload): string {
  switch (payload.kind) {
    case 'question': {
      const header = `❓ Question (${payload.questionIndex}/${payload.totalQuestions}): ${payload.question}`;
      const options = payload.options.map(option => {
        const tag = option.recommended ? ' (Recommended)' : '';
        return `  ${option.number}. ${option.label}${tag}`;
      });
      return [header, ...options].join('\n');
    }
    case 'plan-approval':
      return `📋 Plan ready for approval: ${payload.planTitle}\n   Branch: ${payload.baseBranch} → ${payload.sessionBranch}`;
    case 'pr-approval':
      return `🔀 Ready to open pull request for ${payload.repository} (${payload.baseBranch} ← ${payload.sessionBranch})`;
    case 'merge-approval':
      return `✅ PR #${payload.pullRequestNumber} ready for merge approval (${payload.pullRequestUrl})`;
    case 'budget':
      return `⏱ Active-time budget reached (${payload.activeMinutes}/${payload.budgetMinutes} min).`;
    case 'stuck':
      return `⚠ Session paused (${payload.reason}): ${payload.summary}`;
  }
}

function formatAnswerForTerminal(answer: CodeSessionRequestAnswer): string {
  switch (answer.kind) {
    case 'question':
      return `❯ ${answer.optionNumber ? `[${answer.optionNumber}] ` : ''}${answer.text}`;
    case 'plan-approval':
      return `❯ Plan decision: ${answer.decision}${answer.feedback ? ` — ${answer.feedback}` : ''}`;
    case 'pr-approval':
      return `❯ Pull request decision: ${answer.decision}${answer.draft ? ' (draft)' : ''}`;
    case 'merge-approval':
      return `❯ Merge decision: ${answer.decision}${answer.feedback ? ` — ${answer.feedback}` : ''}`;
    case 'budget':
      return `❯ Budget decision: ${answer.decision}${answer.addMinutes ? ` (+${answer.addMinutes} min)` : ''}`;
    case 'stuck':
      return `❯ Recovery decision: ${answer.decision}${answer.agent ? ` (${answer.agent})` : ''}${answer.guidance ? ` — ${answer.guidance}` : ''}`;
  }
}

export async function appendCodeSessionTerminalChunkInTx(
  tx: CodeSessionTransaction,
  input: {
    sessionId: string;
    stage: CodeSessionStage;
    stream: CodeTerminalStreamKind;
    chunk: string;
  },
): Promise<CodeTerminalChunk> {
  const maxChunkLength = 16_000;
  const boundedChunk =
    input.chunk.length <= maxChunkLength
      ? input.chunk
      : `[truncated]\n${input.chunk.slice(input.chunk.length - (maxChunkLength - 12))}`;
  const table = qualified(tx.schema, 'tf_code_session_terminal_chunks');
  const result = await tx.client.query(
    `INSERT INTO ${table} (session_id, stage, stream, chunk)
     VALUES ($1, $2, $3, $4)
     RETURNING id, session_id, stage, stream, chunk, created_at`,
    [input.sessionId, input.stage, input.stream, boundedChunk],
  );
  return toTerminalChunk(terminalChunkRowSchema.parse(result.rows[0]));
}

export async function appendCodeSessionTerminalChunk(
  storage: CodeSessionStorage,
  workspaceId: string,
  input: {
    sessionId: string;
    stage: CodeSessionStage;
    stream: CodeTerminalStreamKind;
    chunk: string;
  },
): Promise<CodeTerminalChunk> {
  return storage.transaction(workspaceId, codeSessionCompatibility, tx =>
    appendCodeSessionTerminalChunkInTx(tx, input),
  );
}

export async function listCodeSessionTerminalChunks(
  storage: CodeSessionStorage,
  workspaceId: string,
  actor: HumanActor,
  sessionId: string,
  options?: { afterId?: number; limit?: number; canReadRepo?: (repository: string) => Promise<boolean> },
): Promise<CodeTerminalChunk[]> {
  const loaded = await storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const member = await resolveMember(tx, actor);
    const sessionsTable = qualified(tx.schema, 'tf_code_sessions');
    const found = await tx.client.query(
      `SELECT id, owner_membership_id, repository FROM ${sessionsTable} WHERE id = $1`,
      [sessionId],
    );
    const row = found.rows[0] as { id: string; owner_membership_id: string; repository: string } | undefined;
    if (!row) {
      throw new CodeSessionError('code-session-not-found', 'Code session not found.');
    }
    return { member, row };
  });
  const isOwner = loaded.row.owner_membership_id === loaded.member.id;
  const canRead = isOwner || (options?.canReadRepo ? await options.canReadRepo(loaded.row.repository) : false);
  if (!canRead) return [];

  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const afterId = Math.max(0, Math.floor(options?.afterId ?? 0));
    const limit = Math.min(Math.max(options?.limit ?? 500, 1), 1000);
    const table = qualified(tx.schema, 'tf_code_session_terminal_chunks');
    const result = await tx.client.query(
      `SELECT id, session_id, stage, stream, chunk, created_at
       FROM ${table}
       WHERE session_id = $1 AND id > $2
       ORDER BY id ASC
       LIMIT $3`,
      [sessionId, afterId, limit],
    );
    return result.rows.map(row => toTerminalChunk(terminalChunkRowSchema.parse(row)));
  });
}

export async function readCodeSessionRequestForWorker(
  storage: CodeSessionStorage,
  workspaceId: string,
  sessionId: string,
  requestId: string,
): Promise<{ stage: CodeSessionStage; request: CodeSessionRequestView | null }> {
  return storage.transaction(workspaceId, codeSessionCompatibility, async tx => {
    const sessionsTable = qualified(tx.schema, 'tf_code_sessions');
    const sessionRes = await tx.client.query(`SELECT stage FROM ${sessionsTable} WHERE id = $1`, [sessionId]);
    const stageRow = sessionRes.rows[0] as { stage: CodeSessionStage } | undefined;
    if (!stageRow) throw new CodeSessionError('code-session-not-found', 'Code session not found.');
    const requestsTable = qualified(tx.schema, 'tf_code_session_requests');
    const reqRes = await tx.client.query(`SELECT * FROM ${requestsTable} WHERE id = $1 AND session_id = $2`, [
      requestId,
      sessionId,
    ]);
    const reqRow = requestRowSchema.optional().parse(reqRes.rows[0]);
    return { stage: stageRow.stage, request: reqRow ? toRequestView(reqRow) : null };
  });
}
