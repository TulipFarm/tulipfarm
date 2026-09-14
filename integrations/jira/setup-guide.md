# Connect Jira Cloud

This integration connects one Jira Cloud site to TulipFarm. Its agents can search and read issues,
then create, update, prioritize, estimate, or move issues only after the required approval.

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

- Search issues with JQL and read their fields or changelog for estimates and cycle-time reports.
- Create issues and update fields such as priority or estimates.
- List valid workflow transitions before moving an issue.

Searches and reads run without approval. Every create, update, or transition asks for approval.

## Scope

This is a Jira Cloud integration. Jira Server and Data Center use a site-specific API host, which
TulipFarm intentionally does not accept for credentialed egress.
