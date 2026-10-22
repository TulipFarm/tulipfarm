import { writeFileSync } from 'node:fs';
import { appSchema, developmentBuild, productionBuildSchema } from './src/index.ts';

const [app, output, mode, ...extra] = process.argv.slice(2);
if (!output || (mode !== undefined && mode !== '--local') || extra.length)
  throw new Error('Usage: generate.mjs APP OUTPUT [--local]');
const build =
  mode === '--local'
    ? developmentBuild(appSchema.parse(app))
    : productionBuildSchema.parse({ app, version: process.env.RELEASE_VERSION, commit: process.env.RELEASE_COMMIT });
writeFileSync(output, JSON.stringify(build) + '\n');
