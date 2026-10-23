CREATE TABLE {{schema}}.tf_social_platform_apps (
  id uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('linkedin','youtube','facebook','instagram','threads','pinterest','tiktok','x','reddit')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512),
  client_secret jsonb NOT NULL,
  access_tier text NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (platform = 'linkedin' AND access_tier IN ('share','community-management'))
    OR (platform IN ('facebook','instagram','threads') AND access_tier IN ('standard','advanced'))
    OR (platform = 'pinterest' AND access_tier IN ('trial','standard'))
    OR (platform = 'tiktok' AND access_tier IN ('unaudited','audited'))
    OR (platform = 'youtube' AND access_tier IN ('unverified','verified'))
    OR (platform IN ('x','reddit') AND access_tier = 'paid')
  ),
  UNIQUE (id, platform)
);

CREATE TABLE {{schema}}.tf_social_accounts (
  id uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('linkedin','youtube','facebook','instagram','threads','pinterest','tiktok','x','reddit')),
  ownership text NOT NULL CHECK (ownership IN ('personal','business')),
  owner_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  owning_team_id uuid REFERENCES {{schema}}.tf_teams(id),
  app_source text NOT NULL CHECK (app_source IN ('workspace','hosted','operator')),
  platform_app_id uuid,
  app_generation integer CHECK (app_generation > 0),
  app_fingerprint text CHECK (app_fingerprint ~ '^[a-f0-9]{64}$'),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  grants_version integer NOT NULL DEFAULT 1 CHECK (grants_version > 0),
  state text NOT NULL CHECK (state IN ('authorizing','active','refreshing','reconnect-required','disabled','disconnected')),
  identity jsonb CHECK (identity IS NULL OR octet_length(identity::text) <= 4096),
  scopes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scopes) <= 64),
  credential jsonb,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  expires_at timestamptz,
  refresh_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (platform_app_id, platform) REFERENCES {{schema}}.tf_social_platform_apps(id, platform),
  CHECK ((ownership = 'personal') = (owner_membership_id IS NOT NULL)),
  CHECK ((ownership = 'business') = (owning_team_id IS NOT NULL)),
  CHECK ((app_source = 'workspace') = (platform_app_id IS NOT NULL)),
  CHECK (platform_app_id IS NULL OR app_generation IS NOT NULL),
  CHECK (app_source = 'workspace' OR app_fingerprint IS NOT NULL),
  CHECK (state NOT IN ('active','refreshing') OR (credential IS NOT NULL AND identity IS NOT NULL)),
  CHECK (state <> 'refreshing' OR refresh_started_at IS NOT NULL)
);
CREATE INDEX tf_social_accounts_refresh ON {{schema}}.tf_social_accounts (expires_at) WHERE state IN ('active','refreshing');

CREATE TABLE {{schema}}.tf_social_account_attempts (
  account_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_social_accounts(id),
  generation integer NOT NULL,
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state text NOT NULL CHECK (state IN ('reserved','exchanging','consumed')),
  verifier jsonb,
  expires_at timestamptz NOT NULL,
  CHECK (state <> 'reserved' OR verifier IS NOT NULL)
);

