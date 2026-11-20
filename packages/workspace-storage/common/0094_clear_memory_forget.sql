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
