-- The embedding sweep looks for documents whose current publication has no vector publication. Most documents have
-- one, so indexing only the rest keeps the sweep proportional to pending work rather than to the knowledge base.
CREATE INDEX tf_knowledge_documents_unembedded ON {{schema}}.tf_knowledge_documents (id)
  WHERE tombstoned_at IS NULL AND lexical_publication_id IS NOT NULL AND vector_publication_id IS NULL;

-- Vector publications from before profiles were recorded have no profile, so they never match the current one.
CREATE INDEX tf_knowledge_vector_publications_unprofiled ON {{schema}}.tf_knowledge_vector_publications (id)
  WHERE profile_id IS NULL;
