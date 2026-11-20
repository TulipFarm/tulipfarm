-- When the workspace first used Keep for personal memory. Keep then holds every member's memory: if Keep is later
-- turned off, memory is hidden rather than read from tf_personal_memory again. One row at most.
CREATE TABLE {{schema}}.tf_keep_memory (
  id smallint PRIMARY KEY CHECK (id = 1),
  first_used_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON {{schema}}.tf_keep_memory FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_keep_memory TO {{runtime}};

-- With Keep, forgetting is permanent, and the chat card that asks first holds the exact text to forget. Drafts are
-- otherwise insert-only; once the card is decided, this blanks that text and nothing else.
CREATE FUNCTION {{schema}}.tf_clear_memory_forget(target uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  UPDATE {{schema}}.tf_chat_authoring_drafts d
  SET proposal = jsonb_set(d.proposal, '{input,forgotten}', '""'::jsonb)
  WHERE d.id = target AND d.proposal->>'kind' = 'memory' AND d.proposal->'input'->>'operation' = 'forget'
    AND EXISTS (SELECT 1 FROM {{schema}}.tf_chat_authoring_decisions c WHERE c.draft_id = target);
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_clear_memory_forget(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_clear_memory_forget(uuid) TO {{runtime}};
