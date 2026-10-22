import { z } from 'zod';
import { googleAgentOperationSchema, googleOperationSchema } from '@tulipfarm/google-workspace/operation-contracts';

/** A styled file rendered from a JSON spec and uploaded to Drive, converted to the matching Google format. */
export const googleDocumentSchema = z.strictObject({
  name: z.string().min(1).max(200),
  format: z.enum(['docx', 'xlsx', 'pptx']),
  content: z
    .string()
    .max(1048576)
    .describe('JSON document spec. Read the google-docs, google-sheets, or google-slides skill first.'),
  folderId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,256}$/)
    .optional()
    .describe('Drive folder ID; omit for My Drive.'),
});
const proposeDescription =
  'Set exactly one of operation or document. To edit an existing file, read it first and use operation with its existing ID. document always creates a new Google Doc, Sheet, or Slides file from a JSON spec; never use it as a replacement for an edit without the person agreeing.';

export const googleToolCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('google.read'),
    operation: googleOperationSchema,
    importSelection: z
      .string()
      .max(16384)
      .optional()
      .describe('Explicit JSON integration import selection. Omit for ordinary reads.'),
  }),
  z
    .strictObject({
      tool: z.literal('google.propose'),
      operation: googleOperationSchema.optional(),
      document: googleDocumentSchema.optional(),
    })
    .describe(proposeDescription),
  z.strictObject({ tool: z.literal('google.status'), proposalId: z.uuid() }),
  z.strictObject({ tool: z.literal('google.execute'), proposalId: z.uuid() }),
]);
export const googleAgentToolCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('google.read'),
    operation: googleAgentOperationSchema,
    importSelection: z
      .string()
      .max(16384)
      .optional()
      .describe('Explicit JSON integration import selection. Omit for ordinary reads.'),
  }),
  z
    .strictObject({
      tool: z.literal('google.propose'),
      operation: googleAgentOperationSchema.optional(),
      document: googleDocumentSchema.optional(),
    })
    .describe(proposeDescription),
  z.strictObject({ tool: z.literal('google.status'), proposalId: z.uuid() }),
  z.strictObject({ tool: z.literal('google.execute'), proposalId: z.uuid() }),
]);
export const googleAgentToolCallOptions = new Map<string, (typeof googleAgentToolCallSchema.options)[number]>(
  googleAgentToolCallSchema.options.map(option => [option.shape.tool.value, option]),
);
export type GoogleToolCall = z.infer<typeof googleToolCallSchema>;
export const googleToolErrorCodeSchema = z.enum([
  'integration-required',
  'operation-conflict',
  'operation-expired',
  'operation-limit',
  'operation-read-required',
  'operation-write-required',
  'operation-approval-required',
  'operation-revision-required',
  'operation-target-stale',
  'operation-unguarded-update',
  'invalid-operation',
  'invalid-credential',
  'cancelled',
  'provider-unavailable',
  'provider-rejected',
  'reconnect-required',
  'insufficient-scope',
  'rate-limited',
  'response-too-large',
  'invalid-response',
  'outcome-unknown',
  'not-configured',
  'invalid-state',
  'consent-denied',
  'stale-integration',
  'credential-unavailable',
]);
export const googleToolErrorSchema = z.strictObject({
  provider: z.literal('google-workspace'),
  untrusted: z.literal(true),
  error: googleToolErrorCodeSchema,
  message: z.string().optional(),
});
export const googleToolResultSchema = z.union([
  z.strictObject({ provider: z.literal('google-workspace'), untrusted: z.literal(true), data: z.json() }),
  googleToolErrorSchema,
]);
