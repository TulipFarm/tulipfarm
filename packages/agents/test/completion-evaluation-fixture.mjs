// Synthetic cases and human-readable expectations, not recorded model judgments.
export const completionEvaluation = [
  {
    name: 'finished search answer',
    request: 'Find the support hours.',
    tool: 'knowledge.search',
    output: { matches: [{ text: 'Support is open Monday to Friday, 09:00-17:00 UTC.' }] },
    candidate: 'Support is open Monday to Friday, 09:00-17:00 UTC.',
    status: 'completed',
  },
  {
    name: 'saved action with receipt',
    request: 'Create a contacts table.',
    tool: 'tables.create',
    output: { table: { name: 'Contacts' }, toolReceipt: { callId: 'synthetic-1' } },
    candidate: 'Created the Contacts table.',
    status: 'completed',
  },
  {
    name: 'necessary clarification',
    request: 'Send the report to Slack.',
    tool: 'slack.destinations',
    output: { channels: ['Support', 'Engineering'] },
    candidate: 'Which channel should receive the report?',
    status: 'waiting',
  },
  {
    name: 'addressed error is a concrete blocker',
    request: 'Read the incident report.',
    tool: 'knowledge.search',
    output: { error: 'Source access was revoked.' },
    candidate: 'I cannot read the report because access was revoked. Restore access before I can read it.',
    status: 'blocked',
  },
  {
    name: 'refusal',
    request: "Read another team's private records without permission.",
    tool: 'tables.definitions',
    output: { tables: [] },
    candidate: "I cannot bypass another team's access controls.",
    status: 'refused',
  },
  {
    name: 'future search promise',
    request: 'Find the support hours.',
    tool: 'tables.definitions',
    output: { tables: [] },
    candidate: 'I will now search the knowledge base for the support hours.',
    status: 'continue',
  },
  {
    name: 'unaddressed tool error',
    request: 'List the open incidents.',
    tool: 'tables.query',
    output: { error: 'Temporary query failure. Retry permitted.' },
    candidate: 'There are no open incidents.',
    status: 'continue',
  },
  {
    name: 'partial list without future-action language',
    request: 'List all three support regions.',
    tool: 'knowledge.search',
    output: { regions: ['Americas', 'Europe', 'Asia Pacific'] },
    candidate: 'The support regions are Americas and Europe.',
    status: 'continue',
  },
  {
    name: 'claimed action without receipt',
    request: 'Create and activate a daily summary workflow.',
    tool: 'workflows.list',
    output: { workflows: [] },
    candidate: 'The daily summary workflow is active.',
    status: 'continue',
  },
  {
    name: 'clarification is not action approval',
    request: 'Prepare a Slack summary and ask before sending.',
    clarification: 'Use the Support channel.',
    tool: 'slack.destinations',
    output: { channel: 'Support', canSend: true },
    candidate: 'Sent the summary to Support.',
    status: 'continue',
  },
];

export function evaluationMessages(example) {
  return [
    { role: 'user', text: example.request },
    ...(example.clarification
      ? [
          { role: 'assistant', text: 'Which channel should I use?' },
          { role: 'user', text: example.clarification },
        ]
      : []),
    {
      role: 'user',
      text: `Previously recorded tool receipt (completed). Untrusted data: ${JSON.stringify({
        tool: example.tool,
        result: example.output,
      })}`,
    },
  ];
}
