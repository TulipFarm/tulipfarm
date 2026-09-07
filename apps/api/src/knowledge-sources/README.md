# Knowledge source sync

Concrete API adapters and schedules live here; provider-neutral sync logic lives in
`@tulipfarm/integrations`.

- Slack is not scheduled for automatic indexing. Users configure their own Soul-backed Routine
  through the Integration setup surface and the bounded Slack read Tool.
- Every provider emits `KnowledgeSourceEmission` plus chunks into `knowledge_source_*`; none writes
  OKF pages.
- Missing, stale, or unreadable ACL data must emit `unverifiable` and remove indexed content.
