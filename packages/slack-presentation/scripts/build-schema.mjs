import { createGenerator } from 'ts-json-schema-generator';
import { Ajv } from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { writeFile } from 'node:fs/promises';

const schema = createGenerator({
  path: 'src/surfaces.ts',
  tsconfig: 'tsconfig.json',
  type: 'SlackSurface',
  additionalProperties: false,
}).createSchema('SlackSurface');
const ajv = new Ajv({ strict: false, strictNumbers: true, code: { source: true, esm: true }, allErrors: false });
ajv.addSchema(schema, 'surface');
await writeFile('dist/block-schema.js', standaloneCode(ajv, { validateSurface: 'surface' }));
