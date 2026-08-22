# Knowledge source sync

Concrete API adapters and schedules live here; provider-neutral sync logic lives in
`@tulipfarm/integrations`.

- Slack syncs per-channel through a concrete HTTP adapter, a durable checkpoint, and
  `PgKnowledgeEmissionSink`.
- Every provider emits `KnowledgeSourceEmission` plus chunks into `knowledge_source_*`; none writes
  OKF pages.
- Missing, stale, or unreadable ACL data must emit `unverifiable` and remove indexed content.
