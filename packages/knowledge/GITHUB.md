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

`GITHUB_OAUTH_*` holds the client ID, secret and callback of the TulipFarm GitHub App.
A GitHub App user token has no scopes: it reaches what the App's permissions and
the member's own access allow, on repositories where the App is installed. A repository
without the App is invisible to the member's token. Changing the client ID changes the
OAuth configuration hash, so existing accounts must reconnect once.

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
| `issues`, `pulls` | `GET /repositories/{id}/issues?state=all&sort=updated&direction=asc`, continued with `since` from the last item's update time               | `issue:{repoId}:{n}`, `pull:{repoId}:{n}` | `issue:{updated_at}:{comments}`       | 100 comments each                               |
| `discussions`     | GraphQL `repository.discussions` ordered by update                                                                                          | `discussion:{repoId}:{n}`                 | `discussion:{updatedAt}:{totalCount}` | 100 comments each, with every reply             |
| `commits`         | `GET /repositories/{id}/commits?sha={head}`, 100 a page; later passes `GET /repositories/{id}/compare/{indexed}...{head}`                   | `commit:{repoId}:{sha}`                   | `commit:{sha}`                        | One per commit                                  |

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
only the part being produced and an 8,000-byte head are kept in memory, so memory
stays near one part whatever the file size. GitHub's blob limit (100 MB) is the only
size bound. The blobs API ignores `Range`, so a file's parts are listed together on
one page and the engine reads them in a single pass over one download
(`GitHubCorpusProvider.readFile`), handing each part to ingestion as it is produced.
Each part still goes through the usual revision check, and a failure stays with the
part it affects: a part that cannot be indexed records its own failure, and an error
that ends the download is recorded for the parts it did not reach. The sweep re-reads
a file's unseen parts the same way, from the first of them. A provider without
`readFile` falls back to reading each part on its own.

Issues and pull requests are listed by update time, oldest first, 100 a page, so
a repository with more than 50,000 of them (500 pages) is listed to the end rather
than stopping at a page-number limit. Each page continues with `since` set to the
last item's update time. Items sharing one update second can straddle a page boundary, so the next request starts
one second earlier and drops items before that second; when a whole page shares one
second, the listing pages by number within that second until it ends. An issue
updated while a tie group of more than 100 is being paged can shift that group by
one item; the next full pass reads it. A checkpointed page-number cursor from before
this change restarts the issue listing.

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

Docs, code and commits are not date-bounded; with a cutoff, issues, pull requests and
discussions must have been updated after `after`. Every document is Markdown in `tf_knowledge_github_originals`
and starts with provenance: repository, numeric ID, path and the commit and blob SHAs
for files; author login and UTC time of the description and every comment for
issues, pull requests and discussions. Canonical URLs for files are commit-pinned
`blob/{commit}/{path}` links. Pull requests import the description and conversation
comments, not inline review comments.

