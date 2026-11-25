import { z } from 'zod';
import { codingAgents, type CodingAgent } from './coding-run-contracts.ts';

export const turnModes = ['normal', 'plan', 'code'] as const;
export type TurnMode = (typeof turnModes)[number];
export const turnModeSchema = z.enum(turnModes);

export const codeSessionStages = [
  'brainstorm',
  'plan',
  'awaiting-plan-approval',
  'code',
  'verify',
  'pull-request',
  'review',
  'awaiting-merge-approval',
  'merging',
  'merged',
  'stopped',
  'failed',
] as const;
export type CodeSessionStage = (typeof codeSessionStages)[number];
export const codeSessionStageSchema = z.enum(codeSessionStages);

export const codeSessionTerminalStages = new Set<CodeSessionStage>(['merged', 'stopped', 'failed']);

export const codeSessionTransitions: Readonly<Record<CodeSessionStage, readonly CodeSessionStage[]>> = Object.freeze({
  brainstorm: ['brainstorm', 'plan', 'stopped', 'failed'],
  plan: ['plan', 'awaiting-plan-approval', 'brainstorm', 'stopped', 'failed'],
  'awaiting-plan-approval': ['code', 'plan', 'brainstorm', 'stopped', 'failed'],
  code: ['code', 'verify', 'stopped', 'failed'],
  verify: ['verify', 'code', 'pull-request', 'stopped', 'failed'],
  'pull-request': ['pull-request', 'review', 'awaiting-merge-approval', 'stopped', 'failed'],
  review: ['review', 'code', 'awaiting-merge-approval', 'stopped', 'failed'],
  'awaiting-merge-approval': ['awaiting-merge-approval', 'merging', 'code', 'stopped', 'failed'],
  merging: ['merging', 'merged', 'code', 'verify', 'awaiting-merge-approval', 'stopped', 'failed'],
  merged: [],
  stopped: [],
  failed: ['brainstorm', 'plan', 'code', 'stopped'],
});

export function canTransitionCodeSessionStage(from: CodeSessionStage, to: CodeSessionStage): boolean {
  return codeSessionTransitions[from].includes(to);
}

export const codeSessionStageRunState: Readonly<
  Record<CodeSessionStage, 'queued' | 'working' | 'waiting' | 'done' | 'failed'>
> = Object.freeze({
  brainstorm: 'working',
  plan: 'working',
  'awaiting-plan-approval': 'waiting',
  code: 'working',
  verify: 'working',
  'pull-request': 'working',
  review: 'working',
  'awaiting-merge-approval': 'waiting',
  merging: 'working',
  merged: 'done',
  stopped: 'done',
  failed: 'failed',
});

export const codeSessionStageLabels: Readonly<Record<CodeSessionStage, string>> = Object.freeze({
  brainstorm: 'Brainstorming',
  plan: 'Planning',
  'awaiting-plan-approval': 'Awaiting plan approval',
  code: 'Coding',
  verify: 'Verifying',
  'pull-request': 'Opening pull request',
  review: 'In review',
  'awaiting-merge-approval': 'Ready to merge',
  merging: 'Merging',
  merged: 'Merged',
  stopped: 'Stopped',
  failed: 'Failed',
});

export const DEFAULT_CODE_SESSION_BUDGET_MINUTES = 240;
export const MAX_CODE_SESSION_FIX_ATTEMPTS = 3;
export const MAX_CODE_SESSION_REVIEW_ROUNDS = 3;
export const DEFAULT_BRANCH_PREFIX = 'tulipfarm';
export const CODE_SESSION_COMMIT_TRAILER = 'Co-Authored-By: TulipFarm <code@tulipfarm.ai>';

export const sessionReviewerSchema = z.strictObject({
  agent: z.enum(codingAgents),
  model: z.string().trim().min(1).max(120).optional(),
});
export type SessionReviewer = z.infer<typeof sessionReviewerSchema>;

