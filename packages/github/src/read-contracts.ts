import { z } from 'zod';
export { githubReadSchema, type GitHubRead } from '@tulipfarm/access/github-read';
export { githubDownloadSchema, githubDownloadReceiptSchema, type GitHubDownload } from '@tulipfarm/access/github-read';
export const selectionSchema = z.strictObject({
  accountId: z.uuid().nullable(),
  generation: z.number().int().positive().nullable(),
  version: z.number().int().nonnegative(),
});
export const selectAccountSchema = z.strictObject({
  accountId: z.uuid().nullable(),
  expectedVersion: z.number().int().nonnegative(),
});
export class GitHubReadError extends Error {
  readonly code:
    | 'selection-required'
    | 'selection-conflict'
    | 'read-unavailable'
    | 'read-forbidden'
    | 'read-limit'
    | 'read-unqualified'
    | 'read-rate-limited';
  constructor(code: GitHubReadError['code']) {
    super(code);
    this.code = code;
  }
}
