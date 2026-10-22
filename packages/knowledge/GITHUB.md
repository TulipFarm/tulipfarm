# GitHub corpus domain

Inspected and implemented 4 October 2026. Runtime ownership is
`src/internal/github.ts`; public schemas and the provider contract are in
`src/github-contracts.ts`. The GitHub REST and GraphQL provider is
`@tulipfarm/github/corpus` (`packages/github/src/corpus-provider.ts`).

The provider contract lives in this package, as for Slack, so that
`@tulipfarm/github` can import it. This package never imports `@tulipfarm/github`.

## Composition

Create `github = createGitHubKnowledge({ runtime, provider })`. Pass the same
`github` to `createKnowledgeSearch` and `createKnowledgeEmbeddings` through their
optional `github` property, next to `google` and `slack`. `externalAuthority`
dispatches source and proof checks to the adapter that owns each provider.

`githubCorpusFromEnvironment` reuses the personal GitHub OAuth configuration
(`GITHUB_OAUTH_*`) and the integration credential keyring
(`INTEGRATION_CREDENTIAL_KEY*`). It adds no OAuth flow. Credentials come only from
`createGitHubAccounts().withCredential`, which decrypts the token of an active
account owned by the calling member. Without OAuth configuration or keys, every
provider call fails with `not-configured`; API startup is unaffected.

The service exports `discover`, `configure`, `list`, `listDocuments`, `manage`,
`due`, `process`, `refresh`, `evidence`, `original`, and `status`, with the same
command and lease semantics as the Slack adapter.

## Selection and documents

A source binds one of the owner's personal GitHub accounts and selects 1 to 20
repositories by `owner/name`, one or more content kinds, and an `after` date within
366 days. The configure command ID is the source ID. Member IDs are membership
incarnation IDs. The owner is always included. Any member may be selected; private
repositories never become workspace-public because every reader needs their own
proof (see Authority).

Configuration resolves each name with `GET /repos/{owner}/{repo}` and stores
GitHub's numeric repository ID. All later requests use `/repositories/{id}`, so a
repository rename or transfer keeps the same source row and only updates its
displayed name. A redirected name at configuration time (an old name) is rejected
with `invalid-selection`.

| Kind              | Listing                                                                                                                                                                                                                                                      | Native ID                                 | Revision                              | Bounds                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `docs`            | Recursive tree of the default-branch head commit, filtered to Markdown and text paths (`.md`, `.markdown`, `.mdx`, `.mdown`, `.txt`, `.text`, `.rst`, `.adoc`, `.asciidoc`, `.org`, plus `README`, `CHANGELOG`, `CONTRIBUTING`, `LICENSE` and similar names) | `doc:{repoId}:{path}`                     | `blob:{blobSha}`                      | 256 KiB per file, first 1,000 matching paths, UTF-8 only |
| `issues`, `pulls` | `GET /repositories/{id}/issues?state=all&since={after}` sorted by update                                                                                                                                                                                     | `issue:{repoId}:{n}`, `pull:{repoId}:{n}` | `issue:{updated_at}:{comments}`       | 500 comments                                             |
| `discussions`     | GraphQL `repository.discussions` ordered by update                                                                                                                                                                                                           | `discussion:{repoId}:{n}`                 | `discussion:{updatedAt}:{totalCount}` | 100 comments, 50 replies each                            |

Docs are not date-bounded; issues, pull requests and discussions must have been
updated after `after`. Every document is Markdown in `tf_knowledge_github_originals`
and starts with provenance: repository, numeric ID, path and the commit and blob SHAs
for files; author login and UTC time of the description and every comment for
issues, pull requests and discussions. Canonical URLs for files are commit-pinned
`blob/{commit}/{path}` links. Pull requests import the description and conversation
comments, not inline review comments. Larger items are recorded as `too-large`, and
non-UTF-8 files as `unsupported`; neither is published.

When such a version replaces an imported item, the earlier revision stays stored
but loses its publication, so search and evidence stop returning it. Import details
and the status route report the newer version: `failed` with its coverage failure,
or `queued` while it awaits import, with `historical: true`. The download then
returns the earlier version, and the web UI labels it **Download earlier version**.
Corrected 5 October 2026 for issue #455; Slack and Atlassian follow the same rule.

## Authority

Effective access is the intersection of:

