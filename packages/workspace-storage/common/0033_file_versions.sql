-- File versions: every stored revision of a file. tf_files keeps mirroring the current version's object, size, media type
-- and digest, so readers of tf_files need no change. Each version owns its object key; a restore copies the bytes to a new
-- key. Version 1 of a file published from a chat attachment borrows the attachment's object, as the file did.
CREATE TABLE {{schema}}.tf_file_versions (
  file_id uuid NOT NULL REFERENCES {{schema}}.tf_files(id),
  version integer NOT NULL CHECK (version > 0),
  object_key uuid NOT NULL UNIQUE,
  object_owner text NOT NULL DEFAULT 'files' CHECK (object_owner IN ('files', 'attachment')),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  media_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_by_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9-]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (file_id, version)
);

INSERT INTO {{schema}}.tf_file_versions
  (file_id, version, object_key, object_owner, size, media_type, sha256, created_by_membership_id, source, created_at)
SELECT id, 1, object_key, object_owner, size, media_type, sha256, creator_membership_id, 'original', created_at
FROM {{schema}}.tf_files WHERE kind = 'file' AND ready;

-- Every path that inserts a ready file records its first version, so a file never exists without one.
CREATE FUNCTION {{schema}}.tf_files_first_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO {{schema}}.tf_file_versions
    (file_id, version, object_key, object_owner, size, media_type, sha256, created_by_membership_id, source, created_at)
  VALUES (NEW.id, 1, NEW.object_key, NEW.object_owner, NEW.size, NEW.media_type, NEW.sha256, NEW.creator_membership_id,
    'original', NEW.created_at)
  ON CONFLICT (file_id, version) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER tf_files_first_version AFTER INSERT ON {{schema}}.tf_files
  FOR EACH ROW WHEN (NEW.kind = 'file' AND NEW.ready) EXECUTE FUNCTION {{schema}}.tf_files_first_version();
CREATE TRIGGER tf_files_first_version_ready AFTER UPDATE OF ready ON {{schema}}.tf_files
  FOR EACH ROW WHEN (NEW.kind = 'file' AND NEW.ready AND NOT OLD.ready)
  EXECUTE FUNCTION {{schema}}.tf_files_first_version();
REVOKE ALL ON FUNCTION {{schema}}.tf_files_first_version() FROM PUBLIC;

-- A later version becomes the file's current bytes. The runtime cannot rewrite tf_files bytes directly; only adding a
-- version, which keeps the old object, changes them.
CREATE FUNCTION {{schema}}.tf_file_versions_current() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE {{schema}}.tf_files SET object_key = NEW.object_key, object_owner = NEW.object_owner,
    media_type = NEW.media_type, size = NEW.size, sha256 = NEW.sha256
  WHERE id = NEW.file_id AND kind = 'file';
  RETURN NULL;
END $$;
CREATE TRIGGER tf_file_versions_current AFTER INSERT ON {{schema}}.tf_file_versions
  FOR EACH ROW WHEN (NEW.version > 1) EXECUTE FUNCTION {{schema}}.tf_file_versions_current();
REVOKE ALL ON FUNCTION {{schema}}.tf_file_versions_current() FROM PUBLIC;

-- One folder per member and purpose that the product files into, such as plan documents. The member may rename or move it.
CREATE TABLE {{schema}}.tf_member_system_folders (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  purpose text NOT NULL CHECK (purpose IN ('plans')),
  file_id uuid NOT NULL REFERENCES {{schema}}.tf_files(id),
  PRIMARY KEY (membership_id, purpose)
);

-- Who made a grant. NULL is a person sharing directly; a named origin, such as a project, is kept in sync by the product.
ALTER TABLE {{schema}}.tf_file_grants
  ADD COLUMN origin text CHECK (origin IS NULL OR char_length(origin) BETWEEN 1 AND 200);

REVOKE ALL ON {{schema}}.tf_file_versions, {{schema}}.tf_member_system_folders FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_file_versions TO {{runtime}};
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_member_system_folders TO {{runtime}};
