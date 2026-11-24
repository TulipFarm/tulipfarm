-- Files and chat attachments may be up to 100 MiB, so a chat's computer can take and return videos, scans and other
-- large files. Knowledge and skill files keep their 10 MiB limit.
ALTER TABLE {{schema}}.tf_files
  DROP CONSTRAINT tf_files_check1,
  ADD CONSTRAINT tf_files_check1
    CHECK ((kind = 'folder' AND object_key IS NULL AND media_type IS NULL AND size IS NULL AND sha256 IS NULL AND ready)
      OR (kind = 'file' AND object_key IS NOT NULL AND media_type IS NOT NULL AND size IS NOT NULL AND sha256 IS NOT NULL AND size BETWEEN 1 AND 104857600 AND sha256 ~ '^[a-f0-9]{64}$'));
ALTER TABLE {{schema}}.tf_file_versions
  DROP CONSTRAINT tf_file_versions_size_check,
  ADD CONSTRAINT tf_file_versions_size_check CHECK (size BETWEEN 1 AND 104857600);
ALTER TABLE {{schema}}.tf_conversation_attachments
  DROP CONSTRAINT tf_conversation_attachments_size_check,
  ADD CONSTRAINT tf_conversation_attachments_size_check CHECK (size BETWEEN 1 AND 104857600);
