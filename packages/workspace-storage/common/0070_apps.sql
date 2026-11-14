-- An app is a workspace-owned site. A public app is served on its own name once an admin approves it; a private app is
-- served only to members inside the workspace. The kind never changes, and the CHECKs keep every public-only field off
-- a private app. The live pointer moves by compare-and-set on release_generation. The stop columns are independent
-- and publish never writes them, so an older publish cannot undo a pause or disable.
CREATE TABLE {{schema}}.tf_apps (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('public','private')),
  slug text NOT NULL UNIQUE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  created_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  public_name text,
  approval_state text NOT NULL DEFAULT 'not-requested'
    CHECK (approval_state IN ('not-requested','requested','approved','rejected')),
  approval_by uuid REFERENCES {{schema}}.tf_memberships(id),
  approval_at timestamptz,
  monthly_limit_units numeric(40,0) CHECK (monthly_limit_units >= 0),
  release_generation bigint NOT NULL DEFAULT 0,
  live_release_id uuid,
  live_version_id uuid,
  edge_version bigint NOT NULL DEFAULT 0,
  editor_paused_at timestamptz,
  budget_paused_at timestamptz,
  disabled_at timestamptz,
  disabled_by uuid REFERENCES {{schema}}.tf_memberships(id),
  preview_key text UNIQUE,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (kind = 'public' OR (public_name IS NULL AND approval_state = 'not-requested'
         AND live_release_id IS NULL AND preview_key IS NULL AND budget_paused_at IS NULL)),
  CHECK (kind = 'private' OR live_version_id IS NULL),
  CHECK (live_release_id IS NULL OR approval_state = 'approved')
);
REVOKE ALL ON {{schema}}.tf_apps FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_apps TO {{runtime}};
GRANT UPDATE (title, slug, public_name, approval_state, approval_by, approval_at, monthly_limit_units,
  release_generation, live_release_id, live_version_id, edge_version, editor_paused_at, budget_paused_at,
  disabled_at, disabled_by, preview_key, archived_at) ON {{schema}}.tf_apps TO {{runtime}};

-- Who may use or edit an app, keyed like tf_secret_grants. Edit implies use; a workspace-wide grant is use only. The
-- CHECK is wrapped in COALESCE because a member or team grant with a NULL id would otherwise evaluate to NULL and pass.
CREATE TABLE {{schema}}.tf_app_grants (
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  grantee text NOT NULL,
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('use','edit')),
  granted_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, grantee),
  CHECK (COALESCE(
    (grantee = 'workspace' AND membership_id IS NULL AND team_id IS NULL AND role = 'use')
    OR (grantee = 'member:' || membership_id::text AND team_id IS NULL)
    OR (grantee = 'team:' || team_id::text AND membership_id IS NULL),
    false
  ))
);
CREATE INDEX tf_app_grants_member ON {{schema}}.tf_app_grants (membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX tf_app_grants_team ON {{schema}}.tf_app_grants (team_id) WHERE team_id IS NOT NULL;
REVOKE ALL ON {{schema}}.tf_app_grants FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_app_grants TO {{runtime}};

-- An app's editing chat. Set when the conversation is created and never changed.
ALTER TABLE {{schema}}.tf_conversations ADD COLUMN app_id uuid REFERENCES {{schema}}.tf_apps(id);
CREATE INDEX tf_conversations_app ON {{schema}}.tf_conversations (app_id) WHERE app_id IS NOT NULL;
