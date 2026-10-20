# Confluence and Jira corpus domain

Inspected and implemented 4 October 2026. Runtime ownership is
`src/internal/atlassian.ts`; public schemas and the provider contract are in
`src/atlassian-contracts.ts`. The REST provider is `@tulipfarm/atlassian/corpus`
(`packages/atlassian/src/corpus-provider.ts`, with ADF conversion in
`packages/atlassian/src/adf-markdown.ts`). Storage is
`common/0098_knowledge_atlassian.sql`.

The provider contract lives in this package, as for Slack. `@tulipfarm/atlassian`
imports the contract; this package never imports `@tulipfarm/atlassian`.

## Composition

Create `atlassian = createAtlassianKnowledge({ runtime, provider })`. Pass the same
`atlassian` to `createKnowledgeSearch` and `createKnowledgeEmbeddings` through their
optional `atlassian` property. `externalAuthority` dispatches both source providers,
`confluence` and `jira`, to this adapter.

`atlassianCorpusFromEnvironment` reuses the existing `ATLASSIAN_REST_*` account
configuration and the `INTEGRATION_CREDENTIAL_*` keys through
`createAtlassianAccounts`. It adds no OAuth flow. Without a valid REST configuration
every provider call fails with `not-configured`; API startup is unaffected.

The service exports `sites`, `discover`, `configure`, `list`, `listDocuments`,
`manage`, `due`, `process`, `refresh`, `evidence`, `original`, and `status`, with the
same command and lease semantics as the Slack adapter.

## Selection and documents

A source selects one product on one Atlassian site (`cloudId`) and 1 to 50 targets,
sorted by `kind:id`:

| Product    | Target    | Content                                                                                                                |
| ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| Confluence | `space`   | Every current page in the space.                                                                                       |
| Confluence | `page`    | The page; with `descendants: true`, also its current child pages at any depth returned by the v2 descendants endpoint. |
| Jira       | `project` | Every issue in the project.                                                                                            |

The configure command ID is the source ID. Member IDs are membership incarnation IDs.
The owner is always included.

One document is one page or one issue, up to 1 MiB of Markdown. Larger items, and
issues with more than 1,000 comments, are recorded as `item-too-large`. When such a
version replaces an imported item, import details report the failure with
`historical: true` and offer the stored original only as the earlier version, as
described in [GitHub replacements](GITHUB.md).

- A Confluence page is read with `body-format=atlas_doc_format`. Markdown keeps the
  page ID, space, version, creator account ID and time, and last editor account ID and
  time. The revision is the Confluence version number.
- A Jira issue keeps its key, ID, project, type, status, reporter, created and updated
  times, description, and each allowed comment with author name, account ID, created
  time and edit time. The revision is the issue `updated` timestamp.
- A comment with a `visibility` restriction (role or group), or a Jira Service
  Management comment with `jsdPublic: false`, is omitted from the document entirely.
  Every reader sees the same Markdown, so content visible only to some issue viewers
  is never stored.

Markdown is the immutable original in `tf_knowledge_atlassian_originals`. Attachments,
macros with no text, worklogs and change history are not imported.

## Authority

Effective access is the intersection of:

1. current workspace membership;
2. the selected member audience (`tf_knowledge_atlassian_members`);
3. the reader's own active personal `atlassian-rest` account with a verified
   Atlassian identity whose accessible sites include the source site, and the read
   scope for the product (`read:page:confluence` or `read:jira-work`);
4. an authoritative check, made with that account, that the reader can currently view
   that exact page or issue.

Item 4 uses batch reads that return only what the caller may view: `GET
/wiki/api/v2/pages?id=…` for pages, which applies page and inherited restrictions,
and `POST /rest/api/3/issue/bulkfetch` for issues, which applies project permissions
and issue security levels. Up to 50 items are checked per request.

`tf_knowledge_atlassian_access` stores each check per source, item and member. It
expires five minutes after the time recorded before the request. A fence generation
rejects a check that started before a later denial. Failed, rate-limited or timed-out
checks never write. The binding includes the account ID, Atlassian account ID and
account generation. Per-document `tf_knowledge_access_proofs` rows copy the
observation time and expiry and bind the current revision.

`tf_knowledge_atlassian_readers` and `tf_knowledge_atlassian_reader()` re-evaluate
items 1 to 3 on every read. Disconnect, reconnect, token refresh (each changes the
account generation), loss of the site, membership removal, audience removal, and the
owner's own account leaving the active state therefore take effect without a provider
call. Business accounts and MCP accounts never prove personal access. Workspace admins
receive nothing implicitly.

## Reconciliation

Each work item lists one page (25 items) of one target with the owner's account, then
checks the owner's access to that page of items in one batch request. The cursor
commits only after every item outcome is persisted. After all targets are traversed,
items not seen in this pass get an exact read. Only a 404, a 403, a page outside the
selected subtree or space, or an issue moved to another project tombstones that one
document. A partial or failed listing never does.

Failures are isolated by scope:

- One page or issue that fails to read or parse records its own failure and is
  retried on later passes. The source stays `ready`.
- A target whose listing returns 403 or 404 becomes `unavailable` with that reason.
  Its documents stay retained but unreadable; other targets continue. The next
  successful listing reactivates it.
- Credential errors and rate limits stop the work item. A rate limit honors
  `Retry-After`; the cursor is kept.

Search makes no Atlassian requests. Readers refresh up to 100 items per request.
Owner work items renew at most 50 stale owner checks each.

## Reader-first rollout

Deploy readers accepting the new common version before applying
`common/0098_knowledge_atlassian.sql`. Atlassian writes require
`atlassianKnowledgeVersion`. Search keeps its older minimum and references no
Atlassian relation below that version. Atlassian SQL is included in a search only
when the member belongs to an Atlassian source.

The REST OAuth app must grant `read:page:confluence` and `read:space:confluence` for
Confluence, `read:jira-work` for Jira, and `offline_access` for refresh tokens. Adding
scopes to `ATLASSIAN_REST_SCOPES` changes the configuration hash, so existing REST
accounts must reconnect. Page subtree selections may additionally need the granular
hierarchy scope; this was not verified against a live site.

## Automatic Knowledge

With `default-connection-knowledge` on, the first successful personal REST Knowledge
consent with `read:jira-work` or `read:page:confluence` also creates owner-only sources for
every visible Jira project or Confluence space on each approved site, current content only;
see [automatic integration Knowledge](../../docs/knowledge-defaults-delivery.md). MCP tools never trigger indexing, and the Integrations sheet
offers **Allow Knowledge access** when REST consent is missing or insufficient.

## Verification

`test/atlassian.integration.mjs` uses restricted PostgreSQL logins, the actual parser,
lexical search, embeddings, and the search coordinator with a fixture provider.
`packages/atlassian/test/corpus-provider.test.mjs` covers the REST mapping and the
ADF serializer. Live Confluence and Jira, their rate limits, and throughput remain
unverified.
