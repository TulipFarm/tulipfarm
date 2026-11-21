-- Bud saves business facts a member states in their own chat or task as notes in that member's Knowledge. One row per
-- learned note records where it was last learned from; editing or removing the note keeps the note's own access rules.
CREATE TABLE {{schema}}.tf_knowledge_learned (
  document_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_documents (id) ON DELETE CASCADE,
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('chat', 'task')),
  source_id uuid NOT NULL,
  run_id uuid,
  learned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_knowledge_learned_owner ON {{schema}}.tf_knowledge_learned (owner_membership_id, learned_at DESC);
REVOKE ALL ON {{schema}}.tf_knowledge_learned FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (source_kind, source_id, run_id, learned_at) ON {{schema}}.tf_knowledge_learned TO {{runtime}};

-- Closed chats are read for business facts after personal memory. Chats maintained before this pass existed start
-- complete, so they are not read again.
ALTER TABLE {{schema}}.tf_conversation_maintenance
  ADD COLUMN knowledge_complete boolean NOT NULL DEFAULT true,
  ADD COLUMN knowledge_chunk integer NOT NULL DEFAULT 0 CHECK (knowledge_chunk >= 0);
ALTER TABLE {{schema}}.tf_conversation_maintenance ALTER COLUMN knowledge_complete SET DEFAULT false;
CREATE INDEX tf_conversation_maintenance_knowledge_pending ON {{schema}}.tf_conversation_maintenance (next_attempt_at, id)
  WHERE state = 'ready' AND NOT knowledge_complete;

-- Marks task messages the owner typed in the task, as opposed to text the server wrote for them, such as a row's
-- comments or an app's prompt. Only typed messages are read for business facts.
ALTER TABLE {{schema}}.tf_agent_task_messages ADD COLUMN typed boolean NOT NULL DEFAULT false;
