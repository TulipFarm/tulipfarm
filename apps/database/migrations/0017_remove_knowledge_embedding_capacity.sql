-- Knowledge no longer computes its own embeddings, so the shared embedding rate limit is unused.
DROP FUNCTION IF EXISTS app.acquire_knowledge_embedding_capacity(uuid, text, integer, uuid);
DROP TABLE IF EXISTS app.knowledge_embedding_capacity_claims;
DROP TABLE IF EXISTS app.knowledge_embedding_capacity_gate;
