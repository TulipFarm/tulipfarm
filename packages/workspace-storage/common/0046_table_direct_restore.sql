-- A person can also unarchive a table from its page. Like a page archive, it is a single-plan proposal with no chat
-- or package origin that runs through the same approval and storage worker as a chat restore.
ALTER TABLE {{schema}}.tf_table_proposals
  DROP CONSTRAINT tf_table_proposal_origin,
  ADD CONSTRAINT tf_table_proposal_origin CHECK (
    (installation_id IS NULL AND conversation_id IS NOT NULL AND turn_id IS NOT NULL) OR
    (installation_id IS NOT NULL AND conversation_id IS NULL AND turn_id IS NULL) OR
    (installation_id IS NULL AND conversation_id IS NULL AND turn_id IS NULL
      AND jsonb_array_length(manifest->'plans') = 1 AND manifest#>>'{plans,0,input,kind}' IN ('archive', 'restore'))
  );
