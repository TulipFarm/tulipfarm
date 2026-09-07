# Knowledge source sync

Concrete API adapters and schedules live here; provider-neutral sync logic lives in
`@tulipfarm/integrations`.

- Slack syncs per-channel through a concrete HTTP adapter, a durable checkpoint, and
  `PgKnowledgeEmissionSink`.
- OIM live authorization replays the manifest's declared permission operation through the exact
  Connection recorded on the source, binds only persisted item fields, and requires a proven
  linked provider identity.
- Every provider emits `KnowledgeSourceEmission` plus chunks into `knowledge_source_*`; none writes
  OKF pages.
- Missing, stale, or unreadable ACL data must emit `unverifiable` and remove indexed content.
