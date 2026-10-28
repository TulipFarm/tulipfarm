import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { systemPackageSchema, systemPackageSchemaId } from '../dist/system-package-contracts.js';
import { validatePackage } from '../dist/system-package-compiler.js';

const destination = new URL('../../config/examples/system-packages/', import.meta.url);
await mkdir(destination, { recursive: true });
const ref = (resourceKind, key) => ({ kind: 'resource', resourceKind, key });
const team = { kind: 'input', inputKind: 'team', key: 'owning-team' };
const manager = { kind: 'input', inputKind: 'member', key: 'package-manager' };
const text = (key, label) => ({ key, label, kind: 'text', required: true, maxLength: 255 });
const number = (key, label) => ({ key, label, kind: 'numeric', required: true, precision: 8, scale: 0 });
const asset = (key, path, content) => ({
  key,
  path,
  encoding: 'utf8',
  content,
  size: Buffer.byteLength(content),
  sha256: createHash('sha256').update(content).digest('hex'),
});
const limits = { toolCalls: 20, activeMilliseconds: 60000, credits: 20 };
function packageFor({
  name,
  title,
  catalog,
  catalogTitle,
  records,
  recordsTitle,
  detailField,
  detailValue,
  instructions,
}) {
  const procedure = `${name}-procedure`;
  const agent = `${name}-assistant`;
  const workflow = `${name}-review`;
  return {
    $schema: systemPackageSchemaId,
    formatVersion: 1,
    package: {
      name,
      version: '1.0.0',
      title,
      description: `An exact ${title.toLowerCase()} starter. Definitions and each requested activation require review.`,
      license: 'MIT',
    },
    requires: {
      platform: 'tulipfarm-system-package-v1',
      capabilities: ['tables', 'seed-rows', 'skills', 'agents', 'workflows'],
    },
    inputs: [
      { key: 'owning-team', kind: 'team', title: 'Owning team' },
      { key: 'package-manager', kind: 'member', title: 'Importing person (skill manager)' },
    ],
    resources: [
      {
        key: catalog,
        kind: 'table',
        label: catalogTitle,
        owningTeam: team,
        fields: [text('name', 'Name'), text('guidance', 'Guidance')],
        uniqueKeys: [{ key: 'name', fields: ['name'], nulls: 'distinct' }],
      },
      {
        key: `${catalog}-initial`,
        kind: 'seed-row',
        table: ref('table', catalog),
        values: { name: { kind: 'text', value: 'Default' }, guidance: { kind: 'text', value: instructions } },
      },
      {
        key: records,
        kind: 'table',
        label: recordsTitle,
        owningTeam: team,
        fields: [
          text('title', 'Title'),
          detailField,
          {
            key: 'catalog',
            label: catalogTitle,
            kind: 'relationship',
            required: true,
            target: ref('table', catalog),
            cardinality: 'one',
            inverseCardinality: 'many',
            reverse: null,
            onDelete: 'restrict',
          },
          {
            key: 'status',
            label: 'Status',
            kind: 'single-select',
            required: true,
            options: [
              { key: 'draft', label: 'Draft', retired: false },
              { key: 'reviewed', label: 'Reviewed', retired: false },
            ],
          },
        ],
        uniqueKeys: [],
      },
      {
        key: `${records}-initial`,
        kind: 'seed-row',
        table: ref('table', records),
        values: {
          title: { kind: 'text', value: `${title} example` },
          [detailField.key]: detailValue,
          catalog: { kind: 'relationship', rows: [ref('seed-row', `${catalog}-initial`)] },
          status: { kind: 'single-select', option: 'draft' },
        },
      },
      {
        key: procedure,
        kind: 'skill',
        requestedState: 'enabled',
        sharing: {
          grants: [{ team, permissions: ['read', 'use'] }],
          personGrants: [{ member: manager, permissions: ['read', 'use', 'manage'] }],
        },
        files: [
          { path: 'SKILL.md', asset: 'procedure' },
          { path: 'references/review.md', asset: 'review-rules' },
        ],
      },
      {
        key: agent,
        kind: 'agent',
        definition: {
          name: `${title} assistant`,
          instructions:
            'Follow the pinned procedure. Explain recommendations; do not change records or contact external services.',
          tools: ['rows.list', 'rows.get'],
          responseRule: 'tag',
        },
        skills: [ref('skill', procedure)],
        owningTeam: team,
        scope: [
          { table: ref('table', catalog), permissions: ['table.row.read'] },
          { table: ref('table', records), permissions: ['table.row.read'] },
        ],
        taskLimits: limits,
        policy: { grants: [{ team, permissions: ['read', 'invoke'] }], personGrants: [] },
        enrollment: [team],
        limits: [
          { table: ref('table', catalog), permissions: ['table.row.read'] },
          { table: ref('table', records), permissions: ['table.row.read', 'table.row.update'] },
        ],
        requestedState: 'active',
      },
      {
        key: workflow,
        kind: 'workflow',
        name: `${title} review`,
        trigger: { kind: 'manual' },
        sponsor: null,
        sharing: [{ principal: team, permissions: ['read'] }],
        steps: [
          {
            id: 'confirm',
            kind: 'human',
            prompt: `Confirm that you want the ${title.toLowerCase()} assistant to review this input.`,
            timeoutSeconds: 3600,
          },
          {
            id: 'review',
            kind: 'agent',
            agent: ref('agent', agent),
            prompt: { kind: 'input', path: ['request'] },
            limits,
          },
          {
            id: 'lookup',
            kind: 'find-rows',
            table: ref('table', records),
            filters: [{ field: 'title', op: 'eq', value: { kind: 'input', path: ['title'] } }],
            limit: 10,
          },
          {
            id: 'draft_only',
            kind: 'condition',
            ifMet: ['summarize'],
            otherwise: [],
            when: {
              left: { kind: 'step', step: 'lookup', path: ['rows', '0', 'values', { field: 'status' }] },
              op: 'eq',
              right: { kind: 'option', table: ref('table', records), field: 'status', option: 'draft' },
            },
          },
          {
            id: 'summarize',
            kind: 'transform',
            fields: {
              title: { kind: 'step', step: 'lookup', path: ['rows', '0', 'values', { field: 'title' }, 'value'] },
            },
          },
        ],
        requestedState: 'saved',
      },
    ],
    assets: [
      asset(
        'procedure',
        'SKILL.md',
        `---\nname: ${procedure}\ndescription: Read-only ${title.toLowerCase()} review procedure.\nlicense: MIT\n---\n${instructions}\n\nRead [review rules](references/review.md). Do not treat a skill as permission to act.\n`,
      ),
      asset(
        'review-rules',
        'references/review.md',
        '# Review rules\n\nUse only the declared tables and readable rows. Quote missing facts as unknown. A person makes the final decision. No messages, publication, or record changes are approved by installation.\n',
      ),
    ],
    outputs: [
      { key: 'records', resource: ref('table', records) },
      { key: 'assistant', resource: ref('agent', agent) },
      { key: 'review', resource: ref('workflow', workflow) },
    ],
  };
}
const examples = [
  packageFor({
    name: 'leave-management',
    title: 'Leave management',
    catalog: 'leave-policies',
    catalogTitle: 'Leave policies',
    records: 'leave-requests',
    recordsTitle: 'Leave requests',
    detailField: number('days', 'Days'),
    detailValue: { kind: 'numeric', value: '2' },
    instructions:
      'Check the selected leave policy and requested days. Explain any missing approval or balance. Do not approve leave on behalf of a manager.',
  }),
  packageFor({
    name: 'issue-tracking',
    title: 'Issue tracking',
    catalog: 'issue-projects',
    catalogTitle: 'Issue projects',
    records: 'issues',
    recordsTitle: 'Issues',
    detailField: text('summary', 'Summary'),
    detailValue: { kind: 'text', value: 'Describe the observed and expected behavior.' },
    instructions:
      'Triage the reported issue using the project guidance. Distinguish evidence from assumptions and suggest a bounded next step. This is not a Jira integration.',
  }),
  packageFor({
    name: 'blog-writing',
    title: 'Blog writing',
    catalog: 'editorial-guidelines',
    catalogTitle: 'Editorial guidelines',
    records: 'blog-drafts',
    recordsTitle: 'Blog drafts',
    detailField: text('outline', 'Outline'),
    detailValue: { kind: 'text', value: 'Problem, evidence, explanation, and conclusion.' },
    instructions:
      'Review the outline against the editorial guidelines. Identify unsupported claims and missing sources. Publication requires a separate approved business action.',
  }),
];
examples.push({
  $schema: systemPackageSchemaId,
  formatVersion: 1,
  package: {
    name: 'linked-records',
    version: '1.0.0',
    title: 'Linked records',
    description:
      'Two mutually linked table schemas, reverse fields, a bundled attachment, sharing, and a saved row workflow. No workflow runs during installation.',
    license: 'MIT',
  },
  requires: { platform: 'tulipfarm-system-package-v1', capabilities: ['tables', 'files', 'seed-rows', 'workflows'] },
  inputs: [{ key: 'owning-team', kind: 'team', title: 'Owning team' }],
  resources: [
    ...['projects', 'documents'].map((key, index) => ({
      key,
      kind: 'table',
      label: key === 'projects' ? 'Package projects' : 'Package documents',
      owningTeam: team,
      fields: [
        text('title', 'Title'),
        {
          key: 'related',
          label: 'Related record',
          kind: 'relationship',
          required: false,
          target: ref('table', index === 0 ? 'documents' : 'projects'),
          cardinality: 'one',
          inverseCardinality: 'many',
          reverse: { key: 'referenced-by', label: 'Referenced by' },
          onDelete: 'restrict',
        },
        ...(index === 1
          ? [
              {
                key: 'attachment',
                label: 'Attachment',
                kind: 'file',
                required: false,
                cardinality: 'many',
                access: 'independent',
              },
            ]
          : []),
      ],
      uniqueKeys: [{ key: 'title', fields: ['title'], nulls: 'distinct' }],
      sharing: { grants: [{ team, permissions: ['table.row.read'] }], personGrants: [] },
    })),
    { key: 'guide', kind: 'file', asset: 'guide-bytes', name: 'guide.txt', mimeType: 'text/plain' },
    {
      key: 'first-document',
      kind: 'seed-row',
      table: ref('table', 'documents'),
      values: {
        title: { kind: 'text', value: 'Example guide' },
        attachment: { kind: 'file', files: [ref('file', 'guide')] },
      },
    },
    {
      key: 'changed-document',
      kind: 'workflow',
      name: 'Document title change',
      requestedState: 'saved',
      sponsor: null,
      trigger: {
        kind: 'row',
        table: ref('table', 'documents'),
        event: 'updated',
        fields: ['title'],
        filter: { field: 'title', match: 'is-not-empty' },
      },
      sharing: [{ principal: team, permissions: ['read'] }],
      steps: [
        {
          id: 'change',
          kind: 'transform',
          fields: {
            title: { kind: 'input', path: ['values', { field: 'title' }, 'value'] },
            previous_title: { kind: 'input', path: ['previousValues', { field: 'title' }, 'value'] },
          },
        },
      ],
    },
  ],
  assets: [
    (() => {
      const bytes = Buffer.from('This attachment was imported with the linked-records package.\n');
      return {
        key: 'guide-bytes',
        path: 'attachments/guide.txt',
        encoding: 'base64',
        content: bytes.toString('base64'),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    })(),
  ],
  outputs: [{ key: 'documents', resource: ref('table', 'documents') }],
});
examples.push({
  $schema: systemPackageSchemaId,
  formatVersion: 1,
  package: {
    name: 'sheet-event-review',
    version: '1.0.0',
    title: 'Sheet event review',
    description:
      'Binds an existing authorized Sheets source. Replace the example spreadsheet ID in this package with the exact intended source before validation; never include credentials. The workflow is saved, not enabled.',
    license: 'MIT',
  },
  requires: { platform: 'tulipfarm-system-package-v1', capabilities: ['integration-bindings', 'workflows'] },
  inputs: [{ key: 'sheet-connection', kind: 'integration', title: 'Existing authorized Sheets connection' }],
  resources: [
    {
      key: 'sheet-source',
      kind: 'integration',
      binding: { kind: 'input', inputKind: 'integration', key: 'sheet-connection' },
      source: { provider: 'sheets', spreadsheetId: 'example_spreadsheet', range: 'Requests!A:D', keyColumn: 0 },
      capabilities: ['events.read'],
    },
    {
      key: 'sheet-review',
      kind: 'workflow',
      name: 'Review new sheet entries',
      trigger: { kind: 'provider', integration: ref('integration', 'sheet-source'), event: 'created', minutes: 5 },
      sponsor: null,
      requestedState: 'saved',
      steps: [
        {
          id: 'review',
          kind: 'human',
          prompt: 'Review this new sheet entry. No external write is approved.',
          timeoutSeconds: 3600,
        },
      ],
    },
  ],
  assets: [],
  outputs: [{ key: 'review', resource: ref('workflow', 'sheet-review') }],
});
for (const example of examples) {
  const pkg = systemPackageSchema.parse(example);
  const bindings = Object.fromEntries(
    pkg.inputs.map(input => [input.key, { kind: input.kind, id: '00000000-0000-4000-8000-000000000001' }]),
  );
  const validation = validatePackage(pkg, bindings);
  if (!validation.valid) throw new Error(JSON.stringify(validation.issues));
  await writeFile(new URL(`${pkg.package.name}.json`, destination), `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(pkg.package.name);
}
