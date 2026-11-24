import { z } from 'zod';
import { grantSchema } from '@tulipfarm/secrets/contracts';
import { browserSiteSchema } from './contracts.ts';

export const browserLoginNameSchema = z.string().trim().min(1).max(80);

export const saveBrowserLoginSchema = z.strictObject({ name: browserLoginNameSchema, site: browserSiteSchema });
export type SaveBrowserLogin = z.input<typeof saveBrowserLoginSchema>;

export const shareBrowserLoginSchema = z.strictObject({ grants: z.array(grantSchema).max(50) });

/**
 * `needs-sign-in`: a session ended signed out, so its owner should sign in again. `suspended`: its owner left the
 * workspace, so nobody can use it.
 */
export const browserLoginStatusSchema = z.enum(['active', 'needs-sign-in', 'suspended']);
export type BrowserLoginStatus = z.infer<typeof browserLoginStatusSchema>;

export const browserLoginSummarySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  site: z.string(),
  ownerMembershipId: z.uuid(),
  status: browserLoginStatusSchema,
  /** Whom the login is shared with. Only those who may manage it see this. */
  grants: z.array(grantSchema),
  canManage: z.boolean(),
  canUse: z.boolean(),
  createdAt: z.string(),
  savedAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type BrowserLoginSummary = z.infer<typeof browserLoginSummarySchema>;

export const browserLoginErrorCodeSchema = z.enum(['disabled', 'invalid-input', 'unavailable', 'too-large']);
export type BrowserLoginErrorCode = z.infer<typeof browserLoginErrorCodeSchema>;

export class BrowserLoginError extends Error {
  readonly code: BrowserLoginErrorCode;
  constructor(code: BrowserLoginErrorCode, message: string = code) {
    super(message);
    this.name = 'BrowserLoginError';
    this.code = code;
  }
}
