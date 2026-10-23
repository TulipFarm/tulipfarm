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

A source binds one of the owner's personal GitHub accounts and selects either every
repository that account can read (`scope: 'all'`, with an empty `repositories` list)
or 1 to 1,000 repositories by `owner/name`. It also selects one or more content
kinds (all kinds by default), optional `excludePaths` patterns and an optional
`after` cutoff date. Without `after`, issues, pull requests and discussions are
imported for their full history. A cutoff may be any date that is not in the
future. A rolling `window` is rejected. There is no limit on the number of
Knowledge sources in a workspace. The configure command ID is the source ID. Member IDs are membership
incarnation IDs. The owner is always included. Any member may be selected; private
repositories never become workspace-public because every reader needs their own
proof (see Authority).

Configuration resolves each name with `GET /repos/{owner}/{repo}` and stores
GitHub's numeric repository ID. All later requests use `/repositories/{id}`, so a
repository rename or transfer keeps the same source row and only updates its
displayed name. A redirected name at configuration time (an old name) is rejected
with `invalid-selection`.

| Kind              | Listing                                                                                                                                     | Native ID                                 | Revision                              | Parts                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| `docs`            | Every file in the default-branch tree whose path looks like documentation (`.md`, `.txt`, `.rst`, `.adoc`, `README`, `LICENSE` and similar) | `doc:{repoId}:{path}`                     | `blob:{blobSha}`                      | 128 KiB of text each, split at a line break     |
| `code`            | Every other file in the default-branch tree                                                                                                 | `code:{repoId}:{path}`                    | `blob:{blobSha}`                      | 128 KiB of text each; a binary file is one part |
| `issues`, `pulls` | `GET /repositories/{id}/issues?state=all` sorted by update, with `since={after}` only when a cutoff is set                                 | `issue:{repoId}:{n}`, `pull:{repoId}:{n}` | `issue:{updated_at}:{comments}`       | 100 comments each                               |
| `discussions`     | GraphQL `repository.discussions` ordered by update                                                                                          | `discussion:{repoId}:{n}`                 | `discussion:{updatedAt}:{totalCount}` | 100 comments each, with every reply             |

There is no file-type allowlist, built-in exclusion or per-repository count cap:
`.env` files, keys, `node_modules`, build output, lockfiles, minified files, maps and
snapshots are indexed like any other file, because the repository owner chose to
commit them. The doc or code kind is only a label. The single extension point for
excluding paths is `githubPathIndexable(path)` in `packages/github/src/corpus-provider.ts`,
which currently accepts every path; user opt-out patterns compose with it.

Part 1 keeps the plain native ID; part `k` of a larger item is
`{kind}:{repoId}:/p/{k}/{rest}`, titled `(part k of n)`. A path longer than 1,024
bytes is identified by `/h/{sha256(path)}` instead of the path, and the full path is
stored in `tf_knowledge_github_items.path` so the file can be read again.

Files up to 1 MB are read through the contents API. Larger files are streamed from
`GET /repositories/{id}/git/blobs/{sha}` with `Accept: application/vnd.github.raw`;
only the part being read and an 8,000-byte head are kept in memory, so memory stays
near one part whatever the file size. GitHub's blob limit (100 MB) is the only size
bound. The blobs API ignores `Range`, so reading part `k` streams the bytes before it.

Text is decoded by its byte-order mark (UTF-8, UTF-16LE, UTF-16BE); otherwise as UTF-8,
falling back to Windows-1252 (a superset of Latin-1) for bytes that are not valid
UTF-8. Line endings become `\n` and other control characters become U+FFFD. A file
whose first 8,000 bytes contain a NUL without a UTF-16 byte-order mark, or whose
extension marks an image, PDF, archive, office document, font, media or executable,
is binary. A binary file is indexed as a placeholder holding its path, size and media
type, noting that content extraction is pending OCR. `createGitHubCorpusProvider`
accepts an `extractBinary` hook that receives the file's path, media type, size and a
streamed body and may return its text instead.

When the recursive tree is truncated or has more than 10,000 entries, the listing
walks the tree one directory at a time (`GET /repositories/{id}/git/trees/{sha}`), at
most 50 tree requests per page, and the cursor records the position in the walk. A
single directory that GitHub itself truncates is recorded as an excluded
`/truncated/{treeSha}` item, so the gap is visible.

