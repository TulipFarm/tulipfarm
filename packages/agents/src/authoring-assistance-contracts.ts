import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { agentDefinitionSchema } from './contracts.ts';
import { modelFamilyIdSchema } from './model-policy-contracts.ts';

export const agentAuthoringLimits = {
  agentName: 120,
  instructions: 32000,
  suggestion: 31999,
  messages: 20,
  message: 8000,
  transcript: 32000,
  skillCharacters: 32000,
  requestBytes: 262144,
  modelInputBytes: 196608,
  responseBytes: 262144,
  improvementTokens: 4096,
  previewTokens: 2048,
  timeoutMs: 45000,
  abandonedSeconds: 90,
  workspaceConcurrency: 1,
  workspaceStartsPerMinute: 10,
} as const;

const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .refine(value => value.length <= max)
    .refine(value => value.trim().length > 0, 'Text must not be blank');
export const agentAuthoringSourceSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  fingerprint: z.string().min(1).max(128),
});
export const improveAgentInstructionsSchema = z.strictObject({
  requestId: uuidSchema,
  source: agentAuthoringSourceSchema,
  agentName: z
    .string()
    .refine(value => value.length <= agentAuthoringLimits.agentName)
    .optional(),
  instructions: nonblank(agentAuthoringLimits.instructions),
});
export const agentPreviewMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: nonblank(agentAuthoringLimits.message),
});
export const previewAgentChatSchema = z
  .strictObject({
    requestId: uuidSchema,
    source: agentAuthoringSourceSchema,
    definition: agentDefinitionSchema.refine(
      definition => definition.instructions.trim().length > 0,
      'Instructions must not be blank',
    ),
    messages: z
      .array(agentPreviewMessageSchema)
      .min(1)
      .max(agentAuthoringLimits.messages)
      .refine(
        messages =>
          messages.reduce((sum, message) => sum + message.content.length, 0) <= agentAuthoringLimits.transcript,
        'Transcript is too large',
      )
      .refine(
        messages =>
          messages[0]?.role === 'user' &&
          messages.at(-1)?.role === 'user' &&
          messages.every((message, index) => message.role === (index % 2 === 0 ? 'user' : 'assistant')),
        'Supply alternating turns ending in a user message',
      ),
    snapshotId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    input => input.messages.length === 1 || input.snapshotId !== undefined,
    'Continuing a test chat requires its snapshot ID',
  );
export const agentAuthoringUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  credits: z.number().nonnegative(),
});
const response = {
  requestId: uuidSchema,
  source: agentAuthoringSourceSchema,
  model: z.strictObject({ familyId: modelFamilyIdSchema, modelId: z.string().min(1).max(256) }),
  usage: agentAuthoringUsageSchema,
};
export const improvedAgentInstructionsSchema = z.strictObject({
  ...response,
  suggestion: nonblank(agentAuthoringLimits.suggestion),
});
export const agentPreviewReplySchema = z.strictObject({
  ...response,
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  text: nonblank(agentAuthoringLimits.message),
});
export const agentAuthoringErrorSchema = z.strictObject({
  error: z.enum([
    'invalid-request',
    'input-too-large',
    'model-family-unavailable',
    'workspace-disabled',
    'credits-exhausted',
    'request-already-dispatched',
    'idempotency-conflict',
    'authoring-busy',
    'stale-snapshot',
    'provider-invalid-response',
    'provider-empty-response',
    'provider-output-too-large',
    'provider-interrupted',
    'provider-refused',
    'provider-tools-forbidden',
    'provider-model-mismatch',
    'provider-usage-unavailable',
    'provider-authentication',
    'provider-permission',
    'provider-rate-limit',
    'provider-quota',
    'provider-unavailable',
    'cancelled',
    'timed-out',
    'credits-settlement-unavailable',
    'authoring-unavailable',
  ]),
});
export type AgentAuthoringErrorCode = z.infer<typeof agentAuthoringErrorSchema>['error'];
export class AgentAuthoringError extends Error {
  readonly code: AgentAuthoringErrorCode;
  constructor(code: AgentAuthoringErrorCode) {
    super(code);
    this.name = 'AgentAuthoringError';
    this.code = code;
  }
}
export type AgentAuthoringSource = z.infer<typeof agentAuthoringSourceSchema>;
export type ImproveAgentInstructions = z.infer<typeof improveAgentInstructionsSchema>;
export type ImprovedAgentInstructions = z.infer<typeof improvedAgentInstructionsSchema>;
export type PreviewAgentChat = z.infer<typeof previewAgentChatSchema>;
export type AgentPreviewReply = z.infer<typeof agentPreviewReplySchema>;

export function isAgentAuthoringSourceCurrent(result: AgentAuthoringSource, current: AgentAuthoringSource) {
  return result.version === current.version && result.fingerprint === current.fingerprint;
}
