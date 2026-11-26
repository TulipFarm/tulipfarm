-- What a workspace's creator told the onboarding chat before signing up: the profile it built (about the business,
-- the goal, the website summary and the agents they picked) and the chat itself. Only the creator, the first Owner,
-- reads it: Bud uses it once to continue the chat in the workspace and records when it did.
CREATE TABLE app.onboarding_profiles (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  profile jsonb NOT NULL,
  messages jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  continued_at timestamptz
);
REVOKE ALL ON TABLE app.onboarding_profiles FROM PUBLIC;