Docs and code are not date-bounded; with a cutoff, issues, pull requests and
discussions must have been updated after `after`. Every document is Markdown in `tf_knowledge_github_originals`
and starts with provenance: repository, numeric ID, path and the commit and blob SHAs
for files; author login and UTC time of the description and every comment for
issues, pull requests and discussions. Canonical URLs for files are commit-pinned
`blob/{commit}/{path}` links. Pull requests import the description and conversation
comments, not inline review comments. Every issue comment and every discussion comment
and reply is paged through; only a single part whose Markdown would exceed 1 MiB is
recorded as `too-large`, and a later part of a file found to be binary as
`unsupported`. Neither is published.

When such a version replaces an imported item, the earlier revision stays stored
but loses its publication, so search and evidence stop returning it. Import details
and the status route report the newer version: `failed` with its coverage failure,
or `queued` while it awaits import, with `historical: true`. The download then
returns the earlier version, and the web UI labels it **Download earlier version**.
Corrected 5 October 2026 for issue #455; Slack and Atlassian follow the same rule.

## Opting out

Everything is indexed by default. The owner narrows a source with
`POST /v1/workspaces/:workspaceId/knowledge/github/sources/:sourceId/settings`,
which replaces the content kinds, `excludePaths`, the `after` cutoff and the set
of excluded repositories. An excluded repository keeps its row with `excluded`
set. Its documents and any documents of a removed kind are withdrawn at once.
A changed cutoff or new patterns withdraw content on the next sync. An
all-repositories source never re-adds an excluded repository. Including it again
resumes its sync.

At the start of every pass, an all-repositories source lists the account's
repositories and adds any it does not know yet, up to 1,000 repositories per
source. Repositories that another live source of the same owner already covers
are skipped. Private repositories are skipped when the account lacks the `repo`
scope. A repository that cannot be resolved is skipped without failing the pass.

`excludePaths` holds up to 20 regular expressions of at most 200 characters.
Each is matched against a repository-relative file path for the `docs` and `code`
kinds; a matching path is not listed or read. Patterns run on the JavaScript
backtracking engine, so configuration rejects shapes that can backtrack
catastrophically:

- nested quantified groups such as `(a+)+`;
- backreferences;
- more than one unbounded repetition (`*`, `+`, `{n,}`);
- more than one optional or bounded repetition alongside an unbounded one, or
  more than four without one.

A leading `^.*` and a trailing `.*$` are removed first, because they do not
change what matches. Paths longer than 1,024 characters are never tested.
Patterns compile with the `su` flags.

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
The provider cursor encodes the phase (`docs:{commit}:{offset}`, `docs:{commit}:w{index path}`
while walking directories, either with `+{part}` inside a file, `issues:{page}`,
`discussions:{endCursor}`), so a file listing stays pinned to one commit. The cursor
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

Every authorization of a personal account creates one owner-only all-repositories
source with every content kind and full history, unless the owner already has one
for that account. Indexing starts at once. Unlike other providers, GitHub ignores
the `default-connection-knowledge` flag and the automatic Knowledge gate never
holds its sources. Automatic sources include `code`: every file at the default-branch
head, with no count cap.
Issues, pull requests and discussions keep their full history. Migration
`common/0006_github_knowledge_opt_out.sql` removes the earlier rolling 90-day window
and its date from existing GitHub sources. It also records a default intent for every
active account, so existing accounts get their all-repositories source.

## Verification

`test/github-opt-out.integration.mjs` covers automatic creation, new repositories
on later passes, repository, kind, path and cutoff opt-outs, full history and the
1,000-repository bound. `test/github.integration.mjs` uses restricted PostgreSQL logins, the actual parser,
lexical search, embeddings, and the search coordinator with a fixture provider.
`packages/github/test/corpus-provider.test.mjs` covers REST and GraphQL mapping
against `packages/github/test/corpus-fixture.mjs`.
`apps/api/test/knowledge-github-all-files.integration.mjs` runs the real provider and
engine across head changes: formerly excluded files, a file in parts, a binary
placeholder, a hashed long path, a truncated tree walk and deletions. Live GitHub, GitHub rate limits
under load, and throughput remain unverified.
