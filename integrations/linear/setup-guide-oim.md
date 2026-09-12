# Connect Linear

This Integration talks to Linear's GraphQL API through documents that ship inside the package. An
agent supplies variables — a team id, a title, a comment body — and never the query text, so no
argument can widen what a call reads or changes.

## Get a key

1. In Linear, open **Settings → Security & access → Personal API keys**.
2. Create a key named for TulipFarm, so it can be revoked on its own.
3. Limit it to the teams and permissions this Connection should have. Read access is enough for the
   three read Tools; grant write, issue-create or comment-create only when agents should do those
   things. The Connection can do exactly what the key can do and nothing more.
4. Copy the key once. Linear does not show it again.

## Connect it

Open **Integrations → Linear → Connect** and paste the key. It is stored as a Secret, leased only
while a declared Linear Tool is running, and never shown to an agent.

For a team-wide Connection use a key belonging to a service account. For issues filed under your
own name, connect a personal Connection instead — every operation accepts either.

## What agents can do

| Tool | Effect | GraphQL operation |
| --- | --- | --- |
| `linear_viewer` | read | `Viewer` |
| `linear_list_teams` | read | `ListTeams` |
| `linear_list_issues` | read | `ListIssues` |
| `linear_read_issue` | read | `ReadIssue` |
| `linear_create_issue` | create | `CreateIssue` |
| `linear_update_issue` | update | `UpdateIssue` |
| `linear_create_comment` | create | `CreateComment` |

Each of the seven names a document in `operations/`, pinned by digest in the manifest. A package
whose document no longer matches its digest fails to install rather than sending a query nobody
reviewed.

Manifest and document also have to agree about what an operation does: a `read` whose document is
really a `mutation` is refused when the Tools compile, so a write cannot reach Linear past an
approval gate that only ever saw a read.

## Paging

`linear_list_issues` takes `first` and returns `pageInfo.endCursor`. Pass that back as `after` to
read the next page. Linear pages inside the GraphQL variables rather than in a query parameter, so
the agent asks for the next page itself instead of the host doing it.

## Rotating the key

Create the new key first, then update the Connection. Leases against the old key are revoked when
the Secret changes, so an in-flight run fails rather than continuing on a credential you meant to
retire. Revoke the old key in Linear afterwards.
