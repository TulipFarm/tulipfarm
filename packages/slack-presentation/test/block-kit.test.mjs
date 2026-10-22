import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSlackSurface } from '../dist/index.js';

const text = { type: 'plain_text', text: 'Example' };
const rich = {
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Example' }] }],
};
const button = { type: 'button', text, action_id: 'example' };
const image = { type: 'image', image_url: 'https://example.com/a.png', alt_text: 'Example' };
const fixtures = [
  [{ type: 'actions', elements: [button] }, ['message', 'modal', 'home']],
  [{ type: 'alert', text }, ['message', 'modal', 'home']],
  [{ type: 'card', title: text }, ['message', 'modal', 'home']],
  [{ type: 'carousel', elements: [{ type: 'card', title: text }] }, ['message', 'modal', 'home']],
  [{ type: 'container', title: text, child_blocks: [{ type: 'section', text }] }, ['message', 'home']],
  [{ type: 'context', elements: [text] }, ['message', 'modal', 'home']],
  [
    {
      type: 'context_actions',
      elements: [
        {
          type: 'feedback_buttons',
          action_id: 'feedback',
          positive_button: { text, value: 'yes' },
          negative_button: { text, value: 'no' },
        },
      ],
    },
    ['message'],
  ],
  [
    {
      type: 'data_table',
      caption: 'Example',
      rows: [[{ type: 'raw_text', text: 'Header' }], [{ type: 'raw_number', text: '1', value: 1 }]],
    },
    ['message', 'home'],
  ],
  [
    {
      type: 'data_visualization',
      title: 'Example',
      chart: { type: 'pie', segments: [{ label: 'Example', value: 1 }] },
    },
    ['message', 'home'],
  ],
  [{ type: 'divider' }, ['message', 'modal', 'home']],
  [{ type: 'file', source: 'remote', external_id: 'id' }, []],
  [{ type: 'header', text }, ['message', 'modal', 'home']],
  [image, ['message', 'modal', 'home']],
  [
    { type: 'input', label: text, element: { type: 'plain_text_input', action_id: 'input' } },
    ['message', 'modal', 'home'],
  ],
  [{ type: 'markdown', text: '**Example**' }, ['message']],
  [{ type: 'plan', title: 'Example', tasks: [{ task_id: 'task', title: 'Example', status: 'complete' }] }, ['message']],
  [rich, ['message', 'modal', 'home']],
  [{ type: 'section', text }, ['message', 'modal', 'home']],
  [{ type: 'table', rows: [[{ type: 'raw_number', value: 1, text: '1' }]] }, ['message', 'home']],
  [{ type: 'task_card', task_id: 'task', title: 'Example', status: 'complete' }, ['message']],
  [
    {
      type: 'video',
      video_url: 'https://example.com/embed',
      thumbnail_url: 'https://example.com/a.png',
      alt_text: 'Example',
      title: text,
    },
    ['message', 'modal', 'home'],
  ],
];
function surface(kind, blocks) {
  if (kind === 'message') return { kind, text: 'Example', blocks };
  return { kind, view: { type: kind, blocks, ...(kind === 'modal' ? { title: text, submit: text } : {}) } };
}
for (const [block, placements] of fixtures) {
  test(`${block.type} preserves payload only in supported placements`, () => {
    for (const kind of ['message', 'modal', 'home']) {
      const payload = surface(kind, [block]);
      if (placements.includes(kind)) assert.deepEqual(parseSlackSurface(payload), payload);
      else assert.throws(() => parseSlackSurface(payload), /payload-invalid/);
      assert.throws(
        () => parseSlackSurface(surface(kind, [{ ...block, inventedAuthority: 'yes' }])),
        /payload-invalid/,
      );
    }
  });
}

