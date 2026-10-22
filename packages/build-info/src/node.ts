import { readFileSync } from 'node:fs';
import { buildInfoSchema, developmentBuild, productionBuildSchema, type App } from './index.ts';

export function readBuildInfo(app: App, file: URL, production = process.env.NODE_ENV === 'production') {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    if (!production && error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return developmentBuild(app);
    throw new Error(`Missing build identity for ${app}`, { cause: error });
  }
  const build = (production ? productionBuildSchema : buildInfoSchema).parse(JSON.parse(contents));
  if (build.app !== app) throw new Error(`Build identity does not belong to ${app}`);
  return Object.freeze(build);
}
