-- Files on a row's description or on one of its thread comments, readable by anyone who can read the row. They are
-- separate from Files, whose own permissions would hide a task's screenshot from the people working on it. Bytes live
-- in the chat object store at <workspace>/<object_key>. An upload is unbound (row_id NULL) until a description or
-- comment takes it, and is deleted after expires_at if nothing does. A file an agent carries over from a chat borrows
-- that chat attachment's object (chat_attachment_id set): it is charged and stored once, through the chat attachment.
CREATE TABLE {{schema}}.tf_row_attachments (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  row_id uuid,
  thread_item_id uuid REFERENCES {{schema}}.tf_row_thread_items(id),
  object_key uuid NOT NULL,
  chat_attachment_id uuid REFERENCES {{schema}}.tf_conversation_attachments(id),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 255),
  size bigint NOT NULL CHECK (size BETWEEN 1 AND 104857600),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  creator_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  creator_agent_id uuid REFERENCES {{schema}}.tf_agents(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  CHECK (num_nonnulls(creator_membership_id, creator_agent_id) = 1),
  CHECK (thread_item_id IS NULL OR row_id IS NOT NULL)
);
CREATE UNIQUE INDEX tf_row_attachments_owned_object ON {{schema}}.tf_row_attachments(object_key)
  WHERE chat_attachment_id IS NULL;
CREATE INDEX tf_row_attachments_row ON {{schema}}.tf_row_attachments(table_id, row_id, thread_item_id)
  WHERE row_id IS NOT NULL;
CREATE INDEX tf_row_attachments_unbound ON {{schema}}.tf_row_attachments(expires_at) WHERE row_id IS NULL;
REVOKE ALL ON {{schema}}.tf_row_attachments FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_row_attachments TO {{runtime}};
GRANT UPDATE (row_id, thread_item_id) ON {{schema}}.tf_row_attachments TO {{runtime}};
