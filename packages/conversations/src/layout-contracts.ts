import { z } from 'zod';
import {
  marketplaceInstallRequest,
  marketplacePackage,
  type MarketplacePackage,
} from '@tulipfarm/config/package-links';
import {
  a2uiProtocol,
  a2uiVersion,
  checkSurface,
  defaultSurfaceLimits,
  defineCatalog,
  defineComponent,
  defineFunction,
  dynamicStringSchema,
  identifierSchema,
  promptSnippet,
  readSurface,
  sproutCatalog,
  surfaceMessageSchema,
  surfaceText,
  type A2uiComponent,
  type Surface,
  type SurfaceError,
  type SurfaceMessage,
} from '@tulipfarm/sprout/a2ui/catalog';
import { workflowReferenceSchema } from './tool-activity.ts';
import type { inputPartSchema } from './contracts.ts';

const id = z.uuid();

export const layoutCompatibility = Object.freeze({ minimum: 67 });

const workspaceFileEmbed = z.strictObject({ kind: z.literal('workspace-file'), fileId: id });
const workflowEmbed = z.strictObject({ kind: z.literal('workflow'), reference: workflowReferenceSchema });

/** An existing TulipFarm card, referenced by the ID of the record that owns it. The viewer's own permissions apply. */
export const embedReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan'), planId: id }),
  z.strictObject({ kind: z.literal('schema'), proposalId: id }),
  z.strictObject({ kind: z.literal('github-batch'), batchId: id, task: z.boolean().default(false) }),
  z.strictObject({ kind: z.literal('slack-action'), actionId: id }),
  z.strictObject({ kind: z.literal('calendar-action'), proposalId: id }),
  z.strictObject({ kind: z.literal('google-action'), proposalId: id }),
  z.strictObject({ kind: z.literal('google-file'), fileId: z.string().min(1).max(256) }),
  workspaceFileEmbed,
  workflowEmbed,
  z.strictObject({
    kind: z.literal('package-install'),
    url: z.string().refine(value => marketplacePackage(value) !== null, 'A versioned marketplace package is required'),
  }),
]);
export type EmbedReference = z.infer<typeof embedReferenceSchema>;

const Embed = defineComponent({
  description:
    'An existing TulipFarm card (plan, schema proposal, GitHub batch, Slack action, calendar or Google action, file or workflow) by the ID of its record, as returned by an earlier tool call. A package-install card opens a versioned marketplace URL for human review; it does not authorize installation.',
  props: z.strictObject({ ref: embedReferenceSchema }),
  text: ({ ref }) => `[${ref.kind}]`,
});

export const tulipfarmCatalogId = 'tulipfarm/chat@2';
/** The catalog of every layout surface. TulipFarm's own parts come from `tulipfarmCatalog` and name it with `@catalogId`. */
export const layoutSurfaceCatalogId = sproutCatalog.id;

/** Functions the agent runs for the browser, answered by the layout function endpoint. */
export const agentFunctionNames = ['searchRows', 'listMembers'] as const;
export type AgentFunctionName = (typeof agentFunctionNames)[number];
/** Functions the agent asks the browser to run on the live reply. */
export const screenActionNames = ['openInCanvas', 'focusComponent'] as const;
export type ScreenActionName = (typeof screenActionNames)[number];
/** Most items a lookup function returns. */
export const agentFunctionItemLimit = 50;

export const searchRowsArgsSchema = z.strictObject({
  tableId: dynamicStringSchema,
  query: dynamicStringSchema.optional(),
});
export const listMembersArgsSchema = z.strictObject({ query: dynamicStringSchema.optional() });
/** Resolved arguments, as the browser sends them in `callAgentFunction`. */
export const agentFunctionArgsSchemas = {
  searchRows: z.strictObject({ tableId: id, query: z.string().max(200).optional() }),
  listMembers: z.strictObject({ query: z.string().max(200).optional() }),
} satisfies Record<AgentFunctionName, z.ZodType>;
export const lookupItemSchema = z.strictObject({ value: z.string(), label: z.string() });
export type LookupItem = z.infer<typeof lookupItemSchema>;

