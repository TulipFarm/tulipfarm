-- Search and the embedding sweep only use vectors of the active profile. The engine records it here and, whenever it
-- changes, clears document pointers to every other profile's vectors, including vectors from before profiles were
-- recorded. The sweep then finds those documents through the unembedded index instead of joining every document to
-- its vector publication. Only the active profile's vectors may be published to documents.
CREATE TABLE {{schema}}.tf_knowledge_embedding_active_profile (
  id integer PRIMARY KEY CHECK (id = 1),
  profile_id text NOT NULL REFERENCES {{schema}}.tf_knowledge_embedding_profiles(id)
);
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_knowledge_embedding_active_profile TO {{runtime}};
GRANT UPDATE (profile_id) ON TABLE {{schema}}.tf_knowledge_embedding_active_profile TO {{runtime}};

-- The sweep no longer looks up vector publications without a profile.
DROP INDEX {{schema}}.tf_knowledge_vector_publications_unprofiled;
