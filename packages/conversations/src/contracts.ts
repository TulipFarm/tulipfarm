import { z } from 'zod';
import { toolPresentationSchema, activityStatusSchema, workflowReferenceSchema } from './tool-activity.ts';
export { workflowReferenceSchema } from './tool-activity.ts';
import { publicWebReceiptSchema } from './public-web.ts';
import { knowledgeActivitySchema } from './knowledge-activity.ts';
import { compactCommandPartSchema, compactionPartSchema } from './compaction-contracts.ts';
export { publicWebResultSchema, publicWebUrlSchema, webSourceSchema, webPageSchema } from './public-web.ts';
import { uuidSchema } from '@tulipfarm/access';
import { calendarHistoryResultSchema } from '@tulipfarm/google-workspace/calendar-events';
import { googleFileBindingSchema, googleFileIdSchema } from '@tulipfarm/google-workspace/public-contracts';
import { chatDocumentReferences, chatDocumentSchema, chatDocumentText } from './rich-content.ts';
import { rowChangeSchema, rowViewSchema } from './row-view.ts';

const unicodeText = z
  .string()
  .refine(
    value =>
      !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    'Text must be valid PostgreSQL Unicode',
  );
export const textPartSchema = z
  .strictObject({
    kind: z.literal('text'),
    text: unicodeText
      .min(1)
      .max(65536)
      .refine(value => Buffer.byteLength(value) <= 65536, 'Text part exceeds 64 KiB'),
    content: chatDocumentSchema.optional(),
  })
  .refine(
    part => !part.content || chatDocumentText(part.content) === part.text,
    'Rich content text does not match its projection',
  );
export const attachmentPartSchema = z.strictObject({ kind: z.literal('attachment'), attachmentId: uuidSchema });
/** Identifies a TulipFarm file by id. The message stores a reference, not a name, path, or copy. */
export const filePartSchema = z.strictObject({ kind: z.literal('file'), fileId: uuidSchema });
/**
 * Identifies a Google Drive file and the sender's Google integration it was chosen through. The name and type label the chip;
 * content is read from Google through that integration each time a reply uses it.
 */
export const googleFilePartSchema = z.strictObject({
  kind: z.literal('google-file'),
  fileId: googleFileIdSchema,
  name: unicodeText.min(1).max(512),
  mimeType: z.string().min(1).max(127),
  expectedIntegration: googleFileBindingSchema,
});
const googleFileDisplaySchema = googleFilePartSchema.omit({ expectedIntegration: true });
const skillIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9-]{0,63})$/);
const skillRevisionSchema = z.string().regex(/^(?:latest|[a-f0-9]{64}|[1-9][0-9]{0,8})$/);
export const skillPartSchema = z.strictObject({
  kind: z.literal('skill'),
  skillId: skillIdSchema,
  revision: skillRevisionSchema,
});
/** A `/compact` command. With compactionId it regenerates that compaction's handoff instead of compacting again. */
export const compactPartSchema = z
  .strictObject({
    kind: z.literal('compact'),
    prompt: unicodeText.trim().min(1).max(2000).optional(),
    compactionId: uuidSchema.optional(),
  })
  .refine(part => !(part.prompt && part.compactionId), 'A handoff retry cannot change the handoff prompt');
