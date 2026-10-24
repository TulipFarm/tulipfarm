-- Files shared as links in chat messages. A link is fetched once per message and the outcome kept, so later turns read
-- the kept copy instead of fetching again. A `file` outcome is kept as a bound attachment carrying its source URL.
ALTER TABLE {{schema}}.tf_conversation_attachments
  ADD COLUMN source_url text CHECK (source_url IS NULL OR source_url ~ '^https://');

CREATE TABLE {{schema}}.tf_conversation_link_reads (
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations (id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  url text NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 2048),
  outcome text NOT NULL CHECK (outcome IN ('file', 'page', 'failed')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z-]{0,63}$'),
  attachment_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (message_id, url),
  UNIQUE (message_id, ordinal),
  FOREIGN KEY (conversation_id, message_id)
    REFERENCES {{schema}}.tf_conversation_messages (conversation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, attachment_id)
    REFERENCES {{schema}}.tf_conversation_attachments (conversation_id, id) ON DELETE CASCADE,
  CHECK ((outcome = 'file') = (attachment_id IS NOT NULL)),
  CHECK ((outcome = 'failed') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX tf_conversation_link_reads_attachment
  ON {{schema}}.tf_conversation_link_reads (attachment_id) WHERE attachment_id IS NOT NULL;

REVOKE ALL ON {{schema}}.tf_conversation_link_reads FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_link_reads TO {{runtime}};
