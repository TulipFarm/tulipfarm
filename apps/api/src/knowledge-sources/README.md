# Knowledge source sync

Concrete API adapters and schedules live here; provider-neutral sync logic lives in
`@tulipfarm/integrations`.

- Confluence keeps its v37 checkpoint table and sync schedule.
- K3 providers (Notion, Google Docs, Google Drive) use `knowledge_sync_checkpoints` (v38), concrete
  HTTP adapters, and `PgKnowledgeEmissionSink`.
- Every provider emits `KnowledgeSourceEmission` plus chunks into `knowledge_source_*`; none writes
  OKF pages.
- Missing, stale, or unreadable ACL data must emit `unverifiable` and remove indexed content.
- Google `anyone` link-sharing grants no principal. Domain shares grant only when the domain subject
  is explicitly mapped.
- Notion production sync requires verifiable reader data; otherwise pages remain excluded.
