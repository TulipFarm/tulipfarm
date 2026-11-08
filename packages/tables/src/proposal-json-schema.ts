import { z } from 'zod';
import { toJsonSchema } from './json-schema.ts';
import {
  archivePlanSchema,
  importPlanSchema,
  proposalPlansSchema,
  restorePlanSchema,
  schemaPlanSchema,
} from './proposal-contracts.ts';
import { transformOutputsSchema } from './transforms.ts';

/**
 * The `tables.propose` input shown to models, with the same label and numeric rules as table.v1.json. Chat adds rows
 * with the row tools, so records plans are left out; `proposeTableSchema` still validates every plan kind. Transforms
 * show their expression structure; their raw-input bounds are checked only by Zod.
 */
export function tableProposalJsonSchema() {
  return toJsonSchema(
    z.strictObject({
      plans: proposalPlansSchema(
        z.discriminatedUnion('kind', [
          schemaPlanSchema.extend({ transforms: transformOutputsSchema }),
          importPlanSchema,
          archivePlanSchema,
          restorePlanSchema,
        ]),
      ).meta({ description: 'Plans reviewed and applied in order. Add rows with the row tools, not with a plan.' }),
    }),
  );
}