const lookupFunctions = {
  searchRows: defineFunction({
    description: `Rows of a workspace table the person can read, as at most ${agentFunctionItemLimit} {value: row ID, label} items, filtered by an optional search text.`,
    args: searchRowsArgsSchema,
    returnType: 'array',
  }),
  listMembers: defineFunction({
    description: `Workspace members, as at most ${agentFunctionItemLimit} {value: membership ID, label: name} items, filtered by an optional search text.`,
    args: listMembersArgsSchema,
    returnType: 'array',
  }),
};

export const tulipfarmCatalog = defineCatalog({
  id: tulipfarmCatalogId,
  title: 'TulipFarm',
  description: 'TulipFarm cards and workspace lookups.',
  instructions: `Name this catalog on each Embed: {"id": "plan_card", "component": "Embed", "@catalogId": "${tulipfarmCatalogId}", "ref": {...}}. searchRows and listMembers return [{value, label}] lists, for example as ChoicePicker options.`,
  components: { Embed },
  functions: {
    ...lookupFunctions,
    openInCanvas: defineFunction({
      description: 'Opens this reply in Canvas.',
      returnType: 'void',
      allowedCallers: 'agentOnly',
    }),
    focusComponent: defineFunction({
      description: 'Scrolls to a component of this reply and moves focus to it.',
      args: z.strictObject({ componentId: identifierSchema }),
      returnType: 'void',
      allowedCallers: 'agentOnly',
    }),
  },
});
/** Every catalog a layout may use, for checking and drawing. */
export const layoutCatalogs = [sproutCatalog, tulipfarmCatalog] as const;

export const layoutProtocol = a2uiProtocol;
export const layoutVersion = a2uiVersion;
/** The event a follow-up button sends: its `userMessage` becomes the person's next message. */
export const followUpActionName = 'follow_up';
export const followUpAction = (userMessage: string) => ({ event: { name: followUpActionName, userMessage } });

export const layoutActionContextLimit = 8192;
const actionContextSchema = z
  .record(z.string(), z.unknown())
  .refine(value => bytes(JSON.stringify(value)) <= layoutActionContextLimit, 'Action values exceed 8 KiB');
export const layoutActionLabelsLimit = 4096;
/** What the person saw for chosen values, such as a deal's name for its row ID. Shown in place of the value; the value stays the record. */
const actionLabelsSchema = z
  .record(z.string(), z.string().max(1000))
  .refine(value => bytes(JSON.stringify(value)) <= layoutActionLabelsLimit, 'Action labels exceed 4 KiB');
/** A person's use of a button in an assistant reply. The reply's surface ID is its message ID. */
export const layoutActionRequestSchema = z
  .strictObject({
    commandId: id,
    /** The ID of the person's message the action sends. */
    sentMessageId: id,
    surfaceId: id,
    name: z.string().trim().min(1).max(100),
    sourceComponentId: identifierSchema,
    context: actionContextSchema.default({}),
    labels: actionLabelsSchema.optional(),
    userMessage: z.string().trim().min(1).max(2000),
  })
  .refine(
    request => Object.keys(request.labels ?? {}).every(key => Object.hasOwn(request.context, key)),
    'Every label must name an action value',
  );
export type LayoutActionRequest = z.infer<typeof layoutActionRequestSchema>;
/** The stored action, beside the `userMessage` text it sent. `messageId` is the reply that drew the button. */
export const layoutActionSchema = z.strictObject({
  messageId: id,
  name: z.string(),
  sourceComponentId: z.string(),
  context: z.record(z.string(), z.unknown()).default({}),
  labels: z.record(z.string(), z.string()).optional(),
});
export type LayoutAction = z.infer<typeof layoutActionSchema>;
export const layoutActionResultSchema = z.object({ messageId: id, turnId: id, sequence: z.number().int() });

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

