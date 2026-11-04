import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applySectionsUpdate,
  changeList,
  checkMermaid,
  escapeHtml,
  mermaidLabel,
  planDocumentModel,
  planDocumentSectionsSchema,
  planDocumentSectionsUpdateSchema,
  planGraphMermaid,
  planGraphText,
  planStamp,
  renderMarkdown,
  renderPlanDocumentHtml,
  stampText,
} from '../dist/index.js';

const sections = { summary: 'Ship the launch.' };
const task = (key, extra = {}) => ({ key, parent: null, kind: 'work', title: key, dependsOn: [], ...extra });
const snapshot = (extra = {}) => ({
  title: 'Launch',
  brief: 'Plan the launch.',
  starterName: 'Asha',
  contentRevision: 3,
  generatedAt: '2026-11-04T04:00:00Z',
  requirements: [{ key: 'r1', description: 'Site is live' }],
  prerequisites: [{ key: 'p1', title: 'DNS access', status: 'unknown' }],
  tasks: [
    task('build', { kind: 'group', title: 'Build' }),
    task('code', { parent: 'build', title: 'Write code', criteria: ['Tests pass'] }),
    task('ship', { title: 'Ship it', dependsOn: ['build'], assignee: { kind: 'specialist', name: 'Ops' } }),
  ],
  budget: { toolCalls: 300, activeMinutes: 30, credits: 300 },
  sections,
  ...extra,
});

test('sections schema bounds every field and rejects unknown keys', () => {
  const parsed = planDocumentSectionsSchema.parse(sections);
  assert.deepEqual(parsed, { summary: 'Ship the launch.', risks: [], diagrams: [] });
  assert.equal(planDocumentSectionsSchema.safeParse({ summary: '' }).success, false);
  assert.equal(planDocumentSectionsSchema.safeParse({ summary: 'x'.repeat(1501) }).success, false);
  assert.equal(planDocumentSectionsSchema.safeParse({ ...sections, extra: 1 }).success, false);
  const risk = { risk: 'r', mitigation: 'm' };
  assert.equal(planDocumentSectionsSchema.safeParse({ ...sections, risks: Array(9).fill(risk) }).success, false);
  const diagram = { key: 'flow', title: 'Flow', mermaid: 'flowchart LR\n  a --> b' };
  assert.equal(planDocumentSectionsSchema.safeParse({ ...sections, diagrams: [diagram, diagram] }).success, false);
  assert.equal(
    planDocumentSectionsSchema.safeParse({ ...sections, diagrams: [{ ...diagram, key: 'plan' }] }).success,
    false,
  );
  assert.equal(
    planDocumentSectionsSchema.safeParse({ ...sections, diagrams: [{ ...diagram, key: 'Bad' }] }).success,
    false,
  );
  assert.equal(
    planDocumentSectionsSchema.safeParse({ ...sections, diagrams: [{ ...diagram, mermaid: 'pie\n "a": 1' }] }).success,
    false,
  );
});

test('a sections update replaces only what it names and can remove the approach', () => {
  assert.equal(planDocumentSectionsUpdateSchema.safeParse({}).success, false);
  const current = planDocumentSectionsSchema.parse({
    ...sections,
    approach: 'Old',
    risks: [{ risk: 'r', mitigation: 'm' }],
  });
  const next = applySectionsUpdate(current, planDocumentSectionsUpdateSchema.parse({ approach: null }));
  assert.deepEqual(next, { summary: 'Ship the launch.', risks: [{ risk: 'r', mitigation: 'm' }], diagrams: [] });
  assert.equal(applySectionsUpdate(current, { summary: 'New' }).approach, 'Old');
});

