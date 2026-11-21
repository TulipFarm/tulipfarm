-- Search and the embedding sweep only use vectors of the current profile. Documents still pointing at vectors from
-- before profiles were recorded are unembedded for every profile, so clear those pointers. The sweep then finds them
-- through the unembedded index instead of joining every document to its vector publication.
UPDATE {{schema}}.tf_knowledge_documents d SET vector_publication_id=NULL
FROM {{schema}}.tf_knowledge_vector_publications v
WHERE v.id=d.vector_publication_id AND v.profile_id IS NULL;

-- The sweep no longer looks up vector publications without a profile.
DROP INDEX {{schema}}.tf_knowledge_vector_publications_unprofiled;
