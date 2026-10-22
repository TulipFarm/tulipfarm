export const relevanceCases = [
  {
    category: 'identifier',
    title: 'Incident OPS-731',
    text: 'Escalate OPS-731 to the operations lead.',
    query: 'OPS-731',
    expectedTitle: 'Incident OPS-731',
  },
  {
    category: 'path',
    title: 'Deployment paths',
    text: 'Update src/billing/reconcile.ts before release.',
    query: 'src/billing/reconcile.ts',
    expectedTitle: 'Deployment paths',
  },
  {
    category: 'phrase',
    title: 'Refund policy',
    text: 'A damaged parcel qualifies for a full refund within thirty days.',
    query: '"full refund"',
    expectedTitle: 'Refund policy',
  },
  {
    category: 'table',
    title: 'Carrier schedule',
    text: '| Carrier | Cutoff |\n|---|---|\n| Parcel Express | Thursday noon |',
    query: '"Thursday noon"',
    expectedTitle: 'Carrier schedule',
  },
  {
    category: 'private',
    title: 'Private contract',
    text: 'The private supplier rebate is confidential.',
    query: '"supplier rebate"',
    expectedTitle: 'Private contract',
  },
];

export const judgmentStatus =
  'Agent-authored deterministic regression expectations, not representative human judgments or a held-out relevance release set.';
