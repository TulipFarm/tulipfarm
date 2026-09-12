# Connect Confluence

Confluence is read-only in TulipFarm: agents can read spaces and pages, and Knowledge can index
them, but nothing writes back. Each Connection points at one Atlassian Cloud site.

## Get a token

1. Sign in as the account whose Confluence access this Connection should carry. That account's
   permissions become the ceiling for everything TulipFarm reads — a Connection cannot see a page
   the account cannot open.
2. Open <https://id.atlassian.com/manage-profile/security/api-tokens> and create a token named for
   TulipFarm, so it can be revoked on its own.
3. Note the account's email address. Confluence authenticates with the email and the token
   together, so you paste them as one value: `email:token`. TulipFarm base64-encodes the pair
   itself — never run base64 by hand.

## Connect it

Open **Integrations → Confluence → Connect**. You are asked for two things:

| Field | Example | Stored as |
| --- | --- | --- |
| Site host | `acme.atlassian.net` | Configuration, visible to agents |
| Email and API token | `muskan.vijayvargiya@acme.com:the-token` | Secret |

Only hosts under `atlassian.net` are accepted. The Integration declares that bound in its manifest,
and it is checked again when the Tools compile, so a Connection cannot point Confluence's Tools at
an unrelated server.

This package uses Confluence Cloud REST v2 and Cloud account identifiers. It does not work with
Confluence Data Center. Use the separate **Confluence Data Center** package for a public
self-hosted site.

For a shared Connection the token should belong to a service account with deliberately chosen
space access. To check another account's effective permission, that service account must be a
Confluence Administrator. Without that role, cross-user checks fail closed. For your own reading,
connect a personal Connection instead — it can safely check only the account that owns it.

## What agents can do

| Tool | What it answers |
| --- | --- |
| `confluence_list_spaces` | Which spaces this Connection can read |
| `confluence_list_pages` | Pages in one space, with revisions |
| `confluence_get_page` | One page's title and body |

The restriction and user operations support Knowledge synchronization and identity linking.

## Indexing into Knowledge

Ask in Chat, for example: *"index the Engineering and Support spaces from Confluence every night."*
The platform agent creates a Routine bound to the Connection, the spaces and the schedule you
named. Nothing is indexed on install; indexing only ever starts because somebody asked for it.

Confluence's restriction endpoint reports direct users and groups in separate lists. It is not an
effective access decision: site access, space permissions, and restrictions inherited from parent
pages can still deny a listed user. This package records direct user restrictions as evidence, but
does not treat them as authority.

Page content is marked sensitive, so retrieval requires Confluence's live permission check. The
check asks Confluence for the effective result for the proven Atlassian account. Confluence applies
product access, space permissions, inherited parent restrictions, page-local restrictions, and
group membership. TulipFarm does not flatten those rules or infer access from the direct lists.
Provider errors, malformed answers, missing identity proof, and denied checks all fail closed.

When a page is deleted, it disappears from the next full listing and is removed.

## Rotating the token

Create the new token first, then update the Connection. Leases against the old token are revoked
when the Secret changes, so an in-flight run fails rather than continuing on a credential you
meant to retire. Revoke the old token in Atlassian afterwards.