/** One function the browser runs on the live reply, such as opening it in Canvas. */
export const screenActionSchema = z.strictObject({
  name: z.enum(screenActionNames),
  componentId: identifierSchema.optional(),
});
export type ScreenAction = z.infer<typeof screenActionSchema>;

/** What the model sends as `reply.render` arguments. The worker adds the protocol, catalog and surface ID. */
export const replyRenderInputSchema = z.strictObject({
  placement: layoutPlacementSchema,
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(maxSummary),
  messages: z.array(surfaceMessageSchema).min(1).max(64),
  slack: slackLayoutSchema.optional(),
  screenActions: z.array(screenActionSchema).max(4).optional(),
});
export type ReplyRenderInput = z.infer<typeof replyRenderInputSchema>;

export const layoutSchema = z.strictObject({
  protocol: z.literal(layoutProtocol),
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
    catalogs: [...layoutCatalogs],
    limits: layoutLimits,
    allowUrl: layoutAllowUrl,
  });
  if (!surface.ok) return surface;
  const errors: SurfaceError[] = [];
  const report = (message: string) =>
    errors.push({ code: 'VALIDATION_FAILED', surfaceId: surface.surface.surfaceId, path: '/messages', message });
  if (surface.surface.catalogId !== layoutSurfaceCatalogId)
    report(`The surface must use catalog ${layoutSurfaceCatalogId}`);
  if (surfaceId && surface.surface.surfaceId !== surfaceId) report(`The surface ID must be ${surfaceId}`);
  if (surface.surface.deleted) report('The surface must not be deleted');
  return errors.length ? { ok: false, errors } : { ok: true, layout: parsed.data };
}

/** Builds a checked layout from `reply.render` arguments for the reply with this message ID. */
export function layoutFromReply(input: ReplyRenderInput, surfaceId: string): LayoutCheck {
  const { screenActions: _screenActions, ...rest } = input;
  const messages = input.messages.map(message =>
    'createSurface' in message
      ? { ...message, createSurface: { ...message.createSurface, surfaceId, catalogId: layoutSurfaceCatalogId } }
      : 'updateComponents' in message
        ? { ...message, updateComponents: { ...message.updateComponents, surfaceId } }
        : 'updateDataModel' in message
          ? { ...message, updateDataModel: { ...message.updateDataModel, surfaceId } }
          : message,
  );
  return checkLayout({ protocol: layoutProtocol, ...rest, messages }, surfaceId);
}

/**
 * The value of JSON text cut off mid-stream: everything up to the last closed object, array or string value, with the
 * open containers closed. Unfinished keys, numbers and strings are dropped. Returns `undefined` when nothing is complete.
 */
export function partialJson(text: string): unknown {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let key = false;
  let previous = '';
  let cut = 0;
  let closers = '';
  const mark = (index: number) => {
    cut = index + 1;
    closers = [...stack].reverse().join('');
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        inString = false;
        previous = '"';
        if (!key) mark(index);
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      key = stack.at(-1) === '}' && (previous === '{' || previous === ',');
    } else if (character === '{' || character === '[') stack.push(character === '{' ? '}' : ']');
    else if (character === '}' || character === ']') {
      stack.pop();
      mark(index);
    }
    if (!/\s/.test(character)) previous = character;
  }
  if (!cut) return undefined;
  try {
    return JSON.parse(text.slice(0, cut) + closers);
  } catch {
    return undefined;
  }
}

export type LayoutPreview = { placement?: LayoutPlacement; title?: string; messages: unknown[] };

