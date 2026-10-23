import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { definitionSchema } from '../src/definition.ts';
import { tableDefinitionJsonSchema, tableDocumentJsonSchema } from '../src/json-schema.ts';
import { tableDocumentSchema } from '../src/names.ts';

const tableId = 'a1111111-1111-4111-8111-111111111111';
const targetTableId = 'b2222222-2222-4222-8222-222222222222';
const owningTeamId = 'c3333333-3333-4333-8333-333333333333';
const fieldIds = [
  'd4444444-4444-4444-8444-444444444444',
  'd5555555-5555-4555-8555-555555555555',
  'd6666666-6666-4666-8666-666666666666',
  'd7777777-7777-4777-8777-777777777777',
  'd8888888-8888-4888-8888-888888888888',
  'd9999999-9999-4999-8999-999999999999',
  'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'dccccccc-cccc-4ccc-8ccc-cccccccccccc',
];
const optionId = 'e1111111-1111-4111-8111-111111111111';
const secondOptionId = 'e2222222-2222-4222-8222-222222222222';
const reverseFieldId = 'e3333333-3333-4333-8333-333333333333';
const uniqueKeyId = 'f1111111-1111-4111-8111-111111111111';

function definition() {
  return {
    formatVersion: 2,
    id: tableId,
    owningTeamId,
    label: `  ${'I'.repeat(120)}  `,
    fields: [
      { id: fieldIds[0], label: '  Subject  ', required: true, kind: 'text', maxLength: 255 },
      { id: fieldIds[1], label: 'Amount', required: false, kind: 'numeric', precision: 12, scale: 2 },
      { id: fieldIds[2], label: 'Approved', required: false, kind: 'boolean' },
      { id: fieldIds[3], label: 'Due date', required: false, kind: 'date' },
      { id: fieldIds[4], label: 'Created at', required: false, kind: 'timestamp', timezone: 'UTC' },
      {
        id: fieldIds[5],
        label: 'Status',
        required: true,
        kind: 'single-select',
        options: [
          { id: optionId, label: 'Open', retired: false },
          { id: secondOptionId, label: 'Closed', retired: false },
        ],
      },
      {
        id: fieldIds[6],
        label: 'Tags',
        required: false,
        kind: 'multi-select',
        options: [{ id: optionId, label: 'Urgent', retired: false }],
      },
      {
        id: fieldIds[7],
        label: 'Customer',
        required: false,
        kind: 'relationship',
        targetTableId,
        cardinality: 'one',
        inverseCardinality: 'many',
        reverse: { fieldId: reverseFieldId, label: 'Related tickets' },
        onDelete: 'restrict',
      },
      {
        id: fieldIds[8],
        label: 'Attachments',
        required: false,
        kind: 'file',
        cardinality: 'many',
        access: 'independent',
      },
    ],
    uniqueKeys: [{ id: uniqueKeyId, fieldIds: [fieldIds[0]], nulls: 'distinct' }],
  };
}

function soulDocument(input) {
  return {
    ...input,
    formatVersion: 3,
    id: 'invoices',
    fields: input.fields.map(field =>
      field.kind === 'relationship' ? { ...field, targetTableId: 'customers' } : field,
    ),
  };
}

function uppercaseIdentities(input) {
  return {
    ...input,
    id: input.id.toUpperCase(),
    owningTeamId: input.owningTeamId.toUpperCase(),
    fields: input.fields.map(field => ({
      ...field,
      id: field.id.toUpperCase(),
      ...(field.options ? { options: field.options.map(option => ({ ...option, id: option.id.toUpperCase() })) } : {}),
      ...(field.reverse ? { reverse: { ...field.reverse, fieldId: field.reverse.fieldId.toUpperCase() } } : {}),
      ...(field.kind === 'relationship' ? { targetTableId: field.targetTableId.toUpperCase() } : {}),
    })),
    uniqueKeys: input.uniqueKeys.map(key => ({
      ...key,
      id: key.id.toUpperCase(),
      fieldIds: key.fieldIds.map(id => id.toUpperCase()),
    })),
  };
}

