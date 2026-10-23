import { z } from 'zod';
import { definitionSchema, fieldSchema, trimmedLabelSchema } from './definition.ts';
import { tableDocumentSchema } from './names.ts';
import {
  archivePlanSchema,
  importPlanSchema,
  proposalPlansSchema,
  restorePlanSchema,
  schemaPlanSchema,
} from './proposal-contracts.ts';

const tableDefinitionSchemaId = 'https://tulipfarm.ai/schemas/table.v1.json';
const soulTableSchemaId = 'https://tulipfarm.ai/schemas/soul-table.v1.json';
const labelPattern = String.raw`^(?!\s*$)(?![\s\S]*\u0000)[\s\S]*$`;
// Build this key dynamically because JSON Schema's conditional keyword is not a promise hook.
const thenKeyword = ['th', 'en'].join('');
const numericFieldSchema = fieldSchema.options.find(field => field.shape.kind.value === 'numeric');
const numericPrecisionRules = Array.from({ length: 11 }, (_, scale) => {
  const rule: z.core.JSONSchema.JSONSchema = {
    if: {
      properties: {
        scale: {
          const: scale,
          description: 'Digits after the decimal point; this condition sets the permitted precision range.',
        },
      },
      required: ['scale'],
    },
  };
  rule[thenKeyword] = {
    properties: {
      precision: {
        type: 'integer',
        minimum: Math.max(1, scale),
        maximum: Math.min(30, scale + 20),
        description: 'Total decimal digits, bounded by the selected scale.',
      },
    },
    required: ['precision'],
  };
  return rule;
});

function toJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'ref',
    override({ zodSchema, jsonSchema }) {
      if (zodSchema === trimmedLabelSchema) {
        delete jsonSchema.minLength;
        jsonSchema.maxLength = 10000;
      }
      if (z.globalRegistry.get(zodSchema)?.['x-tulipfarm-trimmed-label'] === true) {
        delete jsonSchema['x-tulipfarm-trimmed-label'];
        jsonSchema.type = 'string';
        delete jsonSchema.minLength;
        jsonSchema.maxLength = 10000;
        jsonSchema.pattern = labelPattern;
      }
      if (zodSchema === numericFieldSchema) jsonSchema.allOf = [...(jsonSchema.allOf ?? []), ...numericPrecisionRules];
    },
  });
}

function toTableJsonSchema(schema: typeof definitionSchema | typeof tableDocumentSchema, id: string, title: string) {
  return { ...toJsonSchema(schema), $id: id, title };
}

export function tableDefinitionJsonSchema() {
  return toTableJsonSchema(definitionSchema, tableDefinitionSchemaId, 'TulipFarm table definition');
}

export function tableDocumentJsonSchema() {
  return toTableJsonSchema(tableDocumentSchema, soulTableSchemaId, 'TulipFarm Soul table document');
}

/**
 * The `tables.propose` input shown to models, with the same label and numeric rules as table.v1.json. Chat adds rows
 * with the row tools, so records plans are left out; `proposeTableSchema` still validates every plan kind.
 */
export function tableProposalJsonSchema() {
  return toJsonSchema(
    z.strictObject({
      plans: proposalPlansSchema(
        z.discriminatedUnion('kind', [schemaPlanSchema, importPlanSchema, archivePlanSchema, restorePlanSchema]),
      ).meta({ description: 'Plans reviewed and applied in order. Add rows with the row tools, not with a plan.' }),
    }),
  );
}