test('website-only rich text variants validate without opaque JSON', () => {
  const elements = [
    { type: 'attachment_mention', url: 'https://example.com' },
    { type: 'canvas', file_id: 'F123' },
    { type: 'canvas_user_mention', user_id: 'U123' },
    { type: 'canvas_message_unfurl', root_message_ts: '123.456', root_message_channel: 'C123' },
    { type: 'file', file_id: 'F123' },
    { type: 'list_record', file_id: 'F123' },
    { type: 'message_mention', channel_id: 'C123', message_ts: '123.456' },
    { type: 'salesforce_data_field', salesforce_record_id: 'record' },
    { type: 'tag', text: 'Done', color: 'green' },
    { type: 'work_object_mention', entity_id: 'E123', app_id: 'A123', text: 'Example', url: 'https://example.com' },
    { type: 'workflow_mention', workflow_id: 'W123', function_trigger_id: 'Ft123', text: 'Example' },
    {
      type: 'citation',
      url: 'https://example.com',
      text: 'Source',
      index: 1,
      details: { citation_type: 'web', display_name: 'Example', title: 'Example', snippet: 'Example' },
    },
  ];
  const payload = surface('message', [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] }]);
  assert.deepEqual(parseSlackSurface(payload), payload);
  elements[0].invented = true;
  assert.throws(() => parseSlackSurface(payload), /payload-invalid/);
});

test('nested placement, repeated IDs, modal submit and file inputs are checked', () => {
  const input = { type: 'input', label: text, element: { type: 'file_input', action_id: 'file' } };
  assert.deepEqual(parseSlackSurface(surface('modal', [input])), surface('modal', [input]));
  assert.throws(() => parseSlackSurface(surface('message', [input])), /payload-invalid/);
  assert.throws(() => parseSlackSurface(surface('modal', [{ ...input, dispatch_action: true }])), /payload-invalid/);
  assert.throws(
    () => parseSlackSurface({ kind: 'modal', view: { type: 'modal', title: text, blocks: [input] } }),
    /payload-invalid/,
  );
  assert.throws(
    () =>
      parseSlackSurface(
        surface('message', [
          { type: 'container', title: text, child_blocks: [{ type: 'file', source: 'remote', external_id: 'id' }] },
        ]),
      ),
    /payload-invalid/,
  );
  assert.throws(
    () =>
      parseSlackSurface(
        surface('message', [
          { type: 'section', text, block_id: 'same' },
          { type: 'container', title: text, child_blocks: [{ type: 'section', text, block_id: 'same' }] },
        ]),
      ),
    /payload-invalid/,
  );
});

test('message and view block budgets reject the first excess block', () => {
  assert.equal(
    parseSlackSurface(
      surface(
        'message',
        Array.from({ length: 50 }, () => ({ type: 'divider' })),
      ),
    ).blocks.length,
    50,
  );
  assert.throws(
    () =>
      parseSlackSurface(
        surface(
          'message',
          Array.from({ length: 51 }, () => ({ type: 'divider' })),
        ),
      ),
    /payload-invalid/,
  );
  assert.equal(
    parseSlackSurface(
      surface(
        'home',
        Array.from({ length: 100 }, () => ({ type: 'divider' })),
      ),
    ).view.blocks.length,
    100,
  );
  assert.throws(
    () =>
      parseSlackSurface(
        surface(
          'home',
          Array.from({ length: 101 }, () => ({ type: 'divider' })),
        ),
      ),
    /payload-invalid/,
  );
});

test('table and chart structures reject invalid data', () => {
  const chart = {
    type: 'data_visualization',
    title: 'Sales',
    chart: { type: 'pie', segments: [{ label: 'North', value: 10 }] },
  };
  assert.deepEqual(parseSlackSurface(surface('message', [chart])).blocks, [chart]);
  assert.throws(
    () =>
      parseSlackSurface(
        surface('message', [{ ...chart, chart: { type: 'pie', segments: [{ label: 'North', value: -1 }] } }]),
      ),
    /payload-invalid/,
  );
  assert.throws(
    () => parseSlackSurface(surface('message', [{ type: 'table', rows: [[{ type: 'raw_text', text: 'A' }], []] }])),
    /payload-invalid/,
  );
  assert.throws(
    () =>
      parseSlackSurface(
        surface('message', [
          {
            ...chart,
            chart: {
              type: 'bar',
              axis_config: { categories: ['North'] },
              series: [{ name: 'Sales', data: [{ label: 'South', value: 10 }] }],
            },
          },
        ]),
      ),
    /payload-invalid/,
  );
});

