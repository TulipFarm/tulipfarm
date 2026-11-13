-- The working copy of an app. One editor at a time holds the lease. A public app's draft is a Git commit plus the
-- changes the lease holder has staged since it; a private app's draft is a definition document.
CREATE TABLE {{schema}}.tf_app_drafts (
  app_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_apps(id),
  revision bigint NOT NULL DEFAULT 0,
  head_commit text CHECK (head_commit ~ '^[0-9a-f]{40}$'),
  definition jsonb,
  lease_id uuid,
  lease_conversation_id uuid REFERENCES {{schema}}.tf_conversations(id),
  lease_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  lease_expires_at timestamptz,
  preview_build_id text,
  failure jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (head_commit IS NULL OR definition IS NULL)
);
REVOKE ALL ON {{schema}}.tf_app_drafts FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_drafts TO {{runtime}};
GRANT UPDATE (revision, head_commit, definition, lease_id, lease_conversation_id, lease_membership_id,
  lease_expires_at, preview_build_id, failure, updated_at) ON {{schema}}.tf_app_drafts TO {{runtime}};

-- File changes the lease holder staged and has not yet saved into a commit. A NULL content deletes the path.
CREATE TABLE {{schema}}.tf_app_draft_changes (
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  lease_id uuid NOT NULL,
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 512 AND path !~ '(^/|\.\./|^\.git/)'),
  content bytea,
  sha256 text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, lease_id, path),
  CHECK (content IS NULL OR octet_length(content) <= 524288)
);
REVOKE ALL ON {{schema}}.tf_app_draft_changes FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_app_draft_changes TO {{runtime}};

-- Every save uploads a Git bundle from the previous head, so the repository can be rebuilt from object storage alone.
CREATE TABLE {{schema}}.tf_app_source_bundles (
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  seq integer NOT NULL CHECK (seq >= 1),
  base_commit text,
  head_commit text NOT NULL,
  object_key text NOT NULL,
  sha256 text NOT NULL,
  bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, seq),
  UNIQUE (app_id, head_commit)
);
REVOKE ALL ON {{schema}}.tf_app_source_bundles FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_source_bundles TO {{runtime}};