test('checkMermaid accepts the supported diagram kinds and rejects scripting', () => {
  for (const source of [
    '%% note\nflowchart TD\n  a -->|go| b\n  b <--> c',
    'graph LR; a-->b',
    'sequenceDiagram\n  A->>B: Hi',
    'stateDiagram-v2\n  [*] --> Idle',
    'timeline\n  2026 : Launch',
  ])
    assert.deepEqual(checkMermaid(source), { ok: true }, source);
  for (const source of [
    '',
    'flowchart\n a-->b',
    'pie\n "a": 1',
    '%%{init: {"securityLevel": "loose"}}%%\nflowchart TD\n a-->b',
    'flowchart TD\n a-->b\n click a "https://x"',
    'flowchart TD\n a-->b; click a call alert()',
    'flowchart TD\n a["<img src=x onerror=alert(1)>"]',
    'flowchart TD\n a["</b>"]',
    'flowchart TD\n a["javascript:alert(1)"]',
    'flowchart TD\n a\n style a fill:url(https://x)',
    'flowchart TD\n a[x]\n classDef c background:url(x)',
    'flowchart TD\n a["href"]',
    `flowchart TD\n${' a-->b\n'.repeat(700)}`,
  ])
    assert.equal(checkMermaid(source).ok, false, source);
  assert.deepEqual(checkMermaid('flowchart TD\n a["Call the customer"]'), { ok: true });
});

test('plan graph draws groups as subgraphs with escaped labels and dependency edges', () => {
  const tasks = [
    task('build', { kind: 'group', title: 'Build "v2" #1 <now>' }),
    task('code-it', { parent: 'build', title: 'Write; code' }),
    task('test', { parent: 'build', dependsOn: ['code-it'] }),
    task('ship', { dependsOn: ['build', 'missing'] }),
    task('inner', { parent: 'build', dependsOn: ['build'] }),
  ];
  const source = planGraphMermaid(tasks);
  assert.equal(
    source,
    [
      'flowchart TD',
      '  subgraph t_build["Build #quot;v2#quot; #35;1 #lt;now#gt;"]',
      '    t_code_it["Write#59; code"]',
      '    t_test["test"]',
      '    t_inner["inner"]',
      '  end',
      '  t_ship["ship"]',
      '  t_code_it --> t_test',
      '  t_build --> t_ship',
    ].join('\n'),
  );
  assert.deepEqual(checkMermaid(source), { ok: true });
  assert.equal(mermaidLabel('a`b&c'), '"a#96;b#amp;c"');
  assert.equal(
    planGraphText(tasks),
    [
      '- Group: Build "v2" #1 <now>',
      '  - Write; code',
      '  - test (waits for Write; code)',
      '  - inner (waits for Build "v2" #1 <now>)',
      '- ship (waits for Build "v2" #1 <now>)',
    ].join('\n'),
  );
});

test('plan graph collapses to deduplicated group edges above 40 work tasks', () => {
  const tasks = [task('a', { kind: 'group', title: 'A' }), task('b', { kind: 'group', title: 'B' })];
  for (let i = 0; i < 21; i++) {
    tasks.push(task(`a${i}`, { parent: 'a', dependsOn: i ? [`a${i - 1}`] : [] }));
    tasks.push(task(`b${i}`, { parent: 'b', dependsOn: [`a${i}`] }));
  }
  tasks.push(task('solo', { dependsOn: ['b3'] }));
  assert.equal(
    planGraphMermaid(tasks),
    [
      'flowchart TD',
      '  t_a["A (21 tasks)"]',
      '  t_b["B (21 tasks)"]',
      '  t_solo["solo"]',
      '  t_a --> t_b',
      '  t_b --> t_solo',
    ].join('\n'),
  );
});

