# Connect Jira Cloud

This integration connects one Jira Cloud site to TulipFarm. Its agents can search and read issues,
then create, update, prioritize, estimate, or move issues only after the required approval.

## 1. Create an Atlassian OAuth integration

1. Open the [Atlassian developer console](https://developer.atlassian.com/console/myapps/) and
   create an **OAuth 2.0 integration** for this TulipFarm deployment.
2. Under **Permissions**, add Jira API read and write scopes. The token needs read access to search
   issues and their history, and write access to create, edit, and transition issues.
3. Authorize the integration for the Jira Cloud site you want TulipFarm to use, then copy a current
   OAuth access token.

## 2. Find the Cloud ID

While signed in to Jira, open:

```
https://<your-site>.atlassian.net/_edge/tenant_info
```

Copy the `cloudId` value. TulipFarm uses it with Atlassian's fixed API gateway, so the connection
cannot be redirected to another host.

## 3. Connect in TulipFarm

Open **Integrations → Jira** and paste the Cloud ID and OAuth access token. TulipFarm seals the
token in its Secrets store. The Cloud ID is not secret; it only selects your Jira Cloud site.

## What agents can do

- Search issues with JQL and read their fields or changelog for estimates and cycle-time reports.
- Create issues and update fields such as priority or estimates.
- List valid workflow transitions before moving an issue.

Searches and reads run without approval. Every create, update, or transition asks for approval.

## Scope

This is a Jira Cloud integration. Jira Server and Data Center use a site-specific API host, which
TulipFarm intentionally does not accept for credentialed egress.
