import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentProps, surfaceText } from '@tulipfarm/sprout/a2ui/catalog';
import { checkLayout, textLayout, type Layout } from '@tulipfarm/conversations/layout-contracts';
import { chatCatalog, layoutSurface } from '../src/features/chat/layout-surface.ts';

const surfaceId = '11111111-1111-4111-8111-111111111111';
function surface(layout: Layout) {
  assert.equal(checkLayout(layout).ok, true);
  const result = layoutSurface(layout);
  assert.ok(result);
  for (const component of result.components.values()) {
    const definition = chatCatalog.components[component.component];
    assert.ok(definition);
    assert.equal(definition.props.safeParse(componentProps(component)).success, true);
  }
  return result;
}

test('saved layouts retain text, relative bindings, templates and null data in the new renderer', () => {
  const layout = textLayout('Summary', surfaceId);
  layout.messages = [
    layout.messages[0]!,
    {
      version: 'v0.9.1',
      updateComponents: {
        surfaceId,
        components: [
          { id: 'root', component: 'Column', children: { componentId: 'item-row', path: '/items' } },
          { id: 'item-row', component: 'Text', text: { path: 'name' } },
        ],
      },
    },
    {
      version: 'v0.9.1',
      updateDataModel: { surfaceId, value: { items: [{ name: 'Cedar' }, { name: 'Maple' }], nullable: 'before' } },
    },
    { version: 'v0.9.1', updateDataModel: { surfaceId, path: '/nullable', value: null } },
  ];
  const result = surface(layout);
  assert.equal(surfaceText(result, chatCatalog), 'Cedar\n\nMaple');
  assert.deepEqual(result.data, { items: [{ name: 'Cedar' }, { name: 'Maple' }], nullable: null });
  assert.deepEqual(result.components.get('root')?.children, { componentId: 'c1', path: '/items' });
});

test('saved tabs, details and follow-up buttons use remapped IDs and A2UI event actions', () => {
  const layout = textLayout('Summary', surfaceId);
  layout.messages[1] = {
    version: 'v0.9.1',
    updateComponents: {
      surfaceId,
      components: [
        { id: 'root', component: 'Tabs', tabs: [{ label: 'Next', child: 'next-step' }] },
        { id: 'next-step', component: 'Details', items: [{ title: 'Follow up', child: 'send-message' }] },
        { id: 'send-message', component: 'Button', label: 'Compare', message: 'Compare prices' },
      ],
    },
  };
  const result = surface(layout);
  assert.deepEqual(result.components.get('root')?.tabs, [{ label: 'Next', child: 'c1' }]);
  assert.deepEqual(result.components.get('c1')?.items, [{ title: 'Follow up', child: 'c2' }]);
  assert.deepEqual(result.components.get('c2')?.action, {
    event: { name: 'followUp', userMessage: 'Compare prices' },
  });
  assert.equal(result.components.get('c2')?.message, undefined);
});

test('literal table rows cannot become function calls or bindings after migration', () => {
  const layout = textLayout('Summary', surfaceId);
  layout.messages[1] = {
    version: 'v0.9.1',
    updateComponents: {
      surfaceId,
      components: [
        {
          id: 'root',
          component: 'Table',
          label: 'Literal data',
          columns: [
            { key: '@call', label: 'Call' },
            { key: '@@path', label: 'Path' },
          ],
          rows: [{ '@call': 'notAFunction', '@@path': '/literal', path: '/alsoLiteral' }],
        },
      ],
    },
  };
  assert.match(surfaceText(surface(layout), chatCatalog), /notAFunction.*\/literal/);
});
