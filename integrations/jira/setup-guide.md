# Connect Jira Cloud

This integration connects one Jira Cloud site to TulipFarm. Agents can discover project-specific
fields, search issues, and read comments and history. Creates, updates, and transitions remain
subject to TulipFarm approval policy and the connected account's Jira permissions.

## 1. Create an Atlassian API token

1. Sign in to the Atlassian account whose Jira access this Connection should use.
2. Open [API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
3. Create and copy an API token **without scopes**.

This Integration calls your Jira site's REST API directly. Scoped Atlassian API tokens use the
`api.atlassian.com` gateway and a Cloud ID, so they are not interchangeable with the token this
Integration expects.

## 2. Find the site host

Copy the exact host from the Jira URL you sign in to, for example `acme.atlassian.net`. Do not
include `https://`, a path, or a trailing slash. Only `*.atlassian.net` hosts are accepted.

## 3. Connect in TulipFarm

Open **Integrations → Jira**. Enter the site host, then enter the Atlassian account email and API
token as one value separated by a colon:

```text
your.email@example.com:api-token
```

TulipFarm encodes this value as HTTP Basic credentials and seals it in its Secrets store. Do not
base64-encode it yourself.

## What agents can do

- Discover accessible projects with `jira_list_projects`; use `action=create` for creation.
- Discover a project's issue types with `jira_list_create_issue_types`, then fetch **every page**
  from `jira_list_create_fields` for the chosen project and issue type. Required custom fields,
  schemas, defaults, update operations, and allowed values come from that tenant's metadata.
- Read `jira_get_edit_fields` for the **exact issue** before changing fields. Creation metadata
  and values copied from another issue are not proof that a field can be edited here.
- Search with JQL and read issue fields. Use `jira_list_issue_comments` and
  `jira_list_issue_changelog` for full paginated threads and history; embedded comments and
  `expand=changelog` can be truncated.
- List workflow transitions with their field metadata before moving an issue. Supply required
  transition fields as well as the transition id.

Searches and reads run without approval. Every create, update, or transition asks for approval.

### Pagination and field values

Project, issue-type, create-field, comment, and changelog Tools each return **one bounded page**.
Set `startAt=0` and `maxResults` between 1 and 100. Continue with the returned `startAt` plus the
length of `values`, `issueTypes`, `fields`, or `comments`, respectively, until reaching `total`.
These are explicit Jira offsets, not the opaque `page_token` used by JQL search. Keep the project,
issue, filters, and page size unchanged while paging. Do not treat a first page as a complete list.
If an empty page arrives before `total`, or a response exceeds its byte bound, report the read as
incomplete rather than loop or silently truncate. Concurrent provider changes can shift offsets;
deduplicate by id and repeat the read if a consistent report is required.

Use returned field and option ids. Some fields expose autocomplete instead of a complete
`allowedValues` list; this package does not implement every tenant's custom autocomplete service.
Ask for a valid value when metadata is insufficient. Rich-text descriptions and comments use
Atlassian Document Format (ADF), not plain Markdown. Provider validation errors still fail the
operation; metadata discovery does not bypass field, project, issue-security, or workflow rules.

Successful updates and transitions return JSON `null`, representing Jira's HTTP 204 No Content.
They do not return an issue object. Read the issue again to confirm its resulting fields or state.
Malformed responses and transport failures are not converted into success. A failed mutation may
be ambiguous: reconcile with a read before retrying a create or transition.

## Scope

This is a Jira Cloud integration. Jira Server and Data Center use a site-specific API host, which
TulipFarm intentionally does not accept for credentialed egress. Scoped API tokens, OAuth gateway
credentials, and Cloud-ID routing are not supported by this OIM package.

No event ingress or automatic Knowledge indexing is advertised:

- **Issue polling:** Jira's JQL continuation token pages a search; it is not a durable change-stream
  watermark. The declarative polling host supports an opaque response cursor or integer event ids,
  not a JQL `updated` watermark with overlap, same-timestamp tie handling, per-issue revision
  deduplication, completed-page checkpointing, and external actor attribution. Reusing a search
  page token as that cursor would miss or repeat updates. Webhook registration/verification is
  also not declared. A user can schedule explicit searches in a Routine, but that is not an
  exactly-once issue-change subscription.
- **Knowledge:** issue visibility combines project permissions and issue-security rules; comments
  can add role/group restrictions. These operations do not enumerate authoritative per-item ACLs
  or live-authorize a linked reader against all those rules. Indexing everything the connection
  account can read as public or as a project-wide grant would leak restricted content. A future
  binding needs verified Atlassian account-id mapping, effective-reader issue authorization,
  comment-level ACLs, deletion/revocation handling, and deterministic ADF extraction first.

Endpoint shapes are based on Atlassian's
[Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).
Offline fixtures exercise the production compiler, adapter, and real bodyless Fetch responses;
they are not live-tenant certification.