export const branchPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/,
    'Use letters, numbers, dots, hyphens, underscores, or slashes',
  )
  .refine(value => !value.includes('..') && !value.includes('//'), 'Branch prefix cannot contain .. or //');

export const repositorySlugSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use owner/repo format');

export const gitBranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(value => !value.includes('..') && !/\s/.test(value), 'Invalid branch name');

export const memberCodeSettingsSchema = z.strictObject({
  branchPrefix: branchPrefixSchema,
  openPullRequests: z.boolean(),
  openAsDraft: z.boolean(),
  reviewers: z.array(sessionReviewerSchema).max(5),
});
export type MemberCodeSettings = z.infer<typeof memberCodeSettingsSchema>;

export const defaultMemberCodeSettings: MemberCodeSettings = Object.freeze({
  branchPrefix: DEFAULT_BRANCH_PREFIX,
  openPullRequests: false,
  openAsDraft: true,
  reviewers: [],
});

export const codeSessionStartInputSchema = z.strictObject({
  agent: z.enum(codingAgents),
  repository: repositorySlugSchema,
  baseBranch: gitBranchNameSchema,
  githubAccount: z.string().trim().min(1).max(120).optional(),
  reviewers: z.array(sessionReviewerSchema).max(5).optional(),
  budgetMinutes: z.number().int().min(15).max(1440).optional(),
});
export type CodeSessionStartInput = z.infer<typeof codeSessionStartInputSchema>;

export const codeSessionCheckSchema = z.strictObject({
  name: z.string().min(1).max(200),
  status: z.enum(['passed', 'failed', 'pending', 'skipped']),
  details: z.string().max(2000).optional(),
  url: z.string().url().optional(),
});
export type CodeSessionCheck = z.infer<typeof codeSessionCheckSchema>;

export const codeSessionReviewVerdictSchema = z.strictObject({
  reviewerAgent: z.enum(codingAgents),
  reviewerModel: z.string().optional(),
  verdict: z.enum(['approved', 'changes-requested']),
  summary: z.string().max(4000),
  commentUrl: z.string().url().optional(),
});
export type CodeSessionReviewVerdict = z.infer<typeof codeSessionReviewVerdictSchema>;

export const questionOptionSchema = z.strictObject({
  number: z.number().int().min(1).max(10),
  label: z.string().trim().min(1).max(300),
  recommended: z.boolean().optional(),
});

export const codeSessionRequestPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('question'),
    question: z.string().min(1).max(2000),
    questionIndex: z.number().int().min(1),
    totalQuestions: z.number().int().min(1),
    options: z.array(questionOptionSchema).min(1).max(6),
    allowFreeText: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal('plan-approval'),
    planTitle: z.string().min(1).max(240),
    planSummary: z.string().min(1).max(4000),
    planMarkdown: z.string().min(1).max(60000),
    repository: z.string(),
    baseBranch: z.string(),
    sessionBranch: z.string(),
    agent: z.enum(codingAgents),
    reviewers: z.array(sessionReviewerSchema),
    budgetMinutes: z.number().int().positive(),
    planOwnerLabel: z.string().min(1).max(200),
    pushAccessError: z.string().max(500).optional(),
  }),
  z.strictObject({
    kind: z.literal('pr-approval'),
    repository: z.string(),
    baseBranch: z.string(),
    sessionBranch: z.string(),
    draft: z.boolean(),
    summary: z.string().max(4000),
  }),
  z.strictObject({
    kind: z.literal('merge-approval'),
    pullRequestNumber: z.number().int().positive(),
    pullRequestUrl: z.string().url(),
    diffSummary: z.string().max(8000),
    checks: z.array(codeSessionCheckSchema),
    screenshots: z.array(z.string().max(500)),
    reviews: z.array(codeSessionReviewVerdictSchema),
  }),
  z.strictObject({
    kind: z.literal('stuck'),
    reason: z.enum(['verify-failed', 'review-rounds', 'agent-blocked']),
    summary: z.string().max(4000),
  }),
  z.strictObject({
    kind: z.literal('budget'),
    activeMinutes: z.number().int().nonnegative(),
    budgetMinutes: z.number().int().positive(),
  }),
]);
export type CodeSessionRequestPayload = z.infer<typeof codeSessionRequestPayloadSchema>;
export type CodeSessionRequestKind = CodeSessionRequestPayload['kind'];

