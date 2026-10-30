import { z } from 'zod';
import {
  checkSurface,
  defaultSurfaceLimits,
  defineCatalog,
  defineComponent,
  promptSnippet,
  readSurface,
  sproutComponents,
  surfaceMessageSchema,
  surfaceText,
  type SurfaceError,
} from '@tulipfarm/sprout/a2ui/catalog';
import { workflowReferenceSchema } from './tool-activity.ts';

const id = z.uuid();

/** An existing TulipFarm card, referenced by the ID of the record that owns it. The viewer's own permissions apply. */
export const embedReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan'), planId: id }),
  z.strictObject({ kind: z.literal('schema'), proposalId: id }),
  z.strictObject({ kind: z.literal('github-batch'), batchId: id, task: z.boolean().default(false) }),
  z.strictObject({ kind: z.literal('slack-action'), actionId: id }),
  z.strictObject({ kind: z.literal('calendar-action'), proposalId: id }),
  z.strictObject({ kind: z.literal('google-action'), proposalId: id }),
  z.strictObject({ kind: z.literal('google-file'), fileId: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal('workspace-file'), fileId: id }),
  z.strictObject({ kind: z.literal('workflow'), reference: workflowReferenceSchema }),
]);
export type EmbedReference = z.infer<typeof embedReferenceSchema>;

const Embed = defineComponent({
  description:
    'An existing TulipFarm card (plan, schema proposal, GitHub batch, Slack action, calendar or Google action, file or workflow) by the ID of its record, as returned by an earlier tool call.',
  props: z.strictObject({ ref: embedReferenceSchema }),
  text: ({ ref }) => `[${ref.kind}]`,
});

export const tulipfarmCatalogId = 'tulipfarm/chat@1';
// Image is left out: files are shown through Embed, which loads them with the viewer's permissions.
const { Image: _image, ...components } = sproutComponents;
export const tulipfarmCatalog = defineCatalog({ id: tulipfarmCatalogId, components: { ...components, Embed } });

export const layoutProtocol = 'a2ui/0.9';
export const layoutPlacementSchema = z.enum(['chat', 'canvas']);
export type LayoutPlacement = z.infer<typeof layoutPlacementSchema>;
/** Layout limits (PRODUCT 7). */
export const layoutLimits = { ...defaultSurfaceLimits, bytes: 262144 };
const maxSummary = 2000;
const maxText = 65536;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;

const slackBlock = z.record(z.string(), z.unknown());
/**
 * A reply laid out for Slack: Block Kit blocks with server action IDs, an optional Markdown report for a Slack canvas,
 * and the modals its buttons open. The worker checks the blocks against Block Kit; the web shows the A2UI copy.
 */
export const slackLayoutSchema = z.strictObject({
  blocks: z.array(slackBlock).min(1).max(50),
  report: z.string().min(1).max(60_000).optional(),
  modals: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9_-]{1,32}$/u),
        title: z.string().min(1).max(24),
        submit: z.string().min(1).max(24),
        blocks: z.array(slackBlock).min(1).max(100),
      }),
    )
    .max(5)
    .optional(),
});
export type SlackLayout = z.infer<typeof slackLayoutSchema>;

/** What the model sends as `reply.render` arguments. The worker adds the protocol, catalog and surface ID. */
export const replyRenderInputSchema = z.strictObject({
  placement: layoutPlacementSchema,
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(maxSummary),
  messages: z.array(surfaceMessageSchema).min(1).max(64),
  slack: slackLayoutSchema.optional(),
});
export type ReplyRenderInput = z.infer<typeof replyRenderInputSchema>;

export const layoutSchema = z.strictObject({
  protocol: z.literal(layoutProtocol),
  catalogId: z.literal(tulipfarmCatalogId),
  placement: layoutPlacementSchema,
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(maxSummary),
  messages: z.array(surfaceMessageSchema).min(1).max(64),
  slack: slackLayoutSchema.optional(),
  /** Set when the model's layout failed its checks and this one-Text layout replaced it. */
  notice: z.literal('layout-failed').optional(),
});
export type Layout = z.infer<typeof layoutSchema>;

