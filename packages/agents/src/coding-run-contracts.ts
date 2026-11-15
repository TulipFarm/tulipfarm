import { z } from 'zod';

export const codingAgents = ['claude-code', 'codex', 'copilot'] as const;
export type CodingAgent = (typeof codingAgents)[number];
export const codingAgentLabels: Record<CodingAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
};

/** How long a run waits for its member's decision before it expires. */
export const CODING_RUN_APPROVAL_MS = 24 * 60 * 60 * 1000;

export const codingRunStatuses = [
  'awaiting-approval',
  'denied',
  'expired',
  'approved',
  'running',
  'finished',
  'interrupted',
] as const;
export type CodingRunStatus = (typeof codingRunStatuses)[number];

/** A run as its member reviews it. Nobody else can read it. */
export const codingRunViewSchema = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  agent: z.enum(codingAgents),
  repository: z.string(),
  branch: z.string().nullable(),
  task: z.string(),
  digest: z.string(),
  /** Whether the run uses the member's own plan rather than one shared with them. */
  ownPlan: z.boolean(),
  status: z.enum(codingRunStatuses),
  expiresAt: z.string(),
  /** How a finished run ended, such as `completed` or `timed-out`. */
  outcome: z.string().nullable(),
});
export type CodingRunView = z.infer<typeof codingRunViewSchema>;

export const codingRunDecisionSchema = z.strictObject({
  commandId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'deny']),
});
export type CodingRunDecision = z.infer<typeof codingRunDecisionSchema>;