export const codeSessionRequestAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('question'),
    optionNumber: z.number().int().min(1).max(10).optional(),
    text: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    kind: z.literal('plan-approval'),
    decision: z.enum(['approve', 'revise', 'stop']),
    feedback: z.string().trim().max(4000).optional(),
  }),
  z.strictObject({
    kind: z.literal('pr-approval'),
    decision: z.enum(['open-pr', 'keep-branch', 'stop']),
    draft: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('merge-approval'),
    decision: z.enum(['merge', 'request-changes', 'stop']),
    feedback: z.string().trim().max(4000).optional(),
  }),
  z.strictObject({
    kind: z.literal('stuck'),
    decision: z.enum(['retry', 'switch-agent', 'stop']),
    guidance: z.string().trim().max(4000).optional(),
    agent: z.enum(codingAgents).optional(),
  }),
  z.strictObject({
    kind: z.literal('budget'),
    decision: z.enum(['raise-budget', 'stop']),
    addMinutes: z.number().int().min(15).max(720).optional(),
  }),
]);
export type CodeSessionRequestAnswer = z.infer<typeof codeSessionRequestAnswerSchema>;

export const codeSessionRequestViewSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid(),
  kind: z.enum(['question', 'plan-approval', 'pr-approval', 'merge-approval', 'stuck', 'budget']),
  payload: codeSessionRequestPayloadSchema,
  decisionDigest: z.string(),
  answer: codeSessionRequestAnswerSchema.nullable(),
  answeredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CodeSessionRequestView = z.infer<typeof codeSessionRequestViewSchema>;

export const codeTerminalStreamKinds = ['stdout', 'stderr', 'system', 'prompt', 'answer'] as const;
export type CodeTerminalStreamKind = (typeof codeTerminalStreamKinds)[number];
export const codeTerminalStreamKindSchema = z.enum(codeTerminalStreamKinds);

export const codeTerminalChunkSchema = z.strictObject({
  id: z.number().int().positive(),
  sessionId: z.uuid(),
  stage: codeSessionStageSchema,
  stream: codeTerminalStreamKindSchema,
  chunk: z.string(),
  createdAt: z.string(),
});
export type CodeTerminalChunk = z.infer<typeof codeTerminalChunkSchema>;

export const codeSessionStepViewSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid(),
  stage: codeSessionStageSchema,
  agent: z.enum(codingAgents),
  model: z.string().nullable(),
  outcome: z.enum(['questions', 'plan', 'done', 'blocked', 'limit', 'failed']),
  finalMessage: z.string().nullable(),
  changedFiles: z.array(z.string()),
  diffSummary: z.string().nullable(),
  checks: z.array(codeSessionCheckSchema),
  screenshots: z.array(z.string()),
  activeMs: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type CodeSessionStepView = z.infer<typeof codeSessionStepViewSchema>;

