import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { systemPackageSchema, systemPackageSchemaId } from '../dist/system-package-contracts.js';

const schema = z.toJSONSchema(systemPackageSchema, { target: 'draft-2020-12', io: 'input' });
schema.$id = systemPackageSchemaId;
schema.title = 'TulipFarm portable system package v1';
schema.description =
  'Exact declarative resource definitions. Validate with the companion semantic validator before workspace preflight. ' +
  'Semantic checks include key uniqueness, typed reference existence, dependency cycles, field and option mappings, ' +
  'domain refinements, asset byte sizes and SHA-256 digests, required capabilities, skill file safety and sponsor requirements. ' +
  'Schema defaults do not alter an imported document. Installation never executes package hooks.';
await writeFile(
  new URL('../../config/schemas/system-package.v1.json', import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
);
