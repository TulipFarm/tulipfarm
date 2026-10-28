CREATE TABLE {{schema}}.tf_system_package_installations (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  request_id uuid NOT NULL,
  conversation_id uuid REFERENCES {{schema}}.tf_conversations(id),
  package_digest text NOT NULL CHECK(package_digest ~ '^[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  package jsonb NOT NULL,
  bindings jsonb NOT NULL,
  identities jsonb NOT NULL,
  nodes jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','waiting-review','running','blocked','failed','completed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(membership_id, request_id)
);
CREATE TABLE {{schema}}.tf_system_package_operations (
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_system_package_installations(id),
  resource_key text NOT NULL,
  operation text NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  input jsonb NOT NULL,
  receipt jsonb,
  PRIMARY KEY(installation_id, resource_key, operation)
);
CREATE TABLE {{schema}}.tf_system_package_reviews (
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_system_package_installations(id),
  resource_key text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  request_id uuid NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK(decision IN ('approve','reject')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(installation_id, resource_key),
  UNIQUE(membership_id,request_id)
);
REVOKE ALL ON {{schema}}.tf_system_package_installations, {{schema}}.tf_system_package_operations,
  {{schema}}.tf_system_package_reviews FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_system_package_installations,
  {{schema}}.tf_system_package_operations TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_system_package_installations, {{schema}}.tf_system_package_operations,
  {{schema}}.tf_system_package_reviews TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};
GRANT INSERT ON {{schema}}.tf_system_package_reviews TO {{confirmation}};

ALTER TABLE {{schema}}.tf_table_proposals
  ALTER COLUMN conversation_id DROP NOT NULL,
  ALTER COLUMN turn_id DROP NOT NULL,
  ADD COLUMN installation_id uuid REFERENCES {{schema}}.tf_system_package_installations(id),
  ADD CONSTRAINT tf_table_proposal_origin CHECK (
    (installation_id IS NULL AND conversation_id IS NOT NULL AND turn_id IS NOT NULL) OR
    (installation_id IS NOT NULL AND conversation_id IS NULL AND turn_id IS NULL)
  );