export const codeSessionViewSchema = z.strictObject({
  id: z.uuid(),
  tableId: z.uuid().nullable(),
  rowId: z.uuid().nullable(),
  ownerMembershipId: z.uuid(),
  isOwner: z.boolean(),
  canReadDetails: z.boolean(),
  originConversationId: z.uuid().nullable(),
  title: z.string(),
  request: z.string().nullable(),
  agent: z.enum(codingAgents),
  repository: z.string(),
  baseBranch: z.string(),
  sessionBranch: z.string(),
  githubAccount: z.string().nullable(),
  pullRequestNumber: z.number().int().nullable(),
  pullRequestUrl: z.string().nullable(),
  stage: codeSessionStageSchema,
  stageLabel: z.string(),
  runState: z.enum(['queued', 'working', 'waiting', 'done', 'failed']),
  reviewers: z.array(sessionReviewerSchema),
  openPullRequests: z.boolean(),
  openAsDraft: z.boolean(),
  budgetMs: z.number().int().positive(),
  activeMs: z.number().int().nonnegative(),
  fixAttempts: z.number().int().nonnegative(),
  reviewRounds: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  planMarkdown: z.string().nullable(),
  planApprovedAt: z.string().nullable(),
  usageLimitUntil: z.string().nullable(),
  errorMessage: z.string().nullable(),
  openRequest: codeSessionRequestViewSchema.nullable(),
  steps: z.array(codeSessionStepViewSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CodeSessionView = z.infer<typeof codeSessionViewSchema>;

export const codeModeAvailabilitySchema = z.strictObject({
  enabled: z.boolean(),
  spawnboxReady: z.boolean(),
  unavailableReason: z.string().nullable(),
  agents: z.array(
    z.strictObject({
      agent: z.enum(codingAgents),
      label: z.string(),
      available: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  githubConnected: z.boolean(),
  githubAccounts: z.array(
    z.strictObject({
      id: z.uuid(),
      login: z.string(),
    }),
  ),
  settings: memberCodeSettingsSchema,
});
export type CodeModeAvailability = z.infer<typeof codeModeAvailabilitySchema>;

export const codeSessionStageOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('questions'),
    questions: z
      .array(
        z.strictObject({
          question: z.string().min(1).max(2000),
          options: z.array(questionOptionSchema).min(1).max(6),
        }),
      )
      .min(1)
      .max(8),
  }),
  z.strictObject({
    kind: z.literal('plan'),
    title: z.string().min(1).max(240),
    summary: z.string().min(1).max(4000),
    markdown: z.string().min(1).max(60000),
  }),
  z.strictObject({
    kind: z.literal('done'),
    summary: z.string().min(1).max(8000),
    changedFiles: z.array(z.string()).default([]),
    diffSummary: z.string().max(8000).optional(),
    checks: z.array(codeSessionCheckSchema).default([]),
    screenshots: z.array(z.string()).default([]),
    reviewVerdict: z.enum(['approved', 'changes-requested']).optional(),
  }),
  z.strictObject({
    kind: z.literal('blocked'),
    reason: z.string().min(1).max(4000),
  }),
  z.strictObject({
    kind: z.literal('limit'),
    resetAt: z.string().optional(),
    reason: z.string().min(1).max(1000),
  }),
]);
export type CodeSessionStageOutcome = z.infer<typeof codeSessionStageOutcomeSchema>;

const STAGE_MARKER_PREFIX = 'TULIPFARM_CODE_STAGE ';

export function parseCodeStageMarker(output: string): CodeSessionStageOutcome | null {
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]?.trim() ?? '';
    if (!trimmed.startsWith(STAGE_MARKER_PREFIX)) continue;
    const raw = trimmed.slice(STAGE_MARKER_PREFIX.length).trim();
    try {
      const parsed = codeSessionStageOutcomeSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Ignore malformed marker lines and continue scanning earlier lines.
    }
  }
  return null;
}

export function buildSessionBranchName(prefix: string, title: string, sessionId: string): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '') || DEFAULT_BRANCH_PREFIX;
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 42) || 'session';
  const shortId = sessionId.replace(/-/g, '').slice(0, 8);
  return `${cleanPrefix}/${slug}-${shortId}`;
}

export function deriveSessionTitle(request: string): string {
  const firstLine = request.trim().split(/\r?\n/)[0] ?? '';
  const compact = firstLine.replace(/\s+/g, ' ').trim();
  if (compact.length <= 80) return compact || 'Code session';
  return `${compact.slice(0, 77).trimEnd()}...`;
}

export type CodingAgentId = CodingAgent;
