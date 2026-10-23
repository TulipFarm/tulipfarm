import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Limits for sub-agents a chat reply starts with `agents.delegate` (specs/agents/PRODUCT.md #16, #55–58). */
export const subagentLimits = {
  /** Sub-agents one call may start, and sub-agents one reply may run at once. */
  children: 5,
  /** The chat is depth 0. Its sub-agents are depth 1, and saved agents they start may delegate down to this depth. */
  depth: 3,
  defaultSeconds: 180,
  minimumSeconds: 30,
  /** The reply activity has nine minutes, so a sub-agent's limit leaves room for the chat to answer. */
  maximumSeconds: 300,
  /** Tool calls one helper may make. */
  helperToolCalls: 16,
  /** Credits a saved-agent child may spend when the chat does not name a smaller budget. */
  savedAgentCredits: 25,
} as const;

/**
 * Read-only chat tools a temporary helper may be given. A helper never writes, drafts, or delegates, so the tools it
 * gets are the intersection of this list, the tools the chat asked for, and the tools the chat itself is offered.
 */
export const helperToolNames = [
  'web.search',
  'web.fetch',
  'google.read',
  'github.issue.read',
  'github.personal.read',
  'atlassian.read',
  'tables.list',
  'tables.definitions',
  'schema.inspect',
  'rows.get',
  'rows.list',
  'rows.summarize',
  'rows.page',
  'agents.list',
  'agents.read',
  'skills.list',
  'skills.read',
] as const;
export type HelperToolName = (typeof helperToolNames)[number];

const savedSubagentSchema = z.strictObject({
  kind: z.literal('saved'),
  agentId: z.uuid().describe('An activated saved agent from agents.list.'),
  activationId: z.uuid().optional(),
  role: z.string().trim().min(1).max(80).describe('A short role shown to the user, such as "Market researcher".'),
  task: z.string().trim().min(1).max(8000).describe('A self-contained task with every detail the agent needs.'),
  credits: z.number().int().min(1).max(100).optional().describe('Most credits this agent may spend.'),
});
const helperSubagentSchema = z.strictObject({
  kind: z.literal('helper'),
  name: z.string().trim().min(1).max(60).describe('A short name, such as "Pricing scout".'),
  role: z.string().trim().min(1).max(80).describe('A short role shown to the user, such as "Researcher".'),
  task: z.string().trim().min(1).max(8000).describe('A self-contained task with every detail the helper needs.'),
  instructions: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .describe('How the helper should work and what its report must contain.'),
  tools: z
    .array(z.enum(helperToolNames))
    .min(1)
    .max(helperToolNames.length)
    .describe('Only the read-only tools this helper needs.'),
});
export const subagentSpecSchema = z.discriminatedUnion('kind', [savedSubagentSchema, helperSubagentSchema]);
export type SubagentSpec = z.infer<typeof subagentSpecSchema>;

export const delegateCallSchema = z.strictObject({
  tool: z.literal('agents.delegate'),
  agents: z.array(subagentSpecSchema).min(1).max(subagentLimits.children),
  timeLimitSeconds: z
    .number()
    .int()
    .min(subagentLimits.minimumSeconds)
    .max(subagentLimits.maximumSeconds)
    .optional()
    .describe('Per-agent time limit. Agents still running then stop and return partial output.'),
});
export type DelegateCall = z.infer<typeof delegateCallSchema>;

/** `timed-out` and `stopped` sub-agents return partial output as their report. */
export const subagentOutcomeSchema = z.enum(['done', 'failed', 'timed-out', 'stopped']);
export type SubagentOutcome = z.infer<typeof subagentOutcomeSchema>;

/**
 * The idempotency key of the task a saved-agent sub-agent starts: derived from the `agents.delegate` call and the
 * sub-agent's position, so a retried call reuses the same task.
 */
export function delegatedRequestId(callId: string, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= subagentLimits.children) throw new RangeError('subagent-index');
  const hex = createHash('sha256').update(`agents.delegate:${callId}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
