import { z } from 'zod';
import { appSurfaceSchema, checkAppSurface } from '@tulipfarm/conversations/layout-contracts';
import { tableRowsQuerySchema, tableSummaryQuerySchema } from '@tulipfarm/tables/query';
import { reservedPageSlugs } from './names.ts';

export const appDefinitionLimits = Object.freeze({ pages: 20, sources: 10, actions: 20 });

const uuidSchema = z.uuid();
const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/u, 'Use a letter, then letters, digits or _');

export const pageIdSchema = identifier.brand<'AppPageId'>();
export type AppPageId = z.infer<typeof pageIdSchema>;
export const sourceIdSchema = identifier.brand<'AppSourceId'>();
export type AppSourceId = z.infer<typeof sourceIdSchema>;
export const actionIdSchema = identifier.brand<'AppActionId'>();
export type AppActionId = z.infer<typeof actionIdSchema>;

/** Address of a page: `/apps/<app slug>/<page slug>`. */
export const pageSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/)
  .refine(slug => !reservedPageSlugs.has(slug), { error: 'Reserved page slug' })
  .brand<'AppPageSlug'>();
export type AppPageSlug = z.infer<typeof pageSlugSchema>;

/** A value the clicked Button sends under this key of its event context. */
export const bindingSchema = z.strictObject({ context: identifier });
export type AppBinding = z.infer<typeof bindingSchema>;

export const appSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: sourceIdSchema, kind: z.literal('rows'), tableId: uuidSchema, query: tableRowsQuerySchema }),
  z.strictObject({
    id: sourceIdSchema,
    kind: z.literal('summary'),
    tableId: uuidSchema,
    query: tableSummaryQuerySchema,
  }),
  z.strictObject({ id: sourceIdSchema, kind: z.literal('row') }),
  z.strictObject({ id: sourceIdSchema, kind: z.literal('file'), fileId: uuidSchema }),
  z.strictObject({ id: sourceIdSchema, kind: z.literal('members') }),
]);
export type AppSource = z.infer<typeof appSourceSchema>;

const actionLabel = z.string().trim().min(1).max(60);
const bindings = z.record(identifier, bindingSchema);

export const appActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: actionIdSchema,
    label: actionLabel,
    kind: z.literal('open-page'),
    pageId: pageIdSchema,
    row: bindingSchema.optional(),
  }),
  z.strictObject({ id: actionIdSchema, label: actionLabel, kind: z.literal('open-record'), target: bindingSchema }),
  z.strictObject({
    id: actionIdSchema,
    label: actionLabel,
    kind: z.literal('run-workflow'),
    workflowId: uuidSchema,
    input: bindings,
  }),
  z.strictObject({
    id: actionIdSchema,
    label: actionLabel,
    kind: z.literal('ask-agent'),
    agentId: uuidSchema,
    message: z.string().trim().min(1).max(4000),
    bindings,
  }),
]);
export type AppAction = z.infer<typeof appActionSchema>;

export const appPageSchema = z.strictObject({
  id: pageIdSchema,
  slug: pageSlugSchema,
  title: z.string().trim().min(1).max(120),
  row: z.strictObject({ tableId: uuidSchema }).optional(),
  sources: z.array(appSourceSchema).max(appDefinitionLimits.sources),
  actions: z.array(appActionSchema).max(appDefinitionLimits.actions),
  surface: appSurfaceSchema,
});
export type AppPage = z.infer<typeof appPageSchema>;

/** A private app: its pages in order, the first being home. */
export const appDefinitionSchema = z.strictObject({
  pages: z.array(appPageSchema).min(1).max(appDefinitionLimits.pages),
});
export type AppDefinition = z.infer<typeof appDefinitionSchema>;

/** One problem, at a JSON Pointer into the definition. */
export type AppDefinitionIssue = { readonly path: string; readonly message: string };
export type AppDefinitionCheck =
  | { readonly ok: true; readonly definition: AppDefinition }
  | { readonly ok: false; readonly issues: AppDefinitionIssue[] };

/** The context keys an action reads from its Button. */
export function actionBindings(action: AppAction): AppBinding[] {
  switch (action.kind) {
    case 'open-page':
      return action.row ? [action.row] : [];
    case 'open-record':
      return [action.target];
    case 'run-workflow':
      return Object.values(action.input);
    case 'ask-agent':
      return Object.values(action.bindings);
  }
}