1. current workspace membership;
2. the selected member audience (`tf_knowledge_github_members`);
3. one of the reader's own personal GitHub accounts in `tf_github_accounts`, active,
   with an identity and credential, not expired, at the generation that was checked;
4. the owner's bound account still active at its bound generation for the same
   GitHub user;
5. a check of that repository made with that reader account
   (`GET /repositories/{id}`, pull permission; private and internal repositories also
   require the `repo` scope).

`tf_knowledge_github_access` stores the check per source, repository and member.
It expires five minutes after the provider observation time, recorded before the
request. A fence generation rejects a check that started before a later denial.
Failed, rate-limited or timed-out checks never write. Per-document
`tf_knowledge_access_proofs` rows copy that observation time and expiry and also
bind the current revision.

A reader with several connected accounts is checked with up to three of them; the
first that can read the repository becomes the binding for that row. A 401 from
GitHub marks the account `reconnect-required` and increments its generation through
the existing account service.

`tf_knowledge_github_readers` and `tf_knowledge_github_reader()` re-evaluate items 1
to 4 on every read. Disconnecting or reconnecting an account (both change its
generation), token expiry, membership removal, audience removal and the owner's
disconnect therefore take effect without a provider call. Workspace admins receive
nothing implicitly. A changed OAuth configuration hash is not visible to SQL; the
next credential use rejects the account and changes its generation.

A repository the owner can no longer read is marked `unavailable` with reason
`forbidden`. Its content stays retained but unreadable; other repositories continue
to sync and the source is not revoked. The next sync or `retry` re-checks it and
reactivates it if access returns. `retry` also rebinds the source to the owner's
current active account for the same GitHub user.

## Reconciliation

Each work item lists one provider page for one repository, after an owner check.
The provider cursor encodes the phase (`docs:{commit}:{offset}`, `issues:{page}`,
`discussions:{endCursor}`), so a docs listing stays pinned to one commit. The cursor
commits only after every item outcome is persisted. After all repositories are
traversed, unseen items in available repositories get an exact read. Only a 404 or
410 file or issue, a transferred issue (301), a missing discussion, or an item now
outside the window tombstones a document. A file rename therefore tombstones the old
path and publishes the new path. A partial, truncated or failed listing, or an
unavailable repository, never tombstones.

Rate limits (`429`, or `403` with `x-ratelimit-remaining: 0` or `retry-after`, or a
GraphQL `RATE_LIMITED` error) fail the work item with `rate-limited`; the next
attempt waits for `retry-after` or `x-ratelimit-reset`, at least 30 seconds. Readers
refresh up to 20 repositories per request. Owner work items renew at most five
stale owner checks each. Search makes no GitHub requests.

## Reader-first rollout

Deploy readers accepting common version 73 before applying
`common/0097_knowledge_github.sql`. GitHub writes require version 73. Search keeps
its version 69 minimum and references no GitHub relations before version 73. GitHub
SQL is included in a search only when the member belongs to a GitHub source; its
eligibility is read through `tf_knowledge_github_eligible_for()`, whose plan is
cached per session.

## Automatic Knowledge

With `default-connection-knowledge` on, the first authorization of a personal account also
creates owner-only sources for every readable repository, including new ones; see
[automatic integration Knowledge](../../docs/knowledge-defaults-delivery.md). Automatic sources include `code`: readable UTF-8 files at the
default-branch head, at most 1,000 per repository. Sensitive, generated, vendored and binary
paths and files beyond the bound are recorded as excluded skips (at most 200 listed).
Reconciliation asks the provider which unlisted files a new head pushed beyond the bound
and gives them the same excluded skip, so coverage stays within 1,000; their originals are
retained. A truncated tree or failed listing proves nothing displaced and keeps prior files.
Issues, pull requests and discussions use a rolling 90-day window.

## Verification

`test/github.integration.mjs` uses restricted PostgreSQL logins, the actual parser,
lexical search, embeddings, and the search coordinator with a fixture provider.
`packages/github/test/corpus-provider.test.mjs` covers REST and GraphQL mapping
against `packages/github/test/corpus-fixture.mjs`.
`apps/api/test/knowledge-github-code-bound.integration.mjs` runs the real provider and
engine across a head change that displaces files beyond a scaled-down code bound. Live GitHub, GitHub rate limits
under load, and throughput remain unverified.