/** Links use HTTP, HTTPS or mailto. Nothing is loaded from a URL, so Markdown images are refused. */
export function layoutAllowUrl(url: string, kind: 'link' | 'image') {
  if (kind === 'image') return false;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export type LayoutCheck = { ok: true; layout: Layout } | { ok: false; errors: SurfaceError[] };

/** The one check for a layout, used by the worker, the API and the browser. */
export function checkLayout(value: unknown, surfaceId?: string): LayoutCheck {
  const parsed = layoutSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map(issue => ({
        code: 'VALIDATION_FAILED',
        surfaceId: surfaceId ?? '',
        path: `/${issue.path.join('/')}`,
        message: issue.message,
      })),
    };
  const surface = checkSurface(parsed.data.messages, {
    catalog: tulipfarmCatalog,
    limits: layoutLimits,
    allowUrl: layoutAllowUrl,
  });
  if (!surface.ok) return surface;
  const errors: SurfaceError[] = [];
  const report = (message: string) =>
    errors.push({ code: 'VALIDATION_FAILED', surfaceId: surface.surface.surfaceId, path: '/messages', message });
  if (surface.surface.catalogId !== tulipfarmCatalogId) report(`The surface must use catalog ${tulipfarmCatalogId}`);
  if (surfaceId && surface.surface.surfaceId !== surfaceId) report(`The surface ID must be ${surfaceId}`);
  if (surface.surface.deleted) report('The surface must not be deleted');
  return errors.length ? { ok: false, errors } : { ok: true, layout: parsed.data };
}

/** Builds a checked layout from `reply.render` arguments for the reply with this message ID. */
export function layoutFromReply(input: ReplyRenderInput, surfaceId: string): LayoutCheck {
  const messages = input.messages.map(message =>
    'createSurface' in message
      ? { ...message, createSurface: { ...message.createSurface, surfaceId, catalogId: tulipfarmCatalogId } }
      : 'updateComponents' in message
        ? { ...message, updateComponents: { ...message.updateComponents, surfaceId } }
        : 'updateDataModel' in message
          ? { ...message, updateDataModel: { ...message.updateDataModel, surfaceId } }
          : message,
  );
  return checkLayout({ protocol: layoutProtocol, catalogId: tulipfarmCatalogId, ...input, messages }, surfaceId);
}

/** A layout with one Text component, for replies written as plain text and for layouts that failed their checks. */
export function textLayout(
  text: string,
  surfaceId: string,
  options: { title?: string; notice?: Layout['notice'] } = {},
): Layout {
  const end = /[\uD800-\uDBFF]/u.test(text.charAt(maxSummary - 2)) ? maxSummary - 2 : maxSummary - 1;
  const summary = text.length > maxSummary ? `${text.slice(0, end)}…` : text;
  return {
    protocol: layoutProtocol,
    catalogId: tulipfarmCatalogId,
    placement: 'chat',
    title: options.title ?? 'Reply',
    summary,
    messages: [
      { version: 'v0.9.1', createSurface: { surfaceId, catalogId: tulipfarmCatalogId } },
      {
        version: 'v0.9.1',
        updateComponents: { surfaceId, components: [{ id: 'root', component: 'Text', text }] },
      },
    ],
    ...(options.notice ? { notice: options.notice } : {}),
  };
}

/** The layout as plain text: the summary, then the surface. It is the copy, search and model-history text. */
export function layoutText(layout: Layout): string {
  const surface = readSurface(layout.messages);
  const body = surface ? surfaceText(surface, tulipfarmCatalog).trim() : '';
  const text = body && body !== layout.summary ? `${layout.summary}\n\n${body}` : layout.summary;
  if (bytes(text) <= maxText) return text;
  let end = Math.min(text.length, maxText);
  while (bytes(text.slice(0, end)) > maxText - 3) end = Math.floor(end * 0.95);
  if (/[\uD800-\uDBFF]$/u.test(text.slice(0, end))) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** The catalog description for the model. */
export const layoutPromptSnippet = () => promptSnippet(tulipfarmCatalog);