CREATE TABLE {{schema}}.tf_social_account_grants (
  account_id uuid NOT NULL REFERENCES {{schema}}.tf_social_accounts(id),
  permission text NOT NULL CHECK (permission IN ('use','manage')),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  CHECK ((membership_id IS NULL) <> (team_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (account_id, permission, membership_id, team_id)
);

CREATE TABLE {{schema}}.tf_social_channels (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES {{schema}}.tf_social_accounts(id),
  platform text NOT NULL,
  channel_kind text NOT NULL,
  platform_channel_id text NOT NULL CHECK (length(platform_channel_id) BETWEEN 1 AND 256),
  display_name text NOT NULL CHECK (length(display_name) <= 200),
  handle text CHECK (length(handle) <= 256),
  avatar_url text CHECK (length(avatar_url) <= 2048),
  account_generation integer NOT NULL CHECK (account_generation > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT true,
  engagement_policy text NOT NULL DEFAULT 'approve-each' CHECK (engagement_policy IN ('approve-each','automatic-within-authorization')),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (platform = 'linkedin' AND channel_kind IN ('member-profile','organization-page'))
    OR (platform = 'youtube' AND channel_kind = 'youtube-channel')
    OR (platform = 'facebook' AND channel_kind = 'facebook-page')
    OR (platform = 'instagram' AND channel_kind IN ('instagram-business','instagram-creator'))
    OR (platform = 'threads' AND channel_kind = 'threads-profile')
    OR (platform = 'pinterest' AND channel_kind = 'pinterest-account')
    OR (platform = 'tiktok' AND channel_kind = 'tiktok-account')
    OR (platform = 'x' AND channel_kind = 'x-account')
    OR (platform = 'reddit' AND channel_kind = 'reddit-user')
  )
);
CREATE UNIQUE INDEX tf_social_channels_live ON {{schema}}.tf_social_channels (account_id, platform_channel_id) WHERE removed_at IS NULL;

CREATE TABLE {{schema}}.tf_social_channel_grants (
  channel_id uuid NOT NULL REFERENCES {{schema}}.tf_social_channels(id),
  permission text NOT NULL CHECK (permission IN ('publish','analytics','engagement','manage')),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  CHECK ((membership_id IS NULL) <> (team_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (channel_id, permission, membership_id, team_id)
);

CREATE TABLE {{schema}}.tf_social_posts (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL,
  origin jsonb NOT NULL CHECK (origin->>'kind' IN ('conversation','task','workflow-run') AND octet_length(origin::text) <= 1024),
  author_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (author_membership_id, command_id)
);

CREATE TABLE {{schema}}.tf_social_revisions (
  post_id uuid NOT NULL REFERENCES {{schema}}.tf_social_posts(id),
  number integer NOT NULL CHECK (number > 0),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 1048576),
  sources jsonb NOT NULL CHECK (octet_length(sources::text) <= 262144),
  mcp_derived boolean NOT NULL,
  private_task_derived boolean NOT NULL,
  review_choices jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(review_choices) = 'array'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (post_id, number),
  UNIQUE (post_id, number, content_digest)
);

CREATE TABLE {{schema}}.tf_social_decisions (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  revision integer NOT NULL,
  content_digest text NOT NULL,
  batch_digest text NOT NULL CHECK (batch_digest ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  review_choices jsonb CHECK (review_choices IS NULL OR jsonb_typeof(review_choices) = 'array'),
  decider_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  sponsor_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (post_id, revision, content_digest) REFERENCES {{schema}}.tf_social_revisions(post_id, number, content_digest),
  UNIQUE (post_id, revision),
  CHECK (decision = 'approve' OR review_choices IS NULL)
);

CREATE TABLE {{schema}}.tf_social_variants (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  revision integer NOT NULL,
  channel_id uuid NOT NULL REFERENCES {{schema}}.tf_social_channels(id),
  channel_version integer NOT NULL CHECK (channel_version > 0),
  target jsonb,
  content jsonb NOT NULL CHECK (octet_length(content::text) <= 262144),
  publish_at timestamptz,
  due_at timestamptz,
  state text NOT NULL CHECK (state IN ('draft','awaiting-approval','scheduled','sending','processing','blocked','outcome-unknown','published','failed','not-published','superseded','cancelled')),
  step jsonb CHECK (step IS NULL OR (
    jsonb_typeof(step) = 'object' AND step - 'index' - 'kind' = '{}'::jsonb
    AND jsonb_typeof(step->'index') = 'number' AND step->>'index' ~ '^(0|[1-9][0-9]{0,8})$'
    AND step->>'kind' IN ('upload-media','create-container','publish-container','create-post','upload-video','init-post','await')
  )),
  blocked_reason text CHECK (blocked_reason IN ('origin-revoked','sponsor-removed','grant-removed','account-reconnect','channel-changed','source-lost','media-changed','media-unreadable','review-choices-changed','target-rules-changed','daily-cap','rate-limited')),
  recheck_at timestamptz,
  attempt_id uuid,
  next_attempt_at timestamptz,
  platform_refs jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(platform_refs) = 'object' AND octet_length(platform_refs::text) <= 8192),
  platform_post_id text CHECK (length(platform_post_id) BETWEEN 1 AND 256),
  permalink text CHECK (length(permalink) <= 2048),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (post_id, revision) REFERENCES {{schema}}.tf_social_revisions(post_id, number),
  UNIQUE (post_id, revision, channel_id),
  CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK ((recheck_at IS NOT NULL) = COALESCE(blocked_reason IN ('daily-cap','rate-limited'), false)),
  CHECK (state IN ('draft','awaiting-approval','superseded','cancelled') OR due_at IS NOT NULL),
  CHECK (state <> 'sending' OR (attempt_id IS NOT NULL AND next_attempt_at IS NOT NULL)),
  CHECK (state <> 'published' OR platform_post_id IS NOT NULL)
);
CREATE INDEX tf_social_variants_due ON {{schema}}.tf_social_variants (state, due_at) WHERE state = 'scheduled';
CREATE INDEX tf_social_variants_next_attempt ON {{schema}}.tf_social_variants (next_attempt_at) WHERE state IN ('sending','processing');
CREATE INDEX tf_social_variants_recheck ON {{schema}}.tf_social_variants (recheck_at) WHERE state = 'blocked';
CREATE INDEX tf_social_variants_blocked_due ON {{schema}}.tf_social_variants (due_at) WHERE state = 'blocked';
CREATE INDEX tf_social_variants_channel ON {{schema}}.tf_social_variants (channel_id, state);

CREATE TABLE {{schema}}.tf_social_receipts (
  id uuid PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES {{schema}}.tf_social_variants(id),
  revision integer NOT NULL,
  decision_id uuid NOT NULL REFERENCES {{schema}}.tf_social_decisions(id),
  step text NOT NULL CHECK (step IN ('upload-media','create-container','publish-container','create-post','upload-video','init-post')),
  attempt_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'executing' CHECK (status IN ('executing','succeeded','failed','outcome-unknown')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  platform_refs jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(platform_refs) = 'object' AND octet_length(platform_refs::text) <= 8192),
  platform_post_id text CHECK (length(platform_post_id) BETWEEN 1 AND 256),
  platform_request_id text CHECK (length(platform_request_id) BETWEEN 1 AND 256),
  error_class text CHECK (error_class IN ('retry','rate-limited','rejected','reconnect','unknown')),
  error_code text CHECK (length(error_code) BETWEEN 1 AND 200),
  UNIQUE (variant_id, attempt_id),
  CHECK ((status = 'executing') = (settled_at IS NULL)),
  CHECK ((error_class IS NULL) = (error_code IS NULL)),
  CHECK (status IN ('failed','outcome-unknown') OR error_class IS NULL)
);
CREATE INDEX tf_social_receipts_variant ON {{schema}}.tf_social_receipts (variant_id);

CREATE FUNCTION {{schema}}.tf_social_variant_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  attempted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('draft','awaiting-approval') THEN
      RAISE EXCEPTION 'Social variant must start before approval';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('published','failed','not-published','superseded','cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Social variant is final';
  END IF;
  IF NEW.state NOT IN ('draft','awaiting-approval','superseded','cancelled') AND NOT EXISTS (
    SELECT 1 FROM {{schema}}.tf_social_decisions
    WHERE post_id = NEW.post_id AND revision = NEW.revision AND decision = 'approve'
  ) THEN
    RAISE EXCEPTION 'Social variant requires an approved revision';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  attempted := EXISTS (SELECT 1 FROM {{schema}}.tf_social_receipts WHERE variant_id = NEW.id);
  IF attempted AND (
    NEW.state = 'superseded'
    OR (NEW.state = 'cancelled' AND OLD.state NOT IN ('awaiting-approval','blocked'))
    OR (OLD.state = 'blocked' AND NEW.state = 'scheduled')
  ) THEN
    RAISE EXCEPTION 'Social variant has an attempted step';
  END IF;
  IF NOT attempted AND OLD.state = 'blocked' AND NEW.state = 'processing' THEN
    RAISE EXCEPTION 'Social variant has no attempted step';
  END IF;
  IF NOT (
    (OLD.state, NEW.state) IN (
      ('draft','awaiting-approval'), ('awaiting-approval','scheduled'), ('awaiting-approval','cancelled'),
      ('scheduled','sending'), ('scheduled','blocked'), ('sending','processing'), ('processing','sending'),
      ('processing','blocked'), ('sending','published'), ('processing','published'), ('sending','failed'),
      ('processing','failed'), ('sending','outcome-unknown'), ('processing','outcome-unknown'),
      ('outcome-unknown','published'), ('outcome-unknown','not-published'), ('blocked','scheduled'),
      ('blocked','processing'), ('blocked','cancelled')
    )
    OR (NEW.state = 'superseded' AND OLD.state IN ('draft','awaiting-approval','scheduled','blocked'))
    OR NEW.state = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Social variant cannot move from % to %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_social_variant_transition() FROM PUBLIC;
CREATE TRIGGER tf_social_variant_transition BEFORE INSERT OR UPDATE ON {{schema}}.tf_social_variants
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_social_variant_transition();

CREATE FUNCTION {{schema}}.tf_social_receipt_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM {{schema}}.tf_social_variants v
      JOIN {{schema}}.tf_social_decisions d ON d.post_id = v.post_id AND d.revision = v.revision
      WHERE v.id = NEW.variant_id AND v.revision = NEW.revision AND d.id = NEW.decision_id AND d.decision = 'approve'
    ) THEN
      RAISE EXCEPTION 'Social receipt requires the approved revision of its variant';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'executing' OR NEW.status = 'executing' THEN
    RAISE EXCEPTION 'Receipt is terminal';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_social_receipt_transition() FROM PUBLIC;
CREATE TRIGGER tf_social_receipt_transition BEFORE INSERT OR UPDATE ON {{schema}}.tf_social_receipts
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_social_receipt_transition();

CREATE TABLE {{schema}}.tf_social_engagement_actions (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES {{schema}}.tf_social_channels(id),
  channel_version integer NOT NULL CHECK (channel_version > 0),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reply','message')),
  in_reply_to text NOT NULL CHECK (length(in_reply_to) BETWEEN 1 AND 256),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 63206),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  sources jsonb NOT NULL CHECK (octet_length(sources::text) <= 262144),
  approval_required boolean NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared','awaiting-approval','approved','sending','sent','failed','blocked','outcome-unknown','not-sent','rejected','expired')),
  blocked_reason text CHECK (blocked_reason IN ('origin-revoked','sponsor-removed','grant-removed','account-reconnect','channel-changed','source-lost','media-changed','media-unreadable','review-choices-changed','target-rules-changed','daily-cap','rate-limited')),
  recheck_at timestamptz,
  attempt_id uuid,
  lease_until timestamptz,
  receipt_status text CHECK (receipt_status IN ('executing','succeeded','failed','outcome-unknown')),
  receipt_started_at timestamptz,
  receipt_settled_at timestamptz,
  platform_id text CHECK (length(platform_id) BETWEEN 1 AND 256),
  platform_request_id text CHECK (length(platform_request_id) BETWEEN 1 AND 256),
  error_class text CHECK (error_class IN ('retry','rate-limited','rejected','reconnect','unknown')),
  error_code text CHECK (length(error_code) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '7 days',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (membership_id, command_id),
  UNIQUE (id, digest),
  CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK ((recheck_at IS NOT NULL) = COALESCE(blocked_reason IN ('daily-cap','rate-limited'), false)),
  CHECK (state <> 'sending' OR (attempt_id IS NOT NULL AND lease_until IS NOT NULL AND receipt_status IS NOT NULL)),
  CHECK ((receipt_status IS NULL) = (receipt_started_at IS NULL)),
  CHECK ((receipt_status IS NULL OR receipt_status = 'executing') = (receipt_settled_at IS NULL)),
  CHECK ((error_class IS NULL) = (error_code IS NULL)),
  CHECK (COALESCE(receipt_status IN ('failed','outcome-unknown'), false) OR error_class IS NULL)
);
CREATE INDEX tf_social_engagement_lease ON {{schema}}.tf_social_engagement_actions (lease_until) WHERE state = 'sending';
CREATE INDEX tf_social_engagement_approved ON {{schema}}.tf_social_engagement_actions (created_at) WHERE state = 'approved';
CREATE INDEX tf_social_engagement_expiry ON {{schema}}.tf_social_engagement_actions (expires_at) WHERE state = 'awaiting-approval';
CREATE INDEX tf_social_engagement_recheck ON {{schema}}.tf_social_engagement_actions (recheck_at) WHERE state = 'blocked';

CREATE TABLE {{schema}}.tf_social_engagement_decisions (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL UNIQUE,
  digest text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  decider_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (action_id, digest) REFERENCES {{schema}}.tf_social_engagement_actions(id, digest)
);

CREATE FUNCTION {{schema}}.tf_social_engagement_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'prepared' THEN
      RAISE EXCEPTION 'Social engagement action must start prepared';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('sent','failed','not-sent','rejected','expired') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Social engagement action is final';
  END IF;
  IF NEW.approval_required IS DISTINCT FROM OLD.approval_required THEN
    RAISE EXCEPTION 'Social engagement approval requirement is fixed';
  END IF;
  IF NEW.approval_required AND NEW.state IN ('approved','sending','sent','failed','outcome-unknown') AND NOT EXISTS (
    SELECT 1 FROM {{schema}}.tf_social_engagement_decisions WHERE action_id = NEW.id AND decision = 'approve'
  ) THEN
    RAISE EXCEPTION 'Social engagement action requires approval';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_social_engagement_transition() FROM PUBLIC;
CREATE TRIGGER tf_social_engagement_transition BEFORE INSERT OR UPDATE ON {{schema}}.tf_social_engagement_actions
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_social_engagement_transition();

CREATE TABLE {{schema}}.tf_social_analytics_snapshots (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES {{schema}}.tf_social_channels(id),
  variant_id uuid REFERENCES {{schema}}.tf_social_variants(id),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'array' AND octet_length(metrics::text) <= 16384),
  next_check_at timestamptz NOT NULL
);
CREATE INDEX tf_social_analytics_next_check ON {{schema}}.tf_social_analytics_snapshots (next_check_at);
CREATE INDEX tf_social_analytics_channel ON {{schema}}.tf_social_analytics_snapshots (channel_id, captured_at);

REVOKE ALL ON {{schema}}.tf_social_platform_apps, {{schema}}.tf_social_accounts, {{schema}}.tf_social_account_attempts,
  {{schema}}.tf_social_account_grants, {{schema}}.tf_social_channels, {{schema}}.tf_social_channel_grants,
  {{schema}}.tf_social_posts, {{schema}}.tf_social_revisions, {{schema}}.tf_social_decisions,
  {{schema}}.tf_social_variants, {{schema}}.tf_social_receipts, {{schema}}.tf_social_engagement_actions,
  {{schema}}.tf_social_engagement_decisions, {{schema}}.tf_social_analytics_snapshots FROM PUBLIC;

GRANT SELECT, INSERT ON {{schema}}.tf_social_platform_apps, {{schema}}.tf_social_accounts, {{schema}}.tf_social_account_attempts TO {{runtime}};
GRANT UPDATE (name, client_secret, access_tier, generation) ON {{schema}}.tf_social_platform_apps TO {{runtime}};
GRANT UPDATE (app_generation, app_fingerprint, generation, grants_version, state, identity, scopes, credential, credential_version, expires_at, refresh_started_at) ON {{schema}}.tf_social_accounts TO {{runtime}};
GRANT UPDATE (generation, state_hash, session_hash, membership_id, state, verifier, expires_at) ON {{schema}}.tf_social_account_attempts TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_social_account_grants, {{schema}}.tf_social_channel_grants TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_social_channels TO {{runtime}};
GRANT UPDATE (display_name, handle, avatar_url, account_generation, version, enabled, engagement_policy, removed_at) ON {{schema}}.tf_social_channels TO {{runtime}};

GRANT SELECT ON {{schema}}.tf_social_posts, {{schema}}.tf_social_revisions, {{schema}}.tf_social_decisions,
  {{schema}}.tf_social_variants, {{schema}}.tf_social_receipts TO {{runtime}};
GRANT INSERT (id, command_id, origin, author_membership_id) ON {{schema}}.tf_social_posts TO {{runtime}};
GRANT UPDATE (current_revision) ON {{schema}}.tf_social_posts TO {{runtime}};
GRANT INSERT (post_id, number, content_digest, payload, sources, mcp_derived, private_task_derived, review_choices, expires_at) ON {{schema}}.tf_social_revisions TO {{runtime}};
GRANT INSERT (id, post_id, revision, channel_id, channel_version, target, content, publish_at, state) ON {{schema}}.tf_social_variants TO {{runtime}};
GRANT UPDATE (state, due_at, step, blocked_reason, recheck_at, attempt_id, next_attempt_at, platform_refs, platform_post_id, permalink) ON {{schema}}.tf_social_variants TO {{runtime}};
GRANT INSERT (id, variant_id, revision, decision_id, step, attempt_id) ON {{schema}}.tf_social_receipts TO {{runtime}};
GRANT UPDATE (status, settled_at, platform_refs, platform_post_id, platform_request_id, error_class, error_code) ON {{schema}}.tf_social_receipts TO {{runtime}};

GRANT SELECT ON {{schema}}.tf_social_engagement_actions, {{schema}}.tf_social_engagement_decisions TO {{runtime}};
GRANT INSERT (id, channel_id, channel_version, membership_id, command_id, kind, in_reply_to, text, digest, sources, approval_required, state) ON {{schema}}.tf_social_engagement_actions TO {{runtime}};
GRANT UPDATE (state, blocked_reason, recheck_at, attempt_id, lease_until, receipt_status, receipt_started_at, receipt_settled_at, platform_id, platform_request_id, error_class, error_code) ON {{schema}}.tf_social_engagement_actions TO {{runtime}};

GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_social_analytics_snapshots TO {{runtime}};
GRANT UPDATE (next_check_at) ON {{schema}}.tf_social_analytics_snapshots TO {{runtime}};

GRANT SELECT (id, platform, ownership, owner_membership_id, owning_team_id, app_source, platform_app_id, app_generation, generation, grants_version, state, expires_at) ON {{schema}}.tf_social_accounts TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_social_account_grants, {{schema}}.tf_social_channels, {{schema}}.tf_social_channel_grants,
  {{schema}}.tf_social_posts, {{schema}}.tf_social_revisions, {{schema}}.tf_social_decisions, {{schema}}.tf_social_variants,
  {{schema}}.tf_social_receipts, {{schema}}.tf_social_engagement_actions, {{schema}}.tf_social_engagement_decisions TO {{confirmation}};
GRANT INSERT (id, post_id, revision, content_digest, batch_digest, decision, review_choices, decider_membership_id, sponsor_membership_id) ON {{schema}}.tf_social_decisions TO {{confirmation}};
GRANT INSERT (id, action_id, digest, decision, decider_membership_id) ON {{schema}}.tf_social_engagement_decisions TO {{confirmation}};
