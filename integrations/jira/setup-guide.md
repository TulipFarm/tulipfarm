# Connect Jira

This Integration connects one Jira Cloud site. Agents can search and read issues without asking,
and every create, update or transition goes through approval.

## Get a token

1. Sign in as the account whose Jira access this Connection should carry. That account's
   permissions become the ceiling for everything TulipFarm can do — a Connection cannot read a
   project the account cannot open, or edit an issue the account cannot edit.
2. Open <https://id.atlassian.com/manage-profile/security/api-tokens> and create a token named for
   TulipFarm, so it can be revoked on its own.
3. Note the account's email address. Jira Cloud authenticates with the email and the token
   together.

## Connect it

Open **Integrations → Jira → Connect**. You are asked for two things:

| Field | Example | Stored as |
| --- | --- | --- |
| Site host | `acme.atlassian.net` | Configuration, visible to agents |
| Email and API token | `muskan.vijayvargiya@acme.com:the-token` | Secret |

Paste the email and the token as one value with a colon between them. TulipFarm encodes the pair
into the Basic credential Jira expects, so you never run base64 by hand, and agents never see
either half.

Only hosts under `atlassian.net` are accepted. The Integration declares that bound in its manifest
and it is checked again when the Tools compile, so a Connection cannot point Jira's Tools at an
unrelated server.

For a team-wide Connection the token should belong to a service account with deliberately chosen
project access. For work under your own name — issues you file, transitions you make — connect a
personal Connection instead. Every operation accepts either.

## What agents can do

| Tool | Effect | What it does |
| --- | --- | --- |
| `jira_current_user` | read | Confirms which account the Connection authenticates as |
| `jira_search_issues` | read | Runs a JQL search |
| `jira_get_issue` | read | Reads one issue, optionally with its changelog |
| `jira_list_priorities` | read | Lists the priorities this site defines |
| `jira_list_transitions` | read | Lists the transitions available for one issue |
| `jira_create_issue` | create | Files a new issue |
| `jira_update_issue` | update | Edits fields, including priority and estimates |
| `jira_transition_issue` | update | Moves an issue using a transition id |

Transition ids differ per project, so an agent is expected to call `jira_list_transitions` before
`jira_transition_issue` rather than assume one.

## Paging a search

`jira_search_issues` returns an opaque `next_page_token` when more issues match. Pass it back as
`page_token` to read the following page. TulipFarm writes Jira's own `nextPageToken` into the
request body; agents do not parse or construct Jira cursors.

## Scope

Jira Cloud only. Jira Server and Data Center are on customer-controlled domains, which this
package's origin allowlist deliberately does not cover; a self-managed site needs a forked package
naming its own host.

## Rotating the token

Create the new token first, then update the Connection. Leases against the old token are revoked
when the Secret changes, so an in-flight run fails rather than continuing on a credential you meant
to retire. Revoke the old token in Atlassian afterwards.
