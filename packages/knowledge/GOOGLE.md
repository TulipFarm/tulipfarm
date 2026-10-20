# Google corpus domain

Inspected and implemented 4 October 2026. Runtime ownership is
`src/internal/google.ts`; public input and response schemas are in
`src/google-contracts.ts`. Provider observations come from
`@tulipfarm/google-workspace/corpus`.

## Composition

Create `google = createGoogleKnowledge({ runtime, provider })`. Pass the same
`google` to `createKnowledgeSearch` and `createKnowledgeEmbeddings` through their
optional `google` property. Other knowledge callers can spread `google.authority`
into `createKnowledge({ runtime, ...google.authority })`.

The service exports `discover(workspaceId, userId, kind, cursor?)`,
`configure(workspaceId, userId, { commandId, selection, memberIds })`,
`list(workspaceId, userId)`,
`manage(workspaceId, userId, sourceId, { commandId, action })`,
`due(workspaceId)`, `process({ workspaceId, sourceId, generation })`,
`refresh(workspaceId, userId, sourceId)`,
`evidence(workspaceId, userId, citation)`,
`original(workspaceId, userId, documentId, revisionId)`, and
`status(workspaceId, userId, documentId)`.

The configure command ID is the source ID. Member IDs are membership incarnation
IDs. The owner is always included. Gmail rejects any other member. Source lists
are owner management views; document status requires current document authority.
Management actions are pause, resume, retry, and remove. Retry can rebind a newer
integration generation for the same Google account. A different account requires
a new source selection.

## Reconciliation and authority

This adapter uses full reconciliation rather than a changes feed. Each work item
processes one provider page, or at most 20 unseen entries during reconciliation.
Drive folder selections retain a breadth-first folder queue and the current
provider page token in SQL. Shared drives and Gmail retain provider page tokens.
The page checkpoint commits only after all item outcomes have been persisted.
Replay reuses immutable revision and publication identities.

After a complete traversal, missing items receive exact provider checks. Only
authoritative not-found or outside-selection responses tombstone documents.
Missing listing entries alone never establish deletion. A rejected page cursor
starts a new reconciliation generation without deleting unseen entries.
Limits are 20,000 traversal pages per reconciliation, 10,000 queued or visited
folders, and 20,000 retained item identities per workspace. Reaching a limit
reports failure and preserves existing data. Native originals and parser outputs
share the existing knowledge retention quotas.

Search makes no Google requests. Explicit reader refresh checks at most 20 exact
documents with that reader's own integration and a durable cursor. Each owner work
item also performs bounded proof renewal. Large sources can consequently have
unavailable coverage until enough refresh work completes. No throughput or
five-minute whole-corpus refresh capacity qualification is claimed.

Proof expiry is derived from the provider observation time, never from a local
cache read. SQL rechecks selected membership, live reader and manager account
identity, generation, status and scopes. Observed denial deletes the relevant
proof immediately. Search returns partial coverage for unavailable selected
sources and bounds `validUntil` by the actual returned proof expiries.

## Reader-first rollout

Deploy readers accepting common version 70 before applying
`common/0094_knowledge_google.sql`. Historical migration files are unchanged.
Google writes require version 70. Local ingestion and embeddings preserve their
older minimum versions; search retains its version 69 minimum and references no
Google relations before version 70. Migration composition verifies the unique
0094 prefix and preservation of old receipts.

## Automatic Knowledge

With `default-connection-knowledge` on, a newly granted Drive or Gmail read scope also
creates owner-only sources automatically; see [automatic integration Knowledge](../../docs/knowledge-defaults-delivery.md). Drive uses the
`drive-all` selection (every file the account can open, current version). Gmail uses
the whole mailbox over a rolling 90-day window, excluding Spam and Trash.
Reauthorization and existing integrations are not backfilled.

## Verification

`test/google.integration.mjs` runs through restricted PostgreSQL logins and the
actual P1 parser, lexical search, P2 embeddings, and P3 search coordinator.
Google responses and embedding vectors are fixtures. Live Google authorization,
real mailbox/Drive behavior, and production throughput remain unverified.