test('the model is an allowlist that never carries results, evidence, instructions or links', () => {
  const model = planDocumentModel(
    snapshot({
      id: 'plan-id',
      chatId: 'chat-id',
      specialists: [{ key: 'ops', instructions: 'SECRET-INSTRUCTIONS' }],
      prerequisites: [{ key: 'p1', title: 'DNS', status: 'blocked', evidence: [{ summary: 'SECRET-EVIDENCE' }] }],
      tasks: [
        {
          ...task('code'),
          id: 'task-id',
          report: { summary: 'SECRET-RESULT' },
          waitingTaskId: 'waiting-id',
          state: 'completed',
          assignee: { kind: 'agent', agentId: 'agent-id', name: null },
        },
      ],
    }),
  );
  const json = JSON.stringify(model);
  for (const secret of ['SECRET', 'plan-id', 'chat-id', 'task-id', 'waiting-id', 'agent-id', 'completed'])
    assert.equal(json.includes(secret), false, secret);
  assert.deepEqual(model.tasks[0], {
    key: 'code',
    parent: null,
    kind: 'work',
    order: 'parallel',
    title: 'code',
    brief: '',
    criteria: [],
    dependsOn: [],
    owner: 'An agent',
  });
  assert.deepEqual(model.prerequisites, [
    { key: 'p1', title: 'DNS', status: 'blocked', reason: null, resolution: null },
  ]);
});

test('changeList describes task, requirement, prerequisite, budget and section changes', () => {
  const before = planDocumentModel(snapshot());
  const after = planDocumentModel(
    snapshot({
      requirements: [{ key: 'r2', description: 'Docs updated' }],
      prerequisites: [{ key: 'p1', title: 'DNS access', status: 'verified' }],
      tasks: [
        task('build', { kind: 'group', title: 'Build' }),
        task('code', { parent: 'build', title: 'Write the code', criteria: ['Tests pass'] }),
        task('docs', { title: 'Docs' }),
      ],
      budget: { toolCalls: 400, activeMinutes: 30 },
      sections: { summary: 'Ship it.', risks: [{ risk: 'Late', mitigation: 'Cut scope' }] },
    }),
  );
  assert.deepEqual(
    changeList(before, after, 'runtime').map(change => change.text),
    [
      'Added task “Docs”',
      'Removed task “Ship it”',
      'Renamed task “Write code” to “Write the code”',
      'Added requirement “Docs updated”',
      'Removed requirement “Site is live”',
      'Prerequisite “DNS access” is now verified',
      'Changed the tool calls budget from 300 to 400',
      'Removed the credits budget',
      'Updated the summary',
      'Added risk “Late”',
    ],
  );
  assert.ok(changeList(before, after, 'starter').every(change => change.origin === 'starter'));
  assert.deepEqual(changeList(before, before, 'runtime'), []);
});

test('stamps name the approval state in the reader time zone', () => {
  const approval = { approverName: 'Asha', approvedAt: '2026-09-14T08:05:00Z' };
  assert.equal(stampText({ contentRevision: 2, timeZone: 'UTC' }), 'Draft, not approved');
  assert.equal(
    stampText({ approval, contentRevision: 4, approvedRevision: 4, timeZone: 'Europe/London' }),
    'Approved by Asha, 14 Sep 2026, 09:05 BST, revision 4',
  );
  assert.equal(
    stampText({ approval, contentRevision: 4, timeZone: 'America/New_York' }),
    'Approved by Asha, 14 Sep 2026, 04:05 EDT, revision 4',
  );
  assert.equal(
    stampText({ approval, contentRevision: 4, timeZone: 'Not/AZone' }),
    'Approved by Asha, 14 Sep 2026, 08:05 UTC, revision 4',
  );
  assert.deepEqual(planStamp({ approval, contentRevision: 6, approvedRevision: 4, timeZone: 'UTC' }), {
    tone: 'changed',
    text: 'Changed since approval: revision 6, approved revision 4',
  });
});