test('all numeric fields reject nonfinite values before JSON serialization', () => {
  const numericBlocks = value => [
    { type: 'data_visualization', title: 'Sales', chart: { type: 'pie', segments: [{ label: 'North', value }] } },
    {
      type: 'data_visualization',
      title: 'Sales',
      chart: {
        type: 'bar',
        axis_config: { categories: ['North'] },
        series: [{ name: 'Sales', data: [{ label: 'North', value }] }],
      },
    },
    { type: 'table', rows: [[{ type: 'raw_number', value, text: '1' }]] },
    {
      type: 'data_table',
      caption: 'Sales',
      rows: [[{ type: 'raw_text', text: 'Header' }], [{ type: 'raw_number', value, text: '1' }]],
    },
    {
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'date', timestamp: value, format: '{date_num}' }] }],
    },
  ];
  for (const block of numericBlocks(1)) {
    assert.deepEqual(JSON.parse(JSON.stringify(parseSlackSurface(surface('message', [block])))).blocks, [block]);
  }
  for (const value of [Infinity, -Infinity, NaN, JSON.parse('1e400')]) {
    for (const block of numericBlocks(value))
      assert.throws(() => parseSlackSurface(surface('message', [block])), /payload-invalid/);
  }
});

const task = { task_id: 'task', title: 'Example', status: 'complete' };
const nestedRichBlocks = [
  ['task details', child => ({ type: 'task_card', ...task, details: child })],
  ['task output', child => ({ type: 'task_card', ...task, output: child })],
  ['plan task details', child => ({ type: 'plan', title: 'Example', tasks: [{ ...task, details: child }] })],
  ['plan task output', child => ({ type: 'plan', title: 'Example', tasks: [{ ...task, output: child }] })],
  ['container title', child => ({ type: 'container', rich_text_title: child, child_blocks: [{ type: 'divider' }] })],
  ['table cell', child => ({ type: 'table', rows: [[child]] })],
  [
    'data table cell',
    child => ({ type: 'data_table', caption: 'Example', rows: [[{ type: 'raw_text', text: 'Header' }], [child]] }),
  ],
  [
    'container table cell',
    child => ({ type: 'container', title: text, child_blocks: [{ type: 'table', rows: [[child]] }] }),
  ],
];
for (const [name, embed] of nestedRichBlocks) {
  test(`block IDs are unique and bounded in ${name}`, () => {
    const payload = surface('message', [{ ...rich, block_id: 'outer' }, embed({ ...rich, block_id: 'inner' })]);
    assert.deepEqual(parseSlackSurface(payload), payload);
    assert.throws(
      () =>
        parseSlackSurface(surface('message', [{ ...rich, block_id: 'same' }, embed({ ...rich, block_id: 'same' })])),
      /payload-invalid/,
    );
    assert.throws(
      () => parseSlackSurface(surface('message', [embed({ ...rich, block_id: 'x'.repeat(256) })])),
      /payload-invalid/,
    );
  });
}

test('plan task block IDs share the enclosing message namespace', () => {
  const payload = surface('message', [
    { type: 'plan', block_id: 'plan', title: 'Example', tasks: [{ ...task, block_id: 'task' }] },
  ]);
  assert.deepEqual(parseSlackSurface(payload), payload);
  payload.blocks[0].tasks[0].block_id = 'plan';
  assert.throws(() => parseSlackSurface(payload), /payload-invalid/);
});
