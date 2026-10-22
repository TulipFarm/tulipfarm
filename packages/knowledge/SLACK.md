# Slack corpus domain

Inspected and implemented 4 October 2026. Runtime ownership is
`src/internal/slack.ts`; public schemas and the provider contract are in
`src/slack-contracts.ts`. The Slack Web API provider is
`@tulipfarm/slack/corpus` (`packages/slack/src/corpus-provider.ts`).

The provider contract lives in this package because `@tulipfarm/slack` already
depends on `@tulipfarm/conversations`, which depends on this package. The provider
package imports the contract; this package never imports `@tulipfarm/slack`.

## Composition

Create `slack = createSlackKnowledge({ runtime, provider })`. Pass the same `slack`
to `createKnowledgeSearch` and `createKnowledgeEmbeddings` through their optional
`slack` property, next to `google`. `externalAuthority` dispatches source and proof
checks to the adapter that owns each provider.

`slackCorpusFromEnvironment` reuses `SLACK_CONFIGURATION` and
`SLACK_CREDENTIAL_KEYS`. Without `memberLinking`, or with unusable values, every
provider call fails with `not-configured`; API startup is unaffected.

The service exports `discover`, `configure`, `list`, `listDocuments`, `manage`,
`due`, `process`, `refresh`, `evidence`, `original`, and `status`, with the same
command and lease semantics as the Google adapter.

## Selection and documents

A source selects 1 to 50 conversations and an `after` date within 366 days.
`channels` accepts public and private channels; `personal` accepts direct and group
messages and is owner-only. The configure command ID is the source ID. Member IDs
are membership incarnation IDs. The owner is always included.

One document is one thread unit: a top-level message and its replies, up to 1,000
messages and 1 MiB of Markdown. Larger threads are recorded as `thread-too-large`
and are not published. When a larger version replaces an imported thread, import
details report the failure with `historical: true` and offer the stored original
only as the earlier version, as described in [GitHub replacements](GITHUB.md).
Markdown keeps the author's Slack user ID and the UTC time of
every message and edit. The revision is a hash of each message's timestamp, author,
subtype, edit timestamp, and text hash. An edit, a new reply, or a deleted reply
changes it. Markdown is the immutable original in `tf_knowledge_slack_originals`.

A message that Slack marks with `bot_id` or the `bot_message` subtype is withheld.
Its heading keeps the author and time, its text becomes
`_Bot message withheld from Knowledge._`, and a bot root titles the unit
`Bot message`. Its text hash does not enter the revision. A TulipFarm answer can
derive from resources, files, or chats that its Slack readers cannot read, and
Knowledge has no way to authorize those sources again on each read. Corrected
5 October 2026 for issue #442. Earlier units that stored bot text get a new revision
and are re-imported on the next listing. Units without bot messages keep their
revision.

## Authority

Effective access is the intersection of:

1. current workspace membership;
2. the selected member audience (`tf_knowledge_slack_members`);
3. the reader's own linked Slack identity, from the existing member-linking tables,
   on the active installation generation, not revoked, with the history and read
   scopes for the conversation kind;
4. a membership check of that conversation made with that identity
   (`conversations.info`; channels require `is_member: true`).

`tf_knowledge_slack_access` stores the check per source, conversation and member.
It expires five minutes after the provider observation time, recorded before the
request. A fence generation rejects a check that started before a later denial.
Failed or timed-out checks never write. Per-document `tf_knowledge_access_proofs`
rows copy that observation time and expiry and also bind the current revision.

`tf_knowledge_slack_readers` and `tf_knowledge_slack_reader()` re-evaluate items 1
to 3 on every read. Unlinking, relinking (new `authorized_at`), installation
disconnect, per-user revocation, membership removal and audience removal therefore
take effect without a provider call. Workspace admins receive nothing implicitly.

An archived conversation, an owner who left it, an inaccessible conversation, or a
conversation whose kind no longer matches is marked `unavailable` with that reason.
Its content stays retained but unreadable; other conversations continue to sync.
`retry` re-inspects the selection and reactivates conversations.

## Reconciliation

Each work item lists one `conversations.history` page of 20 messages for one
conversation, after an owner membership check. The cursor commits only after every
item outcome is persisted. After all conversations are traversed, unseen items in
available conversations get an exact `conversations.replies` read. Only
`thread_not_found`, a missing root, or a root outside the window tombstones a
document. A partial or failed listing, or an unavailable conversation, never does.

Search makes no Slack requests. Readers refresh up to 20 conversations per request.
Owner work items renew at most five stale owner checks each.

## Reader-first rollout

Deploy readers accepting common version 72 before applying
`common/0096_knowledge_slack.sql`. Slack writes require version 72. Search keeps its
version 69 minimum and references no Slack relations before version 72. Slack SQL is
included in a search only when the member belongs to a Slack source; its eligibility
is read through `tf_knowledge_slack_eligible_for()`, whose plan is cached per session.

## Automatic Knowledge

With `default-connection-knowledge` on, completing a member link also creates owner-only
sources for joined public and private channels over a rolling 90-day window; see
[automatic integration Knowledge](../../docs/knowledge-defaults-delivery.md). Installation alone does not qualify. TulipFarm never joins
channels, and DMs and group messages stay opt-in.

## Verification

`test/slack.integration.mjs` uses restricted PostgreSQL logins, the actual parser,
lexical search, embeddings, and the search coordinator with a fixture provider.
`packages/slack/test/corpus-provider.test.mjs` covers the Web API mapping. Live
Slack, Slack rate limits under load, and throughput remain unverified.
