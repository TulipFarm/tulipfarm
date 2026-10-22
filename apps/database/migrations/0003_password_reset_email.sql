-- Password reset emails for optional email and password sign-in (AUTH_EMAIL_PASSWORD). Like a magic link, a reset
-- email belongs to no workspace or invitation.
ALTER TABLE app.email_deliveries
  DROP CONSTRAINT email_deliveries_kind_check,
  DROP CONSTRAINT email_deliveries_check,
  ADD CONSTRAINT email_deliveries_kind_check CHECK (kind IN ('invitation', 'magic-link', 'password-reset')),
  ADD CONSTRAINT email_deliveries_check CHECK (
    (kind = 'invitation' AND workspace_id IS NOT NULL AND invitation_id IS NOT NULL) OR
    (kind IN ('magic-link', 'password-reset') AND workspace_id IS NULL AND invitation_id IS NULL));
