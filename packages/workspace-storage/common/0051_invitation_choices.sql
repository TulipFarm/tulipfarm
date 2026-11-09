-- An invitation carries the workspace role, teams and direct table policies chosen when inviting. They apply when the
-- invitation is redeemed; anything that no longer exists then is recorded in skipped for admins to review.
ALTER TABLE {{schema}}.tf_invitations
  ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  ADD COLUMN assignments jsonb NOT NULL DEFAULT '{"teams":[],"policies":[]}'::jsonb CHECK (jsonb_typeof(assignments) = 'object'),
  ADD COLUMN skipped jsonb;
