-- An automatic GitHub intent follows the member's GitHub user, so a new account row for that user takes it over instead of leaving it on a row that no longer exists.
ALTER TABLE {{schema}}.tf_knowledge_default_intents ADD COLUMN github_user_id text
  CHECK (github_user_id IS NULL OR (product='github' AND github_user_id ~ '^[1-9][0-9]{0,15}$'));
CREATE UNIQUE INDEX tf_knowledge_default_intents_github_user ON {{schema}}.tf_knowledge_default_intents
  (membership_id,github_user_id) WHERE github_user_id IS NOT NULL;

UPDATE {{schema}}.tf_knowledge_default_intents i SET github_user_id=a.identity->>'id'
FROM {{schema}}.tf_github_accounts a
WHERE i.product='github' AND a.id::text=i.account_key AND a.owner_membership_id=i.membership_id AND a.identity IS NOT NULL;

-- Intents whose account row is gone get their GitHub user from the sources they created, else from an account with the same login.
-- The oldest one per user moves to that user's active account (or only records the user when none is active); the rest, and any
-- whose user already has an intent, stop discovering, since they can never reach GitHub again.
WITH stranded AS (
  SELECT i.id,i.membership_id,i.created_at,COALESCE(
    (SELECT g.binding->>'githubUserId' FROM {{schema}}.tf_knowledge_default_sources d
      JOIN {{schema}}.tf_knowledge_github_sources g ON g.source_id=d.source_id WHERE d.intent_id=i.id ORDER BY d.ordinal LIMIT 1),
    (SELECT a.identity->>'id' FROM {{schema}}.tf_github_accounts a WHERE a.owner_membership_id=i.membership_id
      AND a.identity->>'login'=i.account_label ORDER BY a.state='active' DESC,a.created_at LIMIT 1)) AS github_user_id
  FROM {{schema}}.tf_knowledge_default_intents i
  WHERE i.product='github' AND i.github_user_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_github_accounts o WHERE o.id::text=i.account_key AND o.owner_membership_id=i.membership_id)
), plan AS (
  SELECT s.id,s.github_user_id,a.id::text AS account_key,a.identity->>'login' AS login,
    row_number() OVER (PARTITION BY s.membership_id,s.github_user_id ORDER BY s.created_at,s.id)=1
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_default_intents t WHERE t.membership_id=s.membership_id AND t.product='github'
        AND (t.github_user_id=s.github_user_id OR t.account_key=a.id::text)) AS keep
  FROM stranded s
  LEFT JOIN {{schema}}.tf_github_accounts a ON a.owner_membership_id=s.membership_id AND a.state='active' AND a.identity->>'id'=s.github_user_id
  WHERE s.github_user_id IS NOT NULL
), decided AS (
  SELECT p.*,p.keep AND p.account_key IS NOT NULL AS move FROM plan p
)
UPDATE {{schema}}.tf_knowledge_default_intents i
SET github_user_id=CASE WHEN p.keep THEN p.github_user_id END,
  state=CASE WHEN p.keep THEN i.state ELSE 'opted-out' END,
  account_key=CASE WHEN p.move THEN p.account_key ELSE i.account_key END,
  account_label=CASE WHEN p.move THEN p.login ELSE i.account_label END,
  generation=CASE WHEN p.keep AND NOT p.move THEN i.generation ELSE i.generation+1 END,
  lease_token=CASE WHEN p.keep AND NOT p.move THEN i.lease_token END,
  lease_until=CASE WHEN p.keep AND NOT p.move THEN i.lease_until END,
  cursor=CASE WHEN p.move THEN NULL ELSE i.cursor END,
  failure=CASE WHEN p.move THEN NULL ELSE i.failure END,
  attempts=CASE WHEN p.move THEN 0 ELSE i.attempts END,
  next_attempt_at=CASE WHEN p.move THEN clock_timestamp() ELSE i.next_attempt_at END,
  sync_state=CASE WHEN p.move AND i.sync_state='failed' THEN 'queued' ELSE i.sync_state END
FROM decided p
WHERE i.id=p.id;