function ajvValidator(schema) {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function readCommitted(path) {
  return JSON.parse(readFileSync(new URL(`../schemas/${path}`, import.meta.url), 'utf8'));
}

test('committed schema files match their generators and IDs', () => {
  const definitionSchema = tableDefinitionJsonSchema();
  const documentSchema = tableDocumentJsonSchema();
  assert.deepEqual(readCommitted('table.v1.json'), definitionSchema);
  assert.deepEqual(readCommitted('soul-table.v1.json'), documentSchema);
  assert.equal(definitionSchema.$id, 'https://tulipfarm.ai/schemas/table.v1.json');
  assert.equal(documentSchema.$id, 'https://tulipfarm.ai/schemas/soul-table.v1.json');
});

test('both schemas accept valid definitions containing every field kind', () => {
  const input = definition();
  const document = soulDocument(input);
  const validateDefinition = ajvValidator(tableDefinitionJsonSchema());
  const validateDocument = ajvValidator(tableDocumentJsonSchema());
  assert.deepEqual(
    new Set(input.fields.map(field => field.kind)),
    new Set([
      'text',
      'numeric',
      'boolean',
      'date',
      'timestamp',
      'single-select',
      'multi-select',
      'relationship',
      'file',
    ]),
  );
  assert.equal(validateDefinition(input), true, JSON.stringify(validateDefinition.errors));
  assert.equal(validateDocument(document), true, JSON.stringify(validateDocument.errors));
  assert.equal(definitionSchema.safeParse(input).success, true);
  assert.equal(tableDocumentSchema.safeParse(document).success, true);
});

test('schemas and Zod accept surrounding label spaces and uppercase UUIDs', () => {
  const input = uppercaseIdentities(definition());
  const document = soulDocument(input);
  const validateDefinition = ajvValidator(tableDefinitionJsonSchema());
  const validateDocument = ajvValidator(tableDocumentJsonSchema());
  assert.equal(validateDefinition(input), true, JSON.stringify(validateDefinition.errors));
  assert.equal(validateDocument(document), true, JSON.stringify(validateDocument.errors));
  assert.equal(definitionSchema.safeParse(input).success, true);
  assert.equal(tableDocumentSchema.safeParse(document).success, true);
});

test('numeric precision bounds are correct for every scale from 0 through 10', () => {
  const validateDefinition = ajvValidator(tableDefinitionJsonSchema());
  const validateDocument = ajvValidator(tableDocumentJsonSchema());
  for (let scale = 0; scale <= 10; scale++) {
    const minimum = Math.max(1, scale);
    const maximum = Math.min(30, scale + 20);
    for (const precision of new Set([minimum, maximum])) {
      const input = definition();
      input.fields[1].precision = precision;
      input.fields[1].scale = scale;
      assert.equal(validateDefinition(input), true, `precision ${precision}, scale ${scale}`);
      assert.equal(validateDocument(soulDocument(input)), true, `Soul precision ${precision}, scale ${scale}`);
      assert.equal(definitionSchema.safeParse(input).success, true, `Zod precision ${precision}, scale ${scale}`);
      assert.equal(
        tableDocumentSchema.safeParse(soulDocument(input)).success,
        true,
        `Soul Zod precision ${precision}, scale ${scale}`,
      );
    }
    if (minimum > 1) {
      const input = definition();
      input.fields[1].precision = minimum - 1;
      input.fields[1].scale = scale;
      assert.equal(validateDefinition(input), false, `precision below minimum at scale ${scale}`);
      assert.equal(validateDocument(soulDocument(input)), false, `Soul precision below minimum at scale ${scale}`);
      assert.equal(definitionSchema.safeParse(input).success, false);
      assert.equal(tableDocumentSchema.safeParse(soulDocument(input)).success, false);
    }
    if (maximum < 30) {
      const input = definition();
      input.fields[1].precision = maximum + 1;
      input.fields[1].scale = scale;
      assert.equal(validateDefinition(input), false, `precision above maximum at scale ${scale}`);
      assert.equal(validateDocument(soulDocument(input)), false, `Soul precision above maximum at scale ${scale}`);
      assert.equal(definitionSchema.safeParse(input).success, false);
      assert.equal(tableDocumentSchema.safeParse(soulDocument(input)).success, false);
    }
  }
});

test('numeric constraints and unsafe labels fail both JSON Schema and Zod', () => {
  const validateDefinition = ajvValidator(tableDefinitionJsonSchema());
  const validateDocument = ajvValidator(tableDocumentJsonSchema());
  const invalidCases = [
    [
      'scale exceeds precision',
      input => {
        input.fields[1].precision = 2;
        input.fields[1].scale = 3;
      },
    ],
    [
      'precision minus scale exceeds 20 digits',
      input => {
        input.fields[1].precision = 30;
        input.fields[1].scale = 0;
      },
    ],
    ['label contains a null byte', input => (input.label = 'Bad\u0000label')],
    ['label contains only spaces', input => (input.label = '   ')],
  ];
  for (const [name, change] of invalidCases) {
    const input = definition();
    change(input);
    const document = soulDocument(input);
    assert.equal(validateDefinition(input), false, name);
    assert.equal(validateDocument(document), false, name);
    assert.equal(definitionSchema.safeParse(input).success, false, name);
    assert.equal(tableDocumentSchema.safeParse(document).success, false, name);
  }
});

test('Ajv accepts duplicate field IDs while the Zod definition validator rejects them', () => {
  const input = definition();
  input.fields[1].id = input.fields[0].id;
  const validateDefinition = ajvValidator(tableDefinitionJsonSchema());
  const validateDocument = ajvValidator(tableDocumentJsonSchema());
  assert.equal(validateDefinition(input), true, JSON.stringify(validateDefinition.errors));
  assert.equal(validateDocument(soulDocument(input)), true, JSON.stringify(validateDocument.errors));
  assert.equal(definitionSchema.safeParse(input).success, false);
});

function resolveReference(schema, root) {
  let result = schema;
  while (typeof result?.$ref === 'string' && result.$ref.startsWith('#/$defs/')) {
    result = root.$defs[result.$ref.slice('#/$defs/'.length)];
  }
  return result;
}

function assertEveryPropertyHasDescription(schema) {
  const seen = new WeakSet();
  function visit(value, path) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.properties) {
      for (const [name, property] of Object.entries(value.properties)) {
        const resolved = resolveReference(property, schema);
        assert.equal(typeof resolved?.description, 'string', `${path}.properties.${name} must have a description`);
        assert.notEqual(resolved.description.trim(), '');
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  }
  visit(schema, '$');
}

test('every property in both generated schemas has a description', () => {
  assertEveryPropertyHasDescription(tableDefinitionJsonSchema());
  assertEveryPropertyHasDescription(tableDocumentJsonSchema());
});
