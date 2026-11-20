/** Source paths that change how the chat agent behaves in every suite. */
export const chatPaths = [
  'packages/agents/src/inference.ts',
  'packages/agents/src/prompts.ts',
  'packages/agents/src/tools.ts',
  'packages/agents/src/tool-capabilities.ts',
  'packages/agents/src/model.ts',
  'packages/agents/src/plan-sessions.ts',
  'packages/config/catalog/models.json',
  'packages/evals/',
];

/** The same pinned result for every knowledge read, since the agent may choose any of them. */
export const knowledgePins = result =>
  ['knowledge.search', 'knowledge.retrieve', 'knowledge.read'].map(tool => ({ tool, result }));

const leadsId = '5f0c3c1e-7d4a-4a51-9b55-2f4a51e0c001';
const leadsRevision = '3b1f0e9c2d4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c';
const leadsFields = ['Name', 'Stage', 'Notes'].map((name, index) => ({
  id: `5f0c3c1e-7d4a-4a51-9b55-2f4a51e0f00${index + 1}`,
  name,
  type: 'text',
  selector: name.toLowerCase(),
  operators: ['==', '!=', '=like='],
  sortable: true,
}));

/** A Leads table with `rows` (keyed by field name), pinned for every table, schema and row read the agent may choose. */
export const leadsPins = rows => {
  const table = {
    id: leadsId,
    name: 'Leads',
    appliedRevision: leadsRevision,
    rowCount: rows.length,
    fields: leadsFields,
  };
  const schema = {
    tableId: leadsId,
    status: 'applied',
    savedRevision: leadsRevision,
    appliedRevision: leadsRevision,
    fields: leadsFields,
  };
  const typed = rows.map((row, index) => ({
    id: `5f0c3c1e-7d4a-4a51-9b55-2f4a51e0a00${index + 1}`,
    token: `token-${index + 1}`,
    values: Object.fromEntries(leadsFields.map(field => [field.id, row[field.name] ?? null])),
  }));
  return [
    ...['tables.list', 'tables.definitions'].map(tool => ({ tool, result: { tables: [table], nextCursor: null } })),
    ...['schema.inspect', 'schema.status', 'schema.context'].map(tool => ({ tool, result: schema })),
    ...['rows.list', 'rows.page'].map(tool => ({
      tool,
      result: { tableId: leadsId, revision: leadsRevision, total: typed.length, rows: typed, nextCursor: null },
    })),
    {
      tool: 'rows.summarize',
      result: {
        tableId: leadsId,
        revision: leadsRevision,
        groups: [{ keys: [], values: [typed.length] }],
        groupCount: 1,
      },
    },
  ];
};
