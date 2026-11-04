// The sample plan the preview and the render worker's smoke check draw. Run after `pnpm build`.
import { changeList, planDocumentModel, planStamp } from '../dist/index.js';

const coordinator = { kind: 'coordinator' };
const researcher = { kind: 'specialist', name: 'Market researcher' };
const writer = { kind: 'specialist', name: 'Catalogue writer' };
const ops = { kind: 'agent', name: 'Wholesale ops' };

const tasks = [
  {
    key: 'research',
    kind: 'group',
    order: 'parallel',
    title: 'Research the buyers',
    brief: 'Know who buys and what they pay.',
  },
  {
    key: 'list-buyers',
    parent: 'research',
    title: 'List the 40 likeliest wholesale buyers',
    brief: 'Start from last season’s orders and the **garden centre** directory.',
    criteria: ['At least 40 buyers with a named contact', 'Each buyer tagged by region'],
    assignee: researcher,
  },
  {
    key: 'price-check',
    parent: 'research',
    title: 'Compare competitor wholesale prices',
    criteria: ['Prices for the 12 best-selling varieties', 'Sources recorded for every price'],
    assignee: researcher,
  },
  {
    key: 'build',
    kind: 'group',
    order: 'serial',
    title: 'Build the catalogue',
    brief: 'Write, price and lay out the spring range.',
    dependsOn: ['research'],
  },
  {
    key: 'set-prices',
    parent: 'build',
    title: 'Set wholesale prices and tiers',
    criteria: ['Margin of at least 35% at every tier'],
    assignee: coordinator,
  },
  {
    key: 'write-copy',
    parent: 'build',
    title: 'Write variety descriptions',
    brief: 'One short paragraph each: colour, height, flowering weeks.',
    criteria: ['All 48 varieties described', 'Plain English, no superlatives'],
    dependsOn: ['set-prices'],
    assignee: writer,
  },
  {
    key: 'layout',
    parent: 'build',
    title: 'Lay out the catalogue',
    criteria: ['A4 print-ready file', 'Order form on the last page'],
    dependsOn: ['write-copy'],
    assignee: writer,
  },
  { key: 'launch', kind: 'group', order: 'parallel', title: 'Launch', dependsOn: ['build'] },
  {
    key: 'send-catalogue',
    parent: 'launch',
    title: 'Email the catalogue to buyers',
    criteria: ['Sent to every listed buyer', 'Bounces followed up by phone'],
    dependsOn: ['list-buyers'],
    assignee: ops,
  },
  {
    key: 'track-orders',
    parent: 'launch',
    title: 'Track first-week orders',
    criteria: ['Daily order total shared in the chat'],
    dependsOn: ['send-catalogue'],
    assignee: ops,
  },
];

const base = {
  title: 'Launch the spring wholesale catalogue',
  brief: 'Get the spring range in front of our wholesale buyers by **1 March**, priced to protect margin.',
  starterName: 'Asha Patel',
  generatedAt: new Date('2026-11-04T04:00:00Z'),
  requirements: [
    { key: 'buyers', description: 'Every active wholesale buyer receives the catalogue.' },
    { key: 'margin', description: 'Each price tier keeps at least a 35% margin.' },
    { key: 'date', description: 'The catalogue goes out before 1 March.' },
  ],
  prerequisites: [
    { key: 'crm', title: 'Read access to the buyers table', status: 'verified' },
    {
      key: 'mail',
      title: 'Shared mailbox can send bulk email',
      status: 'blocked',
      reason: 'The mailbox is limited to 100 messages a day.',
      resolution: 'Send in two batches, a day apart.',
    },
    { key: 'photos', title: 'Spring photography is ready', status: 'unknown' },
  ],
  budget: { toolCalls: 400, activeMinutes: 90, credits: 350 },
  sections: {
    summary:
      'We will research our likeliest buyers and competitor prices, build a priced catalogue of the 48 spring varieties, and email it to every buyer before **1 March**. The plan ends once first-week orders are tracked.',
    approach: [
      'Research runs first and in parallel, because both pricing and the send list depend on it.',
      '',
      'The catalogue is then built *in order*:',
      '1. Set prices and tiers from the competitor comparison.',
      '2. Write one description per variety.',
      '3. Lay out a print-ready A4 file with an order form.',
      '',
      'Prices follow the `wholesale-pricing` skill. See the [pricing guide](https://tulipfarm.ai/docs) for tiers.',
    ].join('\n'),
    risks: [
      { risk: 'Photography is not ready in time.', mitigation: 'Use last season’s photos for repeat varieties.' },
      {
        risk: 'Competitors cut prices after we publish.',
        mitigation: 'Hold a 5% discount for buyers who ask before 15 March.',
      },
      {
        risk: 'Bulk email lands in spam.',
        mitigation: 'Send from the shared mailbox in two batches and phone the top 10 buyers.',
      },
    ],
    diagrams: [
      {
        key: 'order-flow',
        title: 'How a wholesale order moves',
        caption: 'From the buyer’s email reply to a confirmed delivery slot.',
        mermaid: [
          'sequenceDiagram',
          '  participant Buyer',
          '  participant Ops as Wholesale ops',
          '  participant Farm',
          '  Buyer->>Ops: Order form by email',
          '  Ops->>Farm: Check stock for each variety',
          '  Farm-->>Ops: Stock and cut dates',
          '  Ops-->>Buyer: Confirmation and delivery slot',
        ].join('\n'),
      },
    ],
  },
};

const approved = planDocumentModel({
  ...base,
  contentRevision: 4,
  tasks: tasks.map(task => (task.key === 'track-orders' ? { ...task, assignee: coordinator } : task)),
});
const current = planDocumentModel({ ...base, contentRevision: 5, tasks });
export const model = planDocumentModel({
  ...base,
  contentRevision: 5,
  tasks,
  approval: { approverName: 'Asha Patel', approvedAt: '2026-11-03T10:30:00Z', revision: 4 },
  changes: changeList(approved, current, 'starter'),
});
export const timeZone = 'Europe/London';
export const stamp = planStamp({
  approval: model.approval ?? undefined,
  contentRevision: model.contentRevision,
  approvedRevision: model.approval?.revision,
  timeZone,
});
