import {
  defineCatalog,
  defineComponent,
  sproutComponents,
  type A2uiComponent,
  type Surface,
} from '@tulipfarm/sprout/a2ui/catalog';
import { z } from 'zod';
import { embedReferenceSchema, readLayoutSurface, type Layout } from '@tulipfarm/conversations/layout-contracts';

export const chatCatalog = defineCatalog({
  id: 'tulipfarm/chat@2',
  components: {
    ...sproutComponents,
    Embed: defineComponent({
      description: "An existing TulipFarm card, loaded with the viewer's permissions.",
      props: z.strictObject({ ref: embedReferenceSchema }),
    }),
  },
});

function escapeLiteral(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(escapeLiteral);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key.startsWith('@') ? `@${key}` : key, escapeLiteral(item)]),
  );
}

/** Project the validated, still-pinned server protocol into the browser's A2UI 1.0 surface. */
export function layoutSurface(layout: Layout): Surface | undefined {
  const saved = readLayoutSurface(layout);
  if (!saved) return undefined;
  const ids = new Map([...saved.components.keys()].map((id, index) => [id, id === 'root' ? 'root' : `c${index}`]));
  const childId = (id: string) => ids.get(id) ?? id;
  const components = new Map<string, A2uiComponent>();
  for (const component of saved.components.values()) {
    const converted: A2uiComponent = { id: childId(component.id), component: component.component };
    for (const [key, value] of Object.entries(component)) {
      if (key === 'id' || key === 'component') continue;
      if (key === 'children') {
        converted[key] = Array.isArray(value)
          ? value.map(childId)
          : value && typeof value === 'object' && 'componentId' in value
            ? { ...value, componentId: childId(String(value.componentId)) }
            : value;
      } else if ((key === 'tabs' || key === 'items') && Array.isArray(value)) {
        converted[key] = value.map(item => ({ ...item, child: childId(item.child) }));
      } else if (component.component === 'Button' && key === 'message') {
        converted.action = { event: { name: 'followUp', userMessage: value } };
      } else if (value && typeof value === 'object' && 'path' in value && Object.keys(value).length === 1) {
        converted[key] = { '@path': value.path };
      } else {
        converted[key] = escapeLiteral(value);
      }
    }
    components.set(converted.id, converted);
  }
  return {
    ...saved,
    catalogId: chatCatalog.id,
    components,
    sendDataModel: false,
    metadata: undefined,
    rendererCalls: [],
    functionResponses: new Map(),
  };
}