export const inputPartSchema = z.discriminatedUnion('kind', [
  textPartSchema,
  attachmentPartSchema,
  filePartSchema,
  googleFilePartSchema,
  skillPartSchema,
  compactPartSchema,
]);
export const createChatSchema = z.strictObject({
  commandId: uuidSchema,
  chatId: uuidSchema,
  projectId: uuidSchema.optional(),
});
export const moveChatSchema = z.strictObject({
  commandId: uuidSchema,
  projectId: uuidSchema,
  confirmFullHistoryIncludingAdmins: z.literal(true),
});
export const conversationModelSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
export const chatToolCallLimit = 1000;
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(value => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown timezone');
export const sendMessageSchema = z.strictObject({
  commandId: uuidSchema,
  messageId: uuidSchema,
  /** Model family of the reply; the server's default model when absent. */
  model: conversationModelSchema.optional(),
  mode: z.enum(['normal', 'plan']).optional(),
  timeZone: timeZoneSchema.optional(),
  parts: z
    .array(inputPartSchema)
    .min(1)
    .max(32)
    .refine(
      parts =>
        parts.reduce((size, part) => size + (part.kind === 'text' ? Buffer.byteLength(part.text) : 0), 0) <= 131072,
      'Message exceeds 128 KiB',
    )
    .refine(parts => parts.filter(part => part.kind === 'attachment').length <= 5, 'At most five attachments')
    .refine(parts => {
      const ids = parts.flatMap(part => (part.kind === 'attachment' ? [part.attachmentId] : []));
      return new Set(ids).size === ids.length;
    }, 'Duplicate attachment')
    .refine(
      parts => parts.filter(part => part.kind === 'file' || part.kind === 'google-file').length <= 5,
      'At most five file references',
    )
    .refine(parts => {
      const ids = parts.flatMap(part =>
        part.kind === 'file' ? [part.fileId] : part.kind === 'google-file' ? [`google:${part.fileId}`] : [],
      );
      return new Set(ids).size === ids.length;
    }, 'Duplicate file reference')
    .refine(parts => parts.filter(part => part.kind === 'skill').length <= 1, 'At most one skill')
    .refine(parts => {
      const documents = parts.flatMap(part => (part.kind === 'text' && part.content ? [part.content] : []));
      if (!documents.length) return true;
      const rich = documents.flatMap(document =>
        chatDocumentReferences(document).map(reference => `${reference.source}:${reference.id}`),
      );
      const indexed = parts.flatMap(part =>
        part.kind === 'file'
          ? [`tulipfarm:${part.fileId}`]
          : part.kind === 'google-file'
            ? [`google:${part.fileId}`]
            : [],
      );
      return (
        rich.length === new Set(rich).size &&
        rich.length === indexed.length &&
        rich.every((reference, index) => reference === indexed[index])
      );
    }, 'Rich content file references do not match indexed file parts')
    .refine(
      parts => !parts.some(part => part.kind === 'compact') || parts.length === 1,
      'A compact command must be the only part',
    ),
});
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
export const chatTitleLimit = 50;
export const chatTitleSchema = unicodeText
  .trim()
  .min(1)
  .max(640)
  .refine(value => [...segmenter.segment(value)].length <= chatTitleLimit, 'Title exceeds 50 characters');
export function initialTitle(parts: readonly z.infer<typeof inputPartSchema>[], skillName = '') {
  const collapse = (value: string) =>
    value
      .replace(/\uFFFC/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  const text =
    collapse(parts.flatMap(part => (part.kind === 'text' ? [part.text] : [])).join('')) || collapse(skillName);
  let title = '';
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (++count > chatTitleLimit || title.length + segment.length > 640) break;
    title += segment;
  }
  return (
    title ||
    (parts.some(part => part.kind === 'attachment')
      ? 'Attachments'
      : parts.some(part => part.kind === 'file' || part.kind === 'google-file')
        ? 'Files'
        : 'New chat')
  );
}
export const renameChatSchema = z.strictObject({
  commandId: uuidSchema,
  expectedRevision: z.number().int().nonnegative(),
  title: chatTitleSchema,
});
export const archiveChatSchema = z.strictObject({ commandId: uuidSchema, archived: z.boolean() });
export const deleteChatSchema = z.strictObject({ commandId: uuidSchema });
export const historyQuerySchema = z.strictObject({ before: z.number().int().positive().max(2147483647).optional() });
export const cursorSchema = z.strictObject({ activityAt: z.iso.datetime({ precision: 6 }), id: uuidSchema });
export const listQuerySchema = z.strictObject({
  archived: z.boolean().default(false),
  query: unicodeText.max(640).default(''),
  cursor: cursorSchema.optional(),
  projectId: uuidSchema.optional(),
});
export const chatSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  titleRevision: z.number().int(),
  titleManual: z.boolean().default(false),
  archived: z.boolean(),
  isClosed: z.boolean().default(false),
  activityAt: z.string(),
  createdAt: z.string(),
  projectId: uuidSchema.nullable().default(null),
});
/** A chat the requester can post in, offered by Use in chat. */
export const chatDestinationSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  activityAt: z.string(),
  projectId: uuidSchema.nullable(),
  projectName: z.string().nullable(),
});
export const destinationQuerySchema = z.strictObject({ query: unicodeText.max(640).default('') });
export const fileAudienceQuerySchema = z.strictObject({
  fileIds: z
    .array(uuidSchema)
    .min(1)
    .max(5)
    .refine(ids => new Set(ids).size === ids.length, 'Duplicate file'),
});
export const turnStatusSchema = z.enum([
  'queued',
  'processing',
  'waiting',
  'reconciling',
  'failed',
  'completed',
  'cancelled',
  'blocked',
]);
/**
 * A completed turn's `errorCode` starts with this when a configured fallback model answered after the chat model failed;
 * the rest is that model family's id. The turn itself succeeded.
 */
