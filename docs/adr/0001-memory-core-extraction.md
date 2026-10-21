# Keep memory algorithms behind explicit host ports

Knowledge, retrieval, embeddings, and personal-memory algorithms belong in
`memory-core`, with opaque transaction contexts and explicit storage,
authorization, model, usage, and policy ports; `memory-postgres` retains the
existing SQL. We keep workspace identity, current membership and permission
decisions, provider ACLs, host foreign keys, Bud/recommendation side effects,
and Temporal composition in TulipFarm because moving or generalizing them
now would change authority or storage behavior. Preserving query text,
bindings, transaction/lease fences, proof freshness, ranking snapshots, and
old forwarding exports is safer than introducing a new schema or generic
query language during extraction.

An adapter never turns cached text, a vector, or permission evidence into
authority: the host decides access and the core rechecks the applicable
decision and proof. Stateful reference adapters and shared conformance test
the personal-memory seam without Postgres, while unchanged host integration
tests remain necessary for real eligibility, SQL, and Temporal behavior.
External packaging, new storage models, and new memory capabilities are
separate work, not consequences of this extraction.