/** What streamed `reply.render` arguments show so far, drawn on `surfaceId` while the reply has no message ID yet. */
export function layoutPreview(json: string, surfaceId: string): LayoutPreview | undefined {
  const value = partialJson(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const placement = layoutPlacementSchema.safeParse(input.placement);
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : undefined;
  const messages = (Array.isArray(input.messages) ? input.messages : []).flatMap((message): unknown[] => {
    if (!message || typeof message !== 'object') return [];
    const { createSurface, updateComponents, updateDataModel } = message as Record<string, unknown>;
    const body = (value: unknown) => (value && typeof value === 'object' ? { ...value, surfaceId } : undefined);
    if (!body(createSurface ?? updateComponents ?? updateDataModel)) return [];
    if (createSurface)
      return [{ version: layoutVersion, createSurface: { ...body(createSurface), catalogId: layoutSurfaceCatalogId } }];
    if (updateComponents) return [{ version: layoutVersion, updateComponents: body(updateComponents) }];
    if (updateDataModel) return [{ version: layoutVersion, updateDataModel: body(updateDataModel) }];
    return [];
  });
  return { ...(placement.success ? { placement: placement.data } : {}), ...(title ? { title } : {}), messages };
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
    placement: 'chat',
    title: options.title ?? 'Reply',
    summary,
    messages: [
      {
        version: a2uiVersion,
        createSurface: {
          surfaceId,
          catalogId: layoutSurfaceCatalogId,
          components: [{ id: 'root', component: 'Text', text }],
        },
      },
    ],
    ...(options.notice ? { notice: options.notice } : {}),
  };
}

export function packageInstallRequest(
  parts: readonly z.infer<typeof inputPartSchema>[],
  mode?: 'normal' | 'plan',
  projectId?: string | null,
): MarketplacePackage | null {
  const part = parts[0];
  if (projectId || mode === 'plan' || parts.length !== 1 || part?.kind !== 'text') return null;
  if (part.content) {
    const blocks = part.content.doc.content;
    const block = blocks[0];
    if (
      blocks.length !== 1 ||
      block?.type !== 'paragraph' ||
      !block.content?.length ||
      block.content.some(
        node => node.type !== 'text' || node.marks?.some(mark => mark.type === 'code' || mark.type === 'link'),
      ) ||
      block.content.map(node => (node.type === 'text' ? node.text : '')).join('') !== part.text
    )
      return null;
  }
  return marketplaceInstallRequest(part.text);
}

export function packageInstallationLayout(link: MarketplacePackage, surfaceId: string): Layout {
  return {
    protocol: layoutProtocol,
    placement: 'chat',
    title: 'Package installation',
    summary: `Review ${link.url}, choose its workspace inputs, and approve the whole package once to install it. Opening this form does not install anything.`,
    messages: [
      {
        version: a2uiVersion,
        createSurface: {
          surfaceId,
          catalogId: layoutSurfaceCatalogId,
          components: [
            {
              id: 'root',
              component: 'Embed',
              '@catalogId': tulipfarmCatalogId,
              ref: { kind: 'package-install', url: link.url },
            },
          ],
        },
      },
    ],
  };
}

/** Every component a layout's messages define, in message order. */
export function layoutComponents(messages: readonly SurfaceMessage[]): A2uiComponent[] {
  return messages.flatMap(message =>
    'createSurface' in message
      ? (message.createSurface.components ?? [])
      : 'updateComponents' in message
        ? message.updateComponents.components
        : [],
  );
}

/** Whether a button sends the person's input back to the agent as an action, other than a follow-up message. */
export function layoutAwaitsInput(messages: readonly SurfaceMessage[]): boolean {
  return layoutComponents(messages).some(component => {
    const action = (component as { action?: unknown }).action;
    if (typeof action !== 'object' || action === null || !('event' in action)) return false;
    const event = (action as { event?: { name?: unknown } }).event;
    return typeof event?.name === 'string' && event.name !== followUpActionName;
  });
}

/** The components of a layout's surface, by ID, after every update. */
export function layoutComponentMap(layout: Layout) {
  return readSurface(layout.messages)?.components ?? new Map<string, A2uiComponent>();
}

export function packagesInLayout(value: unknown): MarketplacePackage[] {
  const checked = checkLayout(value);
  if (!checked.ok) return [];
  return layoutComponents(checked.layout.messages).flatMap(component => {
    if (component.component !== 'Embed') return [];
    const parsed = embedReferenceSchema.safeParse(component.ref);
    if (!parsed.success || parsed.data.kind !== 'package-install') return [];
    const link = marketplacePackage(parsed.data.url);
    return link ? [link] : [];
  });
}

