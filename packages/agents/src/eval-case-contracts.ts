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
  /** Starter cases the chat may propose with one agent draft. */
  draftCases: 5,
} as const;

export const completionStatuses = ['completed', 'waiting', 'blocked', 'refused'] as const;
export type CompletionStatus = (typeof completionStatuses)[number];

const toolNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,99}$/);
const jsonRecordSchema = z.record(z.string().min(1).max(100), z.json());

const checkKinds = {
  toolNotCalled: z.strictObject({ kind: z.literal('tool-not-called'), tool: toolNameSchema }),
  approval: z.strictObject({ kind: z.literal('approval-requested') }),
  status: z.strictObject({ kind: z.literal('status'), status: z.enum(completionStatuses) }),
  contains: z.strictObject({ kind: z.literal('text-contains'), text: z.string().trim().min(1).max(500) }),
  excludes: z.strictObject({ kind: z.literal('text-excludes'), text: z.string().trim().min(1).max(500) }),
  judge: z.strictObject({ kind: z.literal('judge'), rubric: z.string().trim().min(1).max(2000) }),
};

export const evalCheckSchema = z.discriminatedUnion('kind', [
  /** The tool was called; with `args`, at least one call's arguments contain these values. */
  z.strictObject({ kind: z.literal('tool-called'), tool: toolNameSchema, args: jsonRecordSchema.optional() }),
  ...Object.values(checkKinds),
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

/**
 * A starter case the chat proposes with an agent draft: one message and its checks. It leaves out earlier turns, pins
 * and tool arguments so the tool schema stays small; an editor adds those in Evals.
 */
export const draftEvalCaseSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(8000),
  checks: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('tool-called'), tool: toolNameSchema }),
        ...Object.values(checkKinds),
      ]),
    )
    .min(1)
    .max(5),
});
export type DraftEvalCase = z.infer<typeof draftEvalCaseSchema>;