export const modelFallbackCodePrefix = 'model-fallback:';
export const turnSummarySchema = z.object({
  id: uuidSchema,
  status: turnStatusSchema,
  generation: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative().optional(),
  errorCode: z.string().nullable().optional(),
  mode: z.literal('plan').optional(),
});
export const controlTurnSchema = z.strictObject({
  commandId: uuidSchema,
  expectedGeneration: z.number().int().nonnegative(),
});
export const controlResultSchema = z.object({
  turnId: uuidSchema,
  status: z.enum(['queued', 'cancelled']),
  generation: z.number().int().nonnegative(),
});
const skillReference = { skillId: skillIdSchema, revision: skillRevisionSchema, name: z.string().min(1).max(120) };
export const displayPartSchema = z.discriminatedUnion('kind', [
  textPartSchema,
  attachmentPartSchema,
  filePartSchema,
  googleFileDisplaySchema,
  z.strictObject({ kind: z.literal('request'), requestId: uuidSchema }),
  z.strictObject({ kind: z.literal('response'), responseId: uuidSchema }),
  z.strictObject({ kind: z.literal('approval'), approvalId: uuidSchema }),
  z.strictObject({ kind: z.literal('approval-resolution'), approvalId: uuidSchema }),
  z.strictObject({ kind: z.literal('skill'), ...skillReference }),
  z.strictObject({ kind: z.literal('skill-use'), ...skillReference }),
  compactCommandPartSchema,
  compactionPartSchema,
]);
export const toolReceiptSchema = z.object({
  id: uuidSchema,
  tool: z.string(),
  status: z.enum(['running', 'completed', 'blocked', 'failed']),
  activityStatus: activityStatusSchema.optional(),
  activity: z.string().nullable().default(null),
  presentation: toolPresentationSchema.optional(),
  web: publicWebReceiptSchema.nullable().default(null),
  knowledge: knowledgeActivitySchema.nullable().optional(),
  fileId: uuidSchema.optional(),
  fileIds: z.array(uuidSchema).max(64).optional(),
  importId: uuidSchema.optional(),
  googleProposalId: uuidSchema.optional(),
  rowDraftId: uuidSchema.optional(),
  rowView: rowViewSchema.optional(),
  rowChange: rowChangeSchema.optional(),
  workflows: z.array(workflowReferenceSchema).optional(),
});
export const messageSchema = z.object({
  id: uuidSchema,
  sequence: z.number().int().positive(),
  author: z.enum(['human', 'assistant']),
  createdAt: z.string(),
  parts: z.array(displayPartSchema),
  turn: turnSummarySchema.nullable(),
  tools: z.array(toolReceiptSchema).default([]),
  calendarResults: z.array(calendarHistoryResultSchema).default([]),
});
export const historySchema = z.object({
  messages: z.array(messageSchema),
  nextBefore: z.number().int().positive().nullable(),
  hasGitHubProposals: z.boolean(),
});
export class ConversationConflict extends Error {
  readonly code:
    | 'command-conflict'
    | 'identity-conflict'
    | 'title-conflict'
    | 'turn-conflict'
    | 'request-conflict'
    | 'credits-exhausted'
    | 'project-archived'
    | 'move-conflict'
    | 'file-unavailable'
    | 'file-audience'
    | 'google-file-audience'
    | 'google-integration-changed'
    | 'skill-unavailable'
    | 'compaction-not-found'
    | 'maintenance-not-resumable';
  constructor(code: ConversationConflict['code']) {
    super(code);
    this.code = code;
  }
}