/** The layout as plain text: the summary, then the surface. It is the copy, search and model-history text. */
export function layoutText(layout: Layout): string {
  const surface = readSurface(layout.messages);
  const body = surface ? surfaceText(surface, [...layoutCatalogs]).trim() : '';
  const text = body && body !== layout.summary ? `${layout.summary}\n\n${body}` : layout.summary;
  if (bytes(text) <= maxText) return text;
  let end = Math.min(text.length, maxText);
  while (bytes(text.slice(0, end)) > maxText - 3) end = Math.floor(end * 0.95);
  if (/[\uD800-\uDBFF]$/u.test(text.slice(0, end))) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** The catalog description for the model. */
export const layoutPromptSnippet = () => layoutCatalogs.map(catalog => promptSnippet(catalog)).join('\n\n');

export const appsCatalogId = 'tulipfarm/apps@1';
export const appEmbedReferenceSchema = z.discriminatedUnion('kind', [workspaceFileEmbed, workflowEmbed]);
export type AppEmbedReference = z.infer<typeof appEmbedReferenceSchema>;
const { openUrl: _openUrl, ...appBasicFunctions } = sproutCatalog.functions;

/**
 * The catalog of every app page surface: Sprout's components, workspace file and workflow cards, and the workspace
 * lookups. Pages are written from table content an agent read, so the catalog has nothing that runs script, applies
 * styles or loads or opens a URL.
 */
export const appsCatalog = defineCatalog({
  id: appsCatalogId,
  title: 'TulipFarm apps',
  description: 'Sprout components, workspace file and workflow cards, and workspace lookups for app pages.',
  instructions: `${sproutCatalog.instructions ?? ''}
A Button's action.event.name is the ID of an action the page declares, and its context sends exactly the values that action binds. Pages read their sources at /sources/<source ID> and their row at /params/row.`,
  components: {
    ...sproutCatalog.components,
    Embed: defineComponent({
      description: 'A workspace file or workflow card by the ID of its record.',
      props: z.strictObject({ ref: appEmbedReferenceSchema }),
      text: ({ ref }) => `[${ref.kind}]`,
    }),
  },
  functions: { ...appBasicFunctions, ...lookupFunctions },
});

/** App pages load and open no URLs: links and images in text are refused. */
export const appAllowUrl = (_url: string, _kind: 'link' | 'image') => false;

/** One app page surface as stored: a `createSurface`, then optional `updateComponents`. Data comes from the page's sources. */
export const appSurfaceSchema = z.array(surfaceMessageSchema).min(1).max(64);

export type AppSurfaceCheck = { ok: true; surface: Surface } | { ok: false; errors: SurfaceError[] };

/** The catalog check for one app page surface, used by the worker, the API and the browser. */
export function checkAppSurface(messages: readonly SurfaceMessage[], surfaceId: string): AppSurfaceCheck {
  const errors: SurfaceError[] = [];
  messages.forEach((message, index) => {
    if (index === 0 ? !('createSurface' in message) : !('updateComponents' in message))
      errors.push({
        code: 'VALIDATION_FAILED',
        surfaceId,
        path: `/${index}`,
        message: index === 0 ? 'The first message must be createSurface' : 'Later messages must be updateComponents',
      });
  });
  if (errors.length) return { ok: false, errors };
  const checked = checkSurface(messages, { catalogs: [appsCatalog], limits: layoutLimits, allowUrl: appAllowUrl });
  if (!checked.ok) return checked;
  const report = (message: string) =>
    errors.push({ code: 'VALIDATION_FAILED', surfaceId, path: '/0/createSurface', message });
  if (checked.surface.catalogId !== appsCatalogId) report(`The surface must use catalog ${appsCatalogId}`);
  if (checked.surface.surfaceId !== surfaceId) report(`The surface ID must be ${surfaceId}`);
  return errors.length ? { ok: false, errors } : checked;
}
