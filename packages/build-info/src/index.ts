import { z } from 'zod';

export const appSchema = z.enum(['api', 'worker', 'storage-maintenance', 'snippet-broker', 'database', 'web']);
const version = z
  .string()
  .regex(/^\d{4}\.[1-9]\d?\.[1-9]\d?\.[1-9]\d*$/)
  .refine(value => {
    const [year, month, day] = value.split('.').map(Number);
    if (year === undefined || month === undefined || day === undefined) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  });
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const productionBuildSchema = z.object({ app: appSchema, version, commit }).strict();
// A build of a known commit that no release reservation allocated, such as a preview
// build. It names its source truthfully without claiming a release version.
export const unreleasedBuildSchema = z.object({ app: appSchema, version: z.literal('unreleased'), commit }).strict();
export const buildInfoSchema = z.union([
  productionBuildSchema,
  unreleasedBuildSchema,
  z.object({ app: appSchema, version: z.literal('development'), commit: z.literal('development') }).strict(),
]);
export type App = z.infer<typeof appSchema>;
export type BuildInfo = z.infer<typeof buildInfoSchema>;

export function developmentBuild(app: App): BuildInfo {
  return { app, version: 'development', commit: 'development' };
}

export function unreleasedBuild(app: App, sourceCommit: string): BuildInfo {
  return unreleasedBuildSchema.parse({ app, version: 'unreleased', commit: sourceCommit });
}
