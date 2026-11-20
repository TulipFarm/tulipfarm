import { z } from 'zod';

/** Limits from the evals specification, shared by the API, the worker and the web app. */
export const evalLimits = {
  casesPerSet: 100,
  checksPerCase: 10,
  priorTurns: 20,
  pinsPerCase: 20,
  repliesPerRun: 300,
  runsKept: 50,
  modelsCompared: 3,
  repeats: [1, 3] as const,
} as const;

export const completionStatuses = ['completed', 'waiting', 'blocked', 'refused'] as const;
export type CompletionStatus = (typeof completionStatuses)[number];

const toolNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,99}$/);
const jsonRecordSchema = z.record(z.string().min(1).max(100), z.json());

export const evalCheckSchema = z.discriminatedUnion('kind', [
  /** The tool was called; with `args`, at least one call's arguments contain these values. */
  z.strictObject({ kind: z.literal('tool-called'), tool: toolNameSchema, args: jsonRecordSchema.optional() }),
  z.strictObject({ kind: z.literal('tool-not-called'), tool: toolNameSchema }),
  z.strictObject({ kind: z.literal('approval-requested') }),
  z.strictObject({ kind: z.literal('status'), status: z.enum(completionStatuses) }),
  z.strictObject({ kind: z.literal('text-contains'), text: z.string().trim().min(1).max(500) }),
  z.strictObject({ kind: z.literal('text-excludes'), text: z.string().trim().min(1).max(500) }),
  z.strictObject({ kind: z.literal('judge'), rubric: z.string().trim().min(1).max(2000) }),
]);
export type EvalCheck = z.infer<typeof evalCheckSchema>;

export const evalTurnSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: z.string().trim().min(1).max(8000),
});
export type EvalTurn = z.infer<typeof evalTurnSchema>;

/** A fixed result for a tool, used instead of running it. `match` narrows it to calls whose arguments contain these values. */
export const toolResultPinSchema = z.strictObject({
  tool: toolNameSchema,
  match: jsonRecordSchema.optional(),
  result: z.json(),
});
export type ToolResultPin = z.infer<typeof toolResultPinSchema>;

export const evalCaseInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(8000),
  priorTurns: z.array(evalTurnSchema).max(evalLimits.priorTurns).default([]),
  checks: z.array(evalCheckSchema).min(1).max(evalLimits.checksPerCase),
  /** Results returned for read-only tools instead of live data. */
  pinnedReads: z.array(toolResultPinSchema).max(evalLimits.pinsPerCase).default([]),
  /** Results returned for simulated effects instead of the generic success. */
  effectOverrides: z.array(toolResultPinSchema).max(evalLimits.pinsPerCase).default([]),
});
export type EvalCaseInput = z.input<typeof evalCaseInputSchema>;

export const evalCaseSchema = evalCaseInputSchema.extend({ id: z.string().min(1).max(100) });
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const toolModes = ['live', 'pinned', 'simulated'] as const;
export type ToolMode = (typeof toolModes)[number];

export const recordedCallSchema = z.strictObject({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  mode: z.enum(toolModes),
  /** Set when the call is an approval request that the run treated as approved. */
  approval: z.literal(true).optional(),
  error: z.string().max(500).optional(),
});
export type RecordedCall = z.infer<typeof recordedCallSchema>;

export const usageSchema = z.strictObject({
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  picoUsd: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof usageSchema>;
export const emptyUsage = (): Usage => ({ requests: 0, inputTokens: 0, outputTokens: 0, picoUsd: 0 });
export function addUsage(into: Usage, more: Usage) {
  into.requests += more.requests;
  into.inputTokens += more.inputTokens;
  into.outputTokens += more.outputTokens;
  into.picoUsd += more.picoUsd;
  return into;
}

/** What one agent reply did, which the checks grade. */
export const transcriptSchema = z.strictObject({
  text: z.string(),
  status: z.enum(completionStatuses),
  calls: z.array(recordedCallSchema),
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const checkVerdictSchema = z.strictObject({
  check: evalCheckSchema,
  pass: z.boolean(),
  reason: z.string().max(1000),
});
export type CheckVerdict = z.infer<typeof checkVerdictSchema>;

export const caseResultSchema = z.strictObject({
  caseId: z.string(),
  model: z.string(),
  repeat: z.number().int().nonnegative(),
  pass: z.boolean(),
  verdicts: z.array(checkVerdictSchema),
  transcript: transcriptSchema.nullable(),
  error: z.string().max(1000).nullable(),
  agentUsage: usageSchema,
  judgeUsage: usageSchema,
  durationMs: z.number().int().nonnegative(),
});
export type CaseResult = z.infer<typeof caseResultSchema>;

/** Workspace Evals errors and their HTTP statuses. */
export const workspaceEvalErrorCodes = {
  'not-found': 404,
  'case-limit': 409,
  'run-active': 409,
  'run-finished': 409,
  'reply-limit': 422,
  'no-cases': 422,
  'model-unavailable': 422,
} as const;
export type WorkspaceEvalErrorCode = keyof typeof workspaceEvalErrorCodes;

export const runRequestSchema = z.strictObject({
  /** The cases to run; all of them when absent. */
  caseIds: z.array(z.uuid()).min(1).max(evalLimits.casesPerSet).optional(),
  repeats: z.union([z.literal(1), z.literal(3)]).default(1),
  /** Model families to compare; the agent's own model when absent. */
  models: z.array(z.string().min(1).max(200)).min(1).max(evalLimits.modelsCompared).optional(),
});
export type RunRequest = z.input<typeof runRequestSchema>;

export const evalRunStatuses = ['queued', 'running', 'completed', 'failed', 'stopped'] as const;
export const evalModelSummarySchema = z.strictObject({
  model: z.string(),
  passed: z.number().int(),
  total: z.number().int(),
  picoUsd: z.number().int(),
  durationMs: z.number().int(),
});

/** Response shapes, for the API's route schemas and the web client. */
export const workspaceEvalCaseSchema = evalCaseInputSchema.extend({
  id: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const workspaceEvalSetSchema = z.object({
  canEdit: z.boolean(),
  judgeModel: z.string().nullable(),
  defaultJudgeModel: z.string().nullable(),
  limits: z.object({
    casesPerSet: z.number().int(),
    checksPerCase: z.number().int(),
    priorTurns: z.number().int(),
    pinsPerCase: z.number().int(),
    repliesPerRun: z.number().int(),
    runsKept: z.number().int(),
    modelsCompared: z.number().int(),
    repeats: z.array(z.number().int()),
  }),
  cases: z.array(workspaceEvalCaseSchema),
});
export const workspaceEvalEstimateSchema = z.object({
  replies: z.number().int(),
  models: z.array(z.string()),
  judgeModel: z.string(),
  credits: z.number(),
});
export const workspaceEvalRunSchema = z.object({
  id: z.uuid(),
  startedBy: z.uuid(),
  status: z.enum(evalRunStatuses),
  stopReason: z.string().nullable(),
  models: z.array(z.string()),
  judgeModel: z.string(),
  repeats: z.number().int(),
  caseCount: z.number().int(),
  estimateCredits: z.number(),
  agentCredits: z.number(),
  judgeCredits: z.number(),
  summary: z.array(evalModelSummarySchema.extend({ credits: z.number() })),
  agentChanged: z.boolean(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export const workspaceEvalRunDetailSchema = workspaceEvalRunSchema.extend({
  results: z.array(caseResultSchema.extend({ caseName: z.string() })),
});
