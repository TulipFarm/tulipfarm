# Connect GitLab

GitLab is the reference package for **events**: it reads and writes issues, merge requests and
notes over the REST API, and it receives project or group webhooks as typed events that Routines
can subscribe to.

Each Connection points at one GitLab host and carries one access token. The Connection can do
exactly what that token can do — no more.

## Get an access token

1. Decide whose access the Connection should carry. A shared Connection should use a group or
   project access token belonging to a bot account, so nothing depends on one person staying.
   A personal Connection uses your own personal access token and is only usable by you.
2. In GitLab, open **Settings → Access tokens** and create a token with the `api` scope, scoped to
   the projects this Integration should reach.
3. Copy it now. GitLab shows an access token once.

## Connect it

Open **Integrations → GitLab → Connect**. You are asked for:

| Field | Example | Stored as |
| --- | --- | --- |
| GitLab host | `gitlab.com` | Configuration, visible to agents |
| Access token | — | Secret |
| Secret token | — | Secret, optional |

Only `gitlab.com` and its subdomains are accepted. The manifest declares that bound, and it is
checked again when the Tools compile, so a Connection cannot point GitLab's Tools at an unrelated
server. A self-managed instance on its own domain needs that domain added to
`auth.allowedOriginHosts` in a forked copy of the package.

The token is never shown to an agent, never written to a Run event, and never returned by a Tool.

## What agents can do

| Tool | Effect |
| --- | --- |
| `gitlab_current_user` | Read — confirms the token works |
| `gitlab_list_projects` | Read |
| `gitlab_list_issues` | Read |
| `gitlab_get_issue` | Read |
| `gitlab_list_merge_requests` | Read |
| `gitlab_create_issue` | Create |
| `gitlab_comment_issue` | Create |

Both writes are declared as mutating, so they run through the same approval gate as any other
write — an agent cannot open an issue or leave a note without the authority to do so.

Project ids may be numeric (`14`) or the URL-encoded path (`acme%2Fweb`). Issue numbers are the
`iid` shown in the UI, not the global id.

## Receive events (optional)

Skip this if you only want agents to read and write on demand.

1. Generate a long random secret token. A password manager's generator is fine.
2. In GitLab, open your project or group's **Settings → Webhooks → Add new webhook**.
3. Set **URL** to this deployment's ingress URL followed by `/gitlab`.
4. Paste your secret token into **Secret token**.
5. Under **Trigger**, select the events you want: Issues, Merge request, Comments, Push.
6. Save, then paste the same secret token into TulipFarm's **Secret token** field.

TulipFarm declares four event types — `issue`, `merge_request`, `note` and `push` — each picked out
of the payload's `object_kind` field. Anything else GitLab sends is discarded rather than stored,
so enabling a trigger the package does not type only wastes a delivery.

Retries are recognised by GitLab's `X-Gitlab-Event-UUID` header, so a webhook GitLab resends does
not run a Routine twice.

### What the secret token does and does not prove

GitLab's secret token is sent verbatim in the `X-Gitlab-Token` header; it does not sign the
payload. TulipFarm compares that header against the stored Secret, which proves the sender knows
the token but proves nothing about the body. Treat it as a password: generate it randomly, keep it
long, and rotate it in both places at once.

GitLab also offers a newer *signing token*, which does sign the body. TulipFarm cannot verify it
yet — it signs `{message_id}.{timestamp}.{body}` with a base64-decoded key, which the OIM events
profile has no way to describe. If you configure both on the same webhook, TulipFarm keeps using
the secret token.

## Revoking

Revoke the access token in GitLab and the Connection stops working immediately; nothing else needs
changing. Deleting the webhook in GitLab stops events. Removing the Connection in TulipFarm deletes
both Secrets.
