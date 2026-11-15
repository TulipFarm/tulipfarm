import { z } from 'zod';

export const appIdSchema = z.uuid().brand<'AppId'>();
export type AppId = z.infer<typeof appIdSchema>;

export const releaseIdSchema = z.uuid().brand<'AppReleaseId'>();
export type AppReleaseId = z.infer<typeof releaseIdSchema>;

export const versionIdSchema = z.uuid().brand<'AppVersionId'>();
export type AppVersionId = z.infer<typeof versionIdSchema>;

export const buildIdSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .brand<'AppBuildId'>();
export type AppBuildId = z.infer<typeof buildIdSchema>;

export const operationIdSchema = z.uuid().brand<'AppOperationId'>();
export type AppOperationId = z.infer<typeof operationIdSchema>;

export const commitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .brand<'GitCommit'>();
export type GitCommit = z.infer<typeof commitSchema>;

export const generationSchema = z.number().int().nonnegative().brand<'AppGeneration'>();
export type AppGeneration = z.infer<typeof generationSchema>;

export const membershipIdSchema = z.uuid().brand<'MembershipId'>();
export type MembershipId = z.infer<typeof membershipIdSchema>;
