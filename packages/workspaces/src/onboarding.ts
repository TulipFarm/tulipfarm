import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { onboardingDetailsSchema, onboardingDraftSchema, type OnboardingDetails } from './onboarding-contracts.ts';

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