/** Structural check plus catalog check. Pure, so the browser, API and worker run the same one. */
export function checkAppDefinition(input: unknown): AppDefinitionCheck {
  const parsed = appDefinitionSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map(issue => ({ path: pointer(issue.path), message: issue.message })),
    };
  const definition = parsed.data;
  const issues: AppDefinitionIssue[] = [];
  const report = (path: readonly PropertyKey[], message: string) => issues.push({ path: pointer(path), message });
  const pages = new Map(definition.pages.map(page => [page.id, page]));
  duplicates(
    definition.pages,
    page => page.id,
    index => report(['pages', index, 'id'], 'Page IDs must be unique'),
  );
  duplicates(
    definition.pages,
    page => page.slug,
    index => report(['pages', index, 'slug'], 'Page slugs must be unique'),
  );

  definition.pages.forEach((page, pageIndex) => {
    const at = (...path: PropertyKey[]) => ['pages', pageIndex, ...path];
    duplicates(
      page.sources,
      source => source.id,
      index => report(at('sources', index, 'id'), 'Source IDs must be unique'),
    );
    duplicates(
      page.actions,
      action => action.id,
      index => report(at('actions', index, 'id'), 'Action IDs must be unique'),
    );
    page.sources.forEach((source, index) => {
      if (source.kind === 'row' && !page.row) report(at('sources', index), 'A row source needs a page row');
    });
    page.actions.forEach((action, index) => {
      if (action.kind !== 'open-page') return;
      const target = pages.get(action.pageId);
      if (!target) report(at('actions', index, 'pageId'), `No page has ID ${action.pageId}`);
      else if (target.row && !action.row) report(at('actions', index), `Page ${target.id} needs a row`);
      else if (!target.row && action.row) report(at('actions', index, 'row'), `Page ${target.id} takes no row`);
    });

    const surface = checkAppSurface(page.surface, page.id);
    if (!surface.ok) {
      for (const error of surface.errors)
        issues.push({ path: `/pages/${pageIndex}/surface${error.path}`, message: error.message });
      return;
    }
    const actions = new Map<string, AppAction>(page.actions.map(action => [action.id, action]));
    for (const { component, path } of lastComponents(page.surface)) {
      const event = component.component === 'Button' ? buttonEvent(component.action) : undefined;
      if (!event) continue;
      const eventPath = at('surface', ...path, 'action', 'event');
      const action = actions.get(event.name);
      if (!action) {
        report([...eventPath, 'name'], `The page declares no action ${event.name}`);
        continue;
      }
      const sent = new Set(Object.keys(event.context ?? {}));
      const bound = new Set(actionBindings(action).map(binding => binding.context));
      for (const key of bound)
        if (!sent.has(key)) report([...eventPath, 'context'], `Action ${action.id} needs context ${key}`);
      for (const key of sent)
        if (!bound.has(key)) report([...eventPath, 'context', key], `Action ${action.id} does not bind context ${key}`);
    }
  });
  return issues.length ? { ok: false, issues } : { ok: true, definition };
}

type SurfaceComponent = NonNullable<
  Extract<AppPage['surface'][number], { createSurface: unknown }>['createSurface']['components']
>[number];

/** Each component as the surface ends up drawing it, with its path in the messages. A later update replaces an ID. */
function lastComponents(messages: AppPage['surface']) {
  const found = new Map<string, { component: SurfaceComponent; path: PropertyKey[] }>();
  messages.forEach((message, index) => {
    const [key, components] =
      'createSurface' in message
        ? (['createSurface', message.createSurface.components ?? []] as const)
        : 'updateComponents' in message
          ? (['updateComponents', message.updateComponents.components] as const)
          : (['', []] as const);
    components.forEach((component, componentIndex) =>
      found.set(component.id, { component, path: [index, key, 'components', componentIndex] }),
    );
  });
  return found.values();
}

const buttonEvent = (action: unknown) => {
  const parsed = buttonEventSchema.safeParse(action);
  return parsed.success ? parsed.data.event : undefined;
};
const buttonEventSchema = z.object({
  event: z.object({ name: z.string(), context: z.record(z.string(), z.unknown()).optional() }),
});

function duplicates<T>(items: readonly T[], key: (item: T) => string, report: (index: number) => void) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(key(item))) report(index);
    seen.add(key(item));
  });
}

const pointer = (path: readonly PropertyKey[]) =>
  path.map(part => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
