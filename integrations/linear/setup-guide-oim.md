# Connect Linear

Open **Integrations → Linear** to create a connection: saved credentials and the account they
identify. TulipFarm checks the key with Linear's fixed `Viewer` query before marking it healthy.

This Integration talks to Linear's GraphQL API through documents that ship inside the package. An
agent supplies variables — a team id, a title, a comment body — and never the query text, so no
argument can widen what a call reads or changes.

## Get a key

1. In Linear, open **Settings → Security & access → Personal API keys**.
2. Create a key named for TulipFarm, so it can be revoked on its own.
3. Limit it to the teams and permissions this Connection should have. Read access is enough for the
   read Tools; grant write, issue-create or comment-create only when agents should do those
   things. The Connection can do exactly what the key can do and nothing more.
4. Copy the key once. Linear does not show it again.

## Connect it

Open **Integrations → Linear**, enter a **Connection name** and **API key**, then choose
**Create Connection**. The key is stored as an encrypted secret, used for verification and declared
Linear operations, and never shown to an agent.

For a team-wide Connection use a key belonging to a service account. For issues filed under your
own name, connect a personal Connection instead — every operation accepts either.

## What agents can do

| Tool | Effect | GraphQL operation |
| --- | --- | --- |
| `linear_viewer` | read | `Viewer` |
| `linear_list_teams` | read | `ListTeams` |
| `linear_list_team_states` | read | `ListTeamStates` |
| `linear_list_team_members` | read | `ListTeamMembers` |
| `linear_list_issues` | read | `ListIssues` |
| `linear_read_issue` | read | `ReadIssue` |
| `linear_create_issue` | create | `CreateIssue` |
| `linear_update_issue` | update | `UpdateIssue` |
| `linear_create_comment` | create | `CreateComment` |

Each of the nine names a document in `operations/`, pinned by digest in the manifest. A package
whose document no longer matches its digest fails to install rather than sending a query nobody
reviewed.

Manifest and document also have to agree about what an operation does: a `read` whose document is
really a `mutation` is refused when the Tools compile, so a write cannot reach Linear past an
approval gate that only ever saw a read.

## Paging

Teams, issues, team workflow states and team members all require `first` between 1 and 50.
While `pageInfo.hasNextPage` is true, pass `pageInfo.endCursor` back as `after`; stop only when
`hasNextPage` is false. One bounded page is not a complete list. If an agent reaches its turn
limit before the final page, it must report an incomplete list rather than claim completeness.
Linear pages inside GraphQL variables, so the agent explicitly requests each page.
Issues use Linear's `orderBy: updatedAt` to return newest activity first, not creation order.

## Change an issue

Ask in chat to read the issue, discover workflow states and members for its team, then apply the
requested update. `linear_update_issue` accepts:

- `stateId`: a workflow state id from that issue's Linear team.
- `assigneeId`: an active member id, or `null` to unassign.
- `priority`: `0` none, `1` urgent, `2` high, `3` normal, `4` low.
- `estimate`: a non-negative number on the team's configured estimate scale, or `null` to clear.
- `title` and `description`: replacement text.

Omit fields that must stay unchanged. Reads and mutation results include current status, assignee,
priority and estimate. Mutations retain the broker's approval and reconciliation boundaries;
an HTTP 200 GraphQL response with errors is not treated as success.

## Activation and background capability boundaries

The production loader still uses `requireVerification: true`; a health-check operation alone does
not qualify. Verification compiles the digest-checked `Viewer` query, rejects GraphQL errors even
with HTTP 200, and requires a nonempty provider subject from `/data/viewer/id` under issuer
`https://api.linear.app`. Evidence belongs to the exact Connection, package, configuration,
auth-step revision and credential reference. A failed check removes its current proof.

Verification proves the key's identity, not permission to perform every listed operation.
Provider permissions still apply to each request. Offline tests cover setup and verification;
they do not certify a live Linear account.

No automatic issue polling, event-driven routines or Knowledge indexing is declared:

- Polling currently requires an HTTP operation. Its cursor modes accept one response cursor or a
  monotonically increasing integer id; Linear issue UUIDs and `updatedAt` timestamps are neither a
  durable change cursor nor a monotonic integer. Reliable polling needs bounded GraphQL page walks,
  a timestamp watermark with overlap and per-issue revision deduplication, and checkpoint commit
  only after all pages and deliveries succeed. A page's `endCursor` is not that watermark.
- Knowledge needs a full bounded, team-scoped issue crawl with revisions/deletions and proven reader
  ACLs or a provider-backed per-principal live authorization check. A scoped API key proves only
  that key's access. Team membership is not an issue-reader ACL, especially for private teams and
  guest access. Publishing every fetched issue to the organization or matching member names/emails
  would widen authority. These operations do not yet provide the required ACL/live-check contract.

## Rotating the key

Use **Save credentials and verify** on the saved Connection to replace the key and reverify that same
Connection before revoking the old key in Linear. Do not edit the Soul or paste credentials
into chat.
