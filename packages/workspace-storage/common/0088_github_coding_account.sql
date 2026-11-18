-- Each of a member's personal GitHub accounts can be turned on or off for chats (repository reads and changes) and for
-- coding runs and Workflow coding steps (pushes). At most one of the member's accounts is where Knowledge imports start.
ALTER TABLE {{schema}}.tf_github_accounts
  ADD COLUMN use_for_chat boolean NOT NULL DEFAULT true,
  ADD COLUMN use_for_coding boolean NOT NULL DEFAULT true,
  ADD COLUMN primary_for_knowledge boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX tf_github_account_knowledge ON {{schema}}.tf_github_accounts (owner_membership_id)
  WHERE primary_for_knowledge;
GRANT UPDATE (use_for_chat, use_for_coding, primary_for_knowledge) ON {{schema}}.tf_github_accounts TO {{runtime}};
-- The login a chat coding run clones with, fixed when it is proposed so the approval can name it.
ALTER TABLE {{schema}}.tf_coding_runs ADD COLUMN github_login text CHECK (github_login IS NULL OR length(github_login) <= 39);
