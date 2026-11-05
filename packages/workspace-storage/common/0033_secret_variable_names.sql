-- A secret's variable name, such as STRIPE_KEY, names it when it is handed to code as an environment variable. It is
-- unique among the owner's active secrets.
ALTER TABLE {{schema}}.tf_secrets ADD COLUMN variable_name text
  CHECK (variable_name ~ '^[A-Z][A-Z0-9_]{0,63}$');

-- Existing secrets get their name uppercased with `_KEY` added, and a row number suffix when an owner has the same one twice.
WITH slugs AS (
  SELECT id, owner_membership_id, status, created_at,
    btrim(regexp_replace(upper(name), '[^A-Z0-9]+', '_', 'g'), '_') AS slug
  FROM {{schema}}.tf_secrets
), bases AS (
  SELECT id, owner_membership_id, status, created_at,
    rtrim(left(CASE WHEN slug = '' OR slug ~ '^[0-9]' THEN 'SECRET_' || slug ELSE slug END, 48), '_') || '_KEY' AS base
  FROM slugs
), numbered AS (
  SELECT id, base,
    row_number() OVER (PARTITION BY owner_membership_id, base ORDER BY status = 'active' DESC, created_at, id) AS n
  FROM bases
)
UPDATE {{schema}}.tf_secrets s
SET variable_name = CASE WHEN n.n = 1 THEN n.base ELSE n.base || '_' || n.n END
FROM numbered n
WHERE s.id = n.id;

ALTER TABLE {{schema}}.tf_secrets ALTER COLUMN variable_name SET NOT NULL;
CREATE UNIQUE INDEX tf_secrets_variable_name ON {{schema}}.tf_secrets (owner_membership_id, variable_name)
  WHERE status = 'active';