A commit document holds the full SHA, the author and committer names, GitHub logins and
dates, the parents, the full message and every changed file GitHub lists with its
status, previous path for a rename, and line additions and deletions. It never holds
diffs or email addresses. Its title is `{owner/name}@{short sha}: {first message line}`
and its canonical URL is `https://github.com/{owner/name}/commit/{sha}`. Changed files
come from `GET /repositories/{id}/commits/{sha}`, following GitHub's file pages up to
its 3,000-file cap. A commit at that cap notes that it may change more files. When
GitHub cannot return a commit's files (a response over 8 MiB, since GitHub includes
every patch), the document notes the gap and falls back to
`GET /repositories/{id}/git/commits/{sha}` for the message, names and dates. A commit
never changes, so a known SHA is never read again. Every issue comment and every discussion comment
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
source. A private repository visible without the `repo` scope is added and
reported as needing permission (see [Access status](#access-status)). A repository
that cannot be resolved is skipped without failing the pass.

### Chosen sources own their repositories

A repository can be both in an all-repositories source and in a source whose
owner chose repositories by name. The chosen source owns it, and the
all-repositories source skips it, whichever was created first. A chosen source
owns a repository when it has the same owner, is active or paused, keeps the
repository included, its account is not disconnected, and it is shared with
every member of the all-repositories source. When several chosen sources qualify,
the one with the lowest source ID is named. If the all-repositories source is
shared with a member the chosen source lacks, it keeps the repository so that
member does not lose access; the owner then sees the repository from both sources.
Of two all-repositories sources, each still skips repositories the other already
knows.

- When a chosen source adds, or includes again, a repository the all-repositories
  source indexes, the all-repositories source tombstones that repository's
  documents and revokes its access rows in the same transaction, and restarts its
  current pass. It keeps the repository row, reported as `indexed-elsewhere`.
- When the chosen source excludes the repository or is removed, the
  all-repositories source restarts its pass and indexes the repository again, with
  a full listing and, for commits, the full history.
- Every pass of an all-repositories source re-checks ownership at the start,
  withdraws repositories that became owned (for example after an account was
  reconnected), skips owned repositories in listings and in the sweep, and indexes
  released ones (for example after the chosen source's account was disconnected).
  Without one of the hooks above, a change of ownership is therefore applied on the
  next pass, so the repository can be found in both sources for at most one pass.
- Owned repositories are not counted in the health counts for permissions, lost
  access or failed sources, and still count towards the 1,000-repository bound.

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
`forbidden`. Its
content stays retained but hidden from search and is not tombstoned; other
repositories continue to sync and the source is not revoked. The next sync or
`retry` re-checks it and reactivates it if access returns. A claimed pass, like
`retry`, rebinds the source to the owner's current active account for the same
GitHub user once that account is live at a new generation, so reconnecting resumes
syncing without another action.

Repositories are keyed by GitHub repository ID. The check by ID updates the full
name, visibility and title, so a renamed or transferred repository keeps its row,
its selection and its documents. Existing documents keep their earlier canonical
URL and title until the item itself changes; GitHub redirects those URLs.

## Access status

The source DTO reports:

- `connection`: `active`, or `reconnect-required` when the owner's bound account is
  not live (revoked, expired or rejected token, or a removed or suspended
  installation). The Integrations page shows a reconnect prompt; only the owner
  sees the Reconnect GitHub button, and shared readers are told the owner must
  reconnect.
- `repositoryCounts`: `active`, `excluded`, `indexedElsewhere`, `needsPermission`
  and `accessLost`.

Each repository has a `status`, `missingKinds` and `indexedBy` (the `sourceId` and
title of the chosen source that owns it, or `null`). The all-repositories source
settings and repository list show "Indexed by <title>" for those repositories.

| Status              | Meaning                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `active`            | Every selected kind is readable.                                                                                                                                                     |
| `excluded`          | The owner opted the repository out.                                                                                                                                                  |
| `indexed-elsewhere` | Only for an all-repositories source: a chosen source of the same owner indexes the repository (see [Chosen sources own their repositories](#chosen-sources-own-their-repositories)). |
| `needs-permission`  | The repository is visible but at least one selected kind is not readable: the account lacks the `repo` scope (every kind is missing), or GitHub returned 403 or 404 for that kind.   |
| `access-lost`       | A repository that was readable is now forbidden or removed from the account or installation.                                                                                         |

A kind the listing cannot read (403, 404, GraphQL `FORBIDDEN` or insufficient
scopes) is recorded as an item row with failure `denied`, no document and a
`{kind}:{repository}:/denied` native ID. Existing documents of that kind stay
hidden, not tombstoned, until a later pass reads the kind again. A marker applies
only while the latest completed pass or the current one listed it; it counts
toward the source's item rows but not its document counts.

`search_knowledge` adds the notice `github-access-needs-attention` when the member
can read a GitHub source that is disconnected, whose owner must reconnect, or that
has a repository needing permission or with lost access. The instruction tells the
model to say GitHub knowledge may be out of date and to include
`[Reconnect GitHub](#github-reconnect)`, which the chat renders as a link to the
workspace Integrations page.

`health` adds `reconnectSources`, `permissionRepositories` and `lostRepositories`,
exported as the gauges `cloud_knowledge_reconnect_sources`,
`cloud_knowledge_permission_repositories` and
`cloud_knowledge_lost_repositories` with only the `provider` label (`github`).

## Reconciliation

A run claims the source for a 15-minute lease and works in a time-boxed loop of at
most five minutes. Each step lists one provider page of 100 items (the GitHub
maximum for REST lists, comments, commits and GraphQL discussions) for one
repository, after an owner check, or re-reads one batch of 100 unseen items. Items in
a step are fetched with bounded concurrency (four at a time). The provider cursor
encodes the phase (`docs:{commit}:{offset}`, `docs:{commit}:w{index path}` while
walking directories, `issues:{updatedAt}` or `issues:{updatedAt}/{page}` inside a
group of items updated in the same second, `discussions:{endCursor}`,
`commits:{head}:{page}` or `commits:{indexed}..{head}:{page}`), so a file or commit
listing stays pinned to one commit. A file page ends only between files, so it can
hold more than 100 parts. The cursor is checkpointed after every step, and only once
every item outcome before it is persisted. While work progresses the run renews its lease every minute
and heartbeats its Temporal activity (five-minute heartbeat timeout), so only a
genuinely stuck run is restarted. A run that exhausts its budget releases the lease
and the next due check continues from the checkpoint.

After all repositories are traversed, unseen items in available repositories get an
exact read. Only a 404 or 410 file or issue, a transferred issue (301), a missing
discussion, or an item now outside the window tombstones a document. A file rename
therefore tombstones the old path and publishes the new path. A partial, truncated
or failed listing, or an unavailable repository, never tombstones.

There is no cap on items or listing pages per source; progress is visible through
the source's total, ready and failed counts. The only loop guard is a provider cursor
that repeats (the same cursor returned for the next page, or one already seen in the
run), which fails the source with `invalid-cursor`. This applies to every phase,
commits included.

When the read returns a newer revision than the listing, the newer revision is
indexed immediately and the item records the revision that was read; content is
never stored under a revision it does not match.

Commits are listed last, so a long history never delays a repository's other kinds.
`tf_knowledge_github_repositories.commit_head` records the default-branch head whose
whole history was last listed. The first pass lists every commit reachable from the
head, with no date cutoff. Later passes compare the recorded head with the current one
and list only the newer commits; every published commit item of the repository then
counts as seen without a GitHub request, and one not yet published is read again by the
sweep. When the head no longer extends the recorded one (a force push) or GitHub cannot
make the comparison, the pass lists the whole history again. The recorded head moves
only when a listing finishes, so an interrupted pass compares from the older head.
A commit removed from the default branch by a force push stays indexed while GitHub
still serves it by SHA.

### Incremental passes

A pass is full or incremental. A full pass lists every repository as above and
re-reads every unseen item. An incremental pass lists only what changed since the
repository's last completed listing, recorded per repository in the source cursor:

- Files: the pass reads the default-branch head once. An unchanged head skips the
  docs and code listings. A changed head is compared with the recorded one
  (`GET /repositories/{id}/compare/{base}...{head}`); added, modified and renamed
  files are listed with their blob revision, and removed files and the old path of a
  rename are tombstoned. Path, kind and repository opt-outs apply as in a full
  listing, so an excluded file is never listed. A missing base (force push),
  diverged history, 300 or more changed files, a truncated directory, or a change
  too large for one page falls back to a full listing of that repository and asks
  for a full next pass. The commit listing reuses the head read for files, but keeps
  its own `commit_head` described above.
- Issues, pull requests and discussions: the listing starts from the previous
  listing's start time less five minutes, using `since` for REST and `updatedAt` for
  GraphQL, instead of the whole history.

An incremental pass re-reads only unseen items that previously failed with a
retryable failure, or whose kind was denied; tombstoning by absence happens only in
full passes. A pass is full when the source has no completed full pass, the last one
is older than the recheck interval (`GITHUB_KNOWLEDGE_RECHECK_MINUTES`), a fallback asked for one, or the cursor was reset (a settings
change, reconnect, manual retry or an invalid cursor). A full pass therefore
catches missed webhooks, deleted or transferred issues, and discussion comments that
do not change a discussion's `updatedAt`. Repository marks live in the cursor, so no
migration is needed.

### Failures, retries and rate limits

The provider retries transient failures (5xx, timeouts, network errors) up to four
attempts with exponential backoff and jitter (0.5 s doubling, capped at 8 s); a
`retry-after` above 8 s is returned at once. A rejected credential (401) is never
retried: it moves the source to the reconnect state. Denials (403 without a rate
limit, 404, 451) are never retried either; they mark the repository or kind (see
[Access status](#access-status)). Owner access checks get up to two more attempts in the
engine with jittered backoff; only a real denial marks a repository unavailable.

A failure that survives the retries is isolated. A failed item records `transient`
(or `invalid-response`) on itself and the pass continues. A repository whose listing
or access check keeps failing is skipped for the rest of the pass and shown as
`transient`; the source still finishes the pass as `ready` with failure `transient`,
and the next pass retries it. Isolation never tombstones.

Rate limits are a pause, not a failure. The provider remembers
`x-ratelimit-remaining` and `x-ratelimit-reset` per token and API (REST core or
GraphQL). Below 20% of the limit it spaces requests across the time left until
reset (at most ten seconds apart); at a 5% reserve, and on `429`, `403` with
`x-ratelimit-remaining: 0` or `retry-after`, or a GraphQL `RATE_LIMITED` error, it
stops with `rate-limited`. The engine then keeps the cursor, leaves the source
`syncing` with failure `rate-limited`, and schedules the next attempt at
`retry-after` or `x-ratelimit-reset` (60 seconds when unknown). Readers refresh up to
20 repositories per request. Owner work items renew at most five stale owner checks
each. Search makes no GitHub requests.

### Dispatch

The API sweep starts due sources (20 per check) every two seconds. A workspace
whose storage version the API cannot use is skipped and counted in
`cloud_dispatch_skipped_workspaces` (labels `dispatcher` and
`reason=incompatible_version`; no workspace label).

A ready source is due again after its pass, ten minutes by default
(`GITHUB_KNOWLEDGE_RECHECK_MINUTES`, 1 to 1440). Polling is the safety net
for missed events; webhooks make changes appear within seconds.

### Install link

Sign-in does not install the App. Private repositories show up only where the App is
installed. Set `GITHUB_APP_SLUG` (the `tulipfarm-app` in `github.com/apps/tulipfarm-app`)
and the repository picker shows an "Install the App" link to
`https://github.com/apps/<slug>/installations/new`. An organization owner must
approve the install.

### Webhooks

With `GITHUB_WEBHOOK_APP_ID` and `GITHUB_WEBHOOK_SECRET` set, the API accepts
GitHub deliveries at `POST /v1/github/knowledge/events`. The App is the same one
members sign in with, and `GITHUB_WEBHOOK_APP_ID` is its numeric ID. Configure it with:

- Webhook URL `https://<api host>/v1/github/knowledge/events`, content type
  `application/json`, and a secret of 32 to 4,096 characters.
- Events: `push`, `issues`, `issue_comment`, `pull_request`, `pull_request_review`,
  `pull_request_review_comment`, `discussion`, `discussion_comment`, `repository`,
  `installation` and `installation_repositories`.
- Read-only repository permissions for metadata, contents, issues, pull requests
  and discussions, which those events need.

`POST /v1/github/events` accepts the same signed deliveries for any event the App
sends. It feeds Knowledge the same way, and also keeps each accepted body for one
minute for workflow triggers. The delivery ID row stays for
`GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS` so redeliveries are recognized.

Each delivery's `X-Hub-Signature-256` is verified before anything is stored, and
deliveries are deduplicated by `X-GitHub-Delivery`: a redelivery is acknowledged
again, and a reused delivery ID with a different body is rejected with 409.
Responses are 202 for accepted, 401 for a bad signature, 400 for malformed headers
or bodies (including a delivery whose `X-GitHub-Hook-Installation-Target-ID` is not
`GITHUB_WEBHOOK_APP_ID`), 413 above 25 MiB, and 503 while webhooks are disabled.

A delivery keeps only the numeric IDs of the repositories it changes, in the
platform GitHub event inbox; its content is never indexed. Pushes count only on the
default branch, `repository` events only for renames, deletions, transfers,
visibility, archive and edit actions, and installation events for every repository
they add or remove. The dispatch sweep reads pending deliveries and makes every
active GitHub source due at once when it selects one of those repositories by ID
and has not opted it out, or when it is an all-repositories source that does not
know the repository yet (a new repository). An all-repositories source is not made
due for a repository a chosen source owns. It then closes the deliveries. A source
already running is asked to start another pass as soon as it finishes. The pass
re-reads GitHub with the source owner's own account. A delivery not dispatched
within an hour expires; polling covers it. At most 10,000 deliveries are pending
per App, a limit shared with the workflow event inbox; beyond that, deliveries are
recorded as rejected with `capacity-exceeded`.

Processed deliveries (routed, ignored, rejected or expired) are kept for
`GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS`, 6 hours by default and 1 to 720 hours,
so redeliveries of the same delivery ID are recognized. Every API replica deletes
older ones once a minute, in batches of 500, through the
`app.prune_github_event_deliveries` function (platform migration
`0004_github_event_delivery_retention.sql`); the application role still cannot delete
deliveries directly. Pending deliveries are never deleted, and neither are
deliveries the workflow event inbox still references by a dispatch. Runs appear as
the `github-delivery-retention` background job, and a run that deletes anything
logs the count. GitHub redeliveries normally arrive within hours. One arriving
after the retention is accepted as a new delivery: its repositories are made due
again, costing one extra pass, and a reused delivery ID with a different body is no
longer rejected with 409. Raise the retention if your redeliveries arrive later.

## Reader-first rollout

Deploy readers accepting common version 73 before applying
`common/0097_knowledge_github.sql`. GitHub writes require version 73. Search keeps
its version 69 minimum and references no GitHub relations before version 73. GitHub
SQL is included in a search only when the member belongs to a GitHub source; its
eligibility is read through `tf_knowledge_github_eligible_for()`, whose plan is
cached per session.

Common migration `0007_knowledge_github_commits.sql` allows the `commit` item kind and
adds `commit_head`. Before a workspace reaches that version, its sources index every
selected kind except commits.

Common migration `0010_github_knowledge_commits_backfill.sql` turns on `commits` for
GitHub sources created before that kind existed. A source is changed only when its
kinds are exactly the earlier default set (`code`, `discussions`, `docs`, `issues`,
`pulls`); a source with fewer kinds was narrowed by its owner and keeps its choice.
Both stored selection copies change together, the change is skipped when it would
collide with another source of the same owner, and `commit_head` is cleared so the
next pass indexes the full commit history. Planned automatic sources with the
earlier set are updated too. Running it again changes nothing. Workspaces below
version 10 keep their kinds, and below version 7 commits are never indexed.

## Automatic Knowledge

Every authorization of a personal account creates one owner-only all-repositories
source with every content kind and full history, unless the owner already has one
for that account. Indexing starts at once. Like every provider, GitHub follows the
`default-connection-knowledge` flag, which is on by default. Automatic sources include `code`: every file at the default-branch
head, with no count cap, and `commits`: the full default-branch history.
Issues, pull requests and discussions keep their full history. Migration
`common/0006_github_knowledge_opt_out.sql` removes the earlier rolling 90-day window
and its date from existing GitHub sources. It also records a default intent for every
active account, so existing accounts get their all-repositories source.

## Verification

`test/github-access.integration.mjs` covers the missing `repo` scope, a denied kind,
lost access, a rename or transfer, and reconnecting a rejected credential.
`test/github-opt-out.integration.mjs` covers automatic creation, new repositories
on later passes, repository, kind, path and cutoff opt-outs, full history and the
1,000-repository bound. `test/github-ownership.integration.mjs` covers handover in both directions,
webhook dispatch for owned repositories, shared and disconnected exceptions,
duplicate-free search, and migration 0010 (idempotence, narrowed sources, cleared
commit heads and a full commit history afterwards). `test/github.integration.mjs` uses restricted PostgreSQL logins, the actual parser,
lexical search, embeddings, and the search coordinator with a fixture provider.
`packages/github/test/corpus-provider.test.mjs` covers REST and GraphQL mapping
against `packages/github/test/corpus-fixture.mjs`, including head-unchanged skips,
compare listings with renames, removals and opt-outs, compare fallbacks and
since-marks. `packages/github/test/knowledge-events.test.mjs` covers the
event-to-repository mapping, and `knowledge-events.integration.mjs` signature
checks, deduplication, capacity and expiry against PostgreSQL.
`apps/api/test/knowledge-github-all-files.integration.mjs` runs the real provider and
engine across head changes: formerly excluded files, a file in parts read from one
blob download, a binary placeholder, a hashed long path, a truncated tree walk and
deletions. The provider test covers one download per file with bounded buffering,
issue listings past 50,000 items and update-time ties.
`apps/api/test/knowledge-github-commits.integration.mjs` runs both across a growing
and force-pushed history. The integration test also covers rate-limit pauses, item
and repository isolation, lease renewal, time-boxed runs and uncapped cursors; the
provider test covers retries, backoff and pacing. Live GitHub, GitHub rate limits
under load, and throughput remain unverified.