test('markdown escapes all HTML before adding its small subset of markup', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(
    renderMarkdown(
      'Hello **bold** and *it* `<b>`\nsame para\n\n- one\n- [two](https://x.test/?a=1&b=2)\n\n1. first\n2. second',
    ),
    [
      '<p>Hello <strong>bold</strong> and <em>it</em> <code>&lt;b&gt;</code> same para</p>',
      '<ul><li>one</li><li><a href="https://x.test/?a=1&amp;b=2" rel="noopener noreferrer">two</a></li></ul>',
      '<ol><li>first</li><li>second</li></ol>',
    ].join('\n'),
  );
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(
    renderMarkdown('[a](https://x.test/"onmouseover=1)'),
    '<p><a href="https://x.test/&quot;onmouseover=1" rel="noopener noreferrer">a</a></p>',
  );
});

test('the document is self-contained, ordered, escaped and omits empty sections', () => {
  const model = planDocumentModel(
    snapshot({
      title: 'Launch <script>',
      sections: {
        summary: 'Sum',
        risks: [{ risk: 'Late <b>', mitigation: 'Cut scope' }],
        diagrams: [{ key: 'flow', title: 'Flow', mermaid: 'flowchart LR\n  a --> b' }],
      },
    }),
  );
  const html = renderPlanDocumentHtml(model, {
    diagramSvgs: { plan: '<svg id="plan-svg"></svg>', flow: null },
    stamp: { tone: 'draft', text: 'Draft, not approved' },
  });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`));
  assert.ok(!/<script|<link|@import|https?:\/\//i.test(html));
  assert.ok(html.includes('Launch &lt;script&gt;') && html.includes('Late &lt;b&gt;'));
  assert.ok(html.includes('<svg id="plan-svg"></svg>'));
  assert.ok(html.includes("This diagram couldn't be drawn.") && html.includes('flowchart LR\n  a --&gt; b'));
  const order = [
    'summary',
    'requirements',
    'plan-diagram',
    'tasks',
    'prerequisites',
    'risks',
    'diagrams',
    'budget',
  ].map(id => html.indexOf(`id="${id}"`));
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    String(order),
  );
  for (const id of ['approach', 'changes']) assert.ok(!html.includes(`id="${id}"`), id);
  assert.ok(html.includes('tone-draft'));
});

test('tasks keep the plan order, with loose tasks between groups in their own block', () => {
  const model = planDocumentModel(
    snapshot({
      tasks: [
        task('first', { title: 'Task first' }),
        task('build', { kind: 'group', title: 'Group build' }),
        task('code', { parent: 'build', title: 'Task code' }),
        task('between', { title: 'Task between' }),
        task('check', { kind: 'group', title: 'Group check' }),
        task('verify', { parent: 'check', title: 'Task verify' }),
        task('last', { title: 'Task last' }),
      ],
    }),
  );
  const html = renderPlanDocumentHtml(model, { diagramSvgs: { plan: null }, stamp: { tone: 'draft', text: '' } });
  const tasks = html.slice(html.indexOf('id="tasks"'), html.indexOf('id="prerequisites"'));
  const order = ['first', 'build', 'code', 'between', 'check', 'verify', 'last'].map(key =>
    tasks.indexOf(key === 'build' || key === 'check' ? `Group ${key}` : `Task ${key}`),
  );
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    String(order),
  );
  assert.equal(tasks.match(/class="group-head"/g).length, 2, 'loose tasks get no heading of their own');
  assert.equal(tasks.match(/class="group"/g).length, 5);
});

test('markdown headings become bold lead-in lines rather than competing headings', () => {
  const html = renderMarkdown('## Rollout *plan*\nShip in two steps.');
  assert.ok(!/<h\d/.test(html));
  assert.equal(html, '<p class="lead-in"><strong>Rollout <em>plan</em></strong></p>\n<p>Ship in two steps.</p>');
});

test('the printed document has no page background', () => {
  const html = renderPlanDocumentHtml(planDocumentModel(snapshot()), {
    diagramSvgs: { plan: null },
    stamp: { tone: 'draft', text: '' },
  });
  assert.match(html, /@media print\s*\{\s*body\s*\{\s*background:\s*none;/);
});
