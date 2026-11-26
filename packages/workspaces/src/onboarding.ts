import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  onboardingDetailsSchema,
  onboardingDraftSchema,
  onboardingProfileSchema,
  type OnboardingDetails,
} from './onboarding-contracts.ts';

const rowSchema = z.object({
  id: z.uuid(),
  details: onboardingDetailsSchema,
  expires_at: z.date(),
});
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const draft = (value: unknown) => {
  const row = rowSchema.parse(value);
  return onboardingDraftSchema.parse({ id: row.id, details: row.details, expiresAt: row.expires_at.toISOString() });
};
export class OnboardingUnavailable extends Error {
  constructor() {
    super('This onboarding draft has expired or is unavailable. Start again.');
  }
}
export class OnboardingConflict extends Error {
  constructor() {
    super('These details changed. Save a new onboarding draft.');
  }
}

export async function workspaceUrlAvailable(pool: Pool, slug: string) {
  const result = await pool.query('SELECT EXISTS (SELECT 1 FROM app.workspaces WHERE slug = $1) AS taken', [slug]);
  return !z.object({ taken: z.boolean() }).parse(result.rows[0]).taken;
}

export async function saveOnboarding(pool: Pool, token: string, details: OnboardingDetails) {
  const hash = digest(token);
  const result = await pool.query(
    `INSERT INTO app.onboarding_drafts (token_hash, details)
    VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING RETURNING *`,
    [hash, details],
  );
  if (result.rows[0]) return draft(result.rows[0]);
  const existing = await pool.query(
    `SELECT * FROM app.onboarding_drafts
    WHERE token_hash = $1 AND claimed_by IS NULL AND expires_at > now()`,
    [hash],
  );
  if (!existing.rows[0]) throw new OnboardingUnavailable();
  const saved = draft(existing.rows[0]);
  if (JSON.stringify(saved.details) !== JSON.stringify(details)) throw new OnboardingConflict();
  return saved;
}

export async function resumeOnboarding(pool: Pool, token: string, userId: string) {
  const result = await pool.query(
    `UPDATE app.onboarding_drafts SET claimed_by = $2
    WHERE token_hash = $1 AND (claimed_by IS NULL OR claimed_by = $2) AND expires_at > now()
    RETURNING *`,
    [digest(token), userId],
  );
  if (!result.rows[0]) throw new OnboardingUnavailable();
  return draft(result.rows[0]);
}

export async function expireOnboarding(pool: Pool) {
  await pool.query(`DELETE FROM app.onboarding_drafts WHERE id IN
    (SELECT id FROM app.onboarding_drafts WHERE expires_at <= now() ORDER BY expires_at LIMIT 1000)`);
}

const savedProfileSchema = z.object({
  profile: onboardingProfileSchema,
  messages: onboardingDetailsSchema.shape.messages,
});
export type SavedOnboardingProfile = { workspaceName: string } & z.infer<typeof savedProfileSchema>;

/** Keeps what the creator told the onboarding chat with their new workspace. Retrying keeps the first copy. */
export async function keepOnboardingProfile(
  pool: Pool,
  workspaceId: string,
  userId: string,
  details: OnboardingDetails,
) {
  if (!details.profile) return;
  await pool.query(
    `INSERT INTO app.onboarding_profiles (workspace_id, user_id, profile, messages)
    SELECT w.id, $2, $3, $4 FROM app.workspaces w WHERE w.id = $1 AND w.created_by = $2
    ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId, userId, details.profile, JSON.stringify(details.messages)],
  );
}

/**
 * Hands the creator's onboarding profile to Bud once. Returns null for anyone else, or once it has been taken. `commit`
 * runs inside the claim, so a failure there leaves the profile to take again.
 */
export async function takeOnboardingProfile<T>(
  pool: Pool,
  workspaceId: string,
  userId: string,
  commit: (saved: SavedOnboardingProfile) => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (
      await client.query(
        `SELECT p.profile, p.messages, w.name FROM app.onboarding_profiles p JOIN app.workspaces w ON w.id = p.workspace_id
        WHERE p.workspace_id = $1 AND p.user_id = $2 AND p.continued_at IS NULL FOR UPDATE OF p`,
        [workspaceId, userId],
      )
    ).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    const saved = savedProfileSchema.parse(row);
    const result = await commit({ workspaceName: z.string().parse(row.name), ...saved });
    await client.query('UPDATE app.onboarding_profiles SET continued_at = now() WHERE workspace_id = $1', [
      workspaceId,
    ]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
