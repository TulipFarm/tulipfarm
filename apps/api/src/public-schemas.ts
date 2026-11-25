import { z } from 'zod';
import { recordQuerySchema, valueSchema } from '@tulipfarm/tables/definition';
import { runAgentSchema } from './external-api.ts';

/**
 * Request and response documentation for the public API. The routes validate with the Zod schemas in
 * `external-api.ts`; these JSON Schemas describe the same shapes in OpenAPI, with examples, so a developer or an
 * agent can write a correct request without learning it from error messages.
 */
const openapi = { target: 'openapi-3.0', unrepresentable: 'any', io: 'input' } as const;
const fieldA = '0b6f8a52-3c1e-4f7d-9a2b-5e8c1d4f6a70';
const fieldB = '7d2e9c41-8a5b-4c3f-b1e6-2f9a0d7c5b18';
const fieldC = 'c4a1f7e3-6b2d-4e8a-9f05-1d3c8b7a2e64';
const optionId = '5f3b2a19-7c8e-4d6a-b4f1-9e0c3a2d8b57';

export const valueJson = {
  ...z.toJSONSchema(valueSchema, openapi),
  description:
    'One field value, tagged with the field kind from describe table. Numbers, dates and timestamps are strings ' +
    '("12.50", "2026-11-25", "2026-11-25T09:30:00Z"). Select fields take option ids from the field definition. ' +
    'Send null to clear a field.',
};

export const valuesJson = {
  type: 'object',
  description:
    'Field id → value. Read the field ids and kinds from `GET /tables/{tableId}`. Fields you leave out are left ' +
    'unchanged on update and empty on create.',
  maxProperties: 64,
  additionalProperties: valueJson,
  example: {
    [fieldA]: { kind: 'text', value: 'Ada Lovelace' },
    [fieldB]: { kind: 'numeric', value: '12.50' },
    [fieldC]: { kind: 'single-select', optionId },
  },
};

export const createRowsBody = {
  type: 'object',
  description: 'Up to 100 rows. A row may name its own UUID `id`; otherwise the id comes from the Idempotency-Key.',
  properties: {
    rows: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, values: valuesJson },
        required: ['values'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
  example: { rows: [{ values: valuesJson.example }] },
};

export const updateRowBody = {
  type: 'object',
  properties: {
    expectedToken: {
      type: 'string',
      format: 'uuid',
      description: "The row's current `token` from get row or query rows. A stale token returns 409 stale-record.",
    },
    values: valuesJson,
  },
  required: ['expectedToken', 'values'],
  additionalProperties: false,
  example: {
    expectedToken: '1c9e4b27-0d3a-4f58-8e61-7b2a9c4d0f13',
    values: { [fieldB]: { kind: 'numeric', value: '14.00' } },
  },
};

export const deleteRowBody = {
  type: 'object',
  properties: { expectedToken: updateRowBody.properties.expectedToken },
  required: ['expectedToken'],
  additionalProperties: false,
  example: { expectedToken: '1c9e4b27-0d3a-4f58-8e61-7b2a9c4d0f13' },
};

export const filtersDescription =
  'Each filter is {fieldId, op, value} with op eq, ne, lt, lte, gt or gte, or {fieldId, op} with op is-null or ' +
  'not-null. A filter value is a plain string, boolean or null, not a tagged value: numbers and dates are strings ' +
  '("12.50", "2026-11-25") and a single-select filter takes the option id.';

export const queryRowsBody = {
  ...z.toJSONSchema(recordQuerySchema, openapi),
  description:
    `${filtersDescription} \`search\` matches text in any field. \`sort\` is {fieldId, direction}. Pass the ` +
    'previous `nextCursor` as `after` with the same filters, search and sort to read the next page.',
  example: {
    filters: [
      { fieldId: fieldB, op: 'gte', value: '10' },
      { fieldId: fieldC, op: 'eq', value: optionId },
    ],
    sort: { fieldId: fieldA, direction: 'asc' },
    limit: 25,
  },
};

export const runAgentBody = {
  ...z.toJSONSchema(runAgentSchema, openapi),
  example: { text: 'Summarise the open orders from this week and flag any over $500.' },
};

export const binaryBody = { type: 'string', format: 'binary', description: 'The raw file bytes, 1 byte to 10 MiB.' };

const rowJson = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    token: { type: 'string', format: 'uuid', description: 'Send as expectedToken to update or delete this row.' },
    values: {
      type: 'object',
      additionalProperties: true,
      description: 'Field id → value, in the same tagged shapes that writes take.',
    },
  },
  additionalProperties: true,
};

export const rowsPageJson = {
  description: 'One page of rows',
  type: 'object',
  properties: {
    rows: { type: 'array', items: rowJson },
    total: {
      type: 'integer',
      nullable: true,
      description: 'Matching rows, counted on the first page only (without `after`); null on later pages.',
    },
    nextCursor: { type: 'string', nullable: true, description: 'Pass as `after` for the next page; null at the end.' },
  },
  additionalProperties: true,
};

export const createRowsResultJson = {
  description:
    'One result per row, in order. Rows succeed or fail independently: check each `status`. A failed row has ' +
    '`error.code`, `error.message` and, when one field is at fault, `error.fieldId`.',
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['created', 'failed'] },
          row: rowJson,
          id: { type: 'string', format: 'uuid' },
          error: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' }, fieldId: { type: 'string' } },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};
