-- A private app keeps only its newest published versions, so publishing deletes the oldest beyond that count. A
-- deleted version takes the broken references recorded against it.
ALTER TABLE {{schema}}.tf_app_broken_references
  DROP CONSTRAINT tf_app_broken_references_version_id_fkey,
  ADD CONSTRAINT tf_app_broken_references_version_id_fkey
    FOREIGN KEY (version_id) REFERENCES {{schema}}.tf_app_versions(id) ON DELETE CASCADE;
GRANT DELETE ON {{schema}}.tf_app_versions TO {{runtime}};
