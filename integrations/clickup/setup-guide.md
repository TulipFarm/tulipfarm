# Connect ClickUp

This launch package uses a ClickUp personal API token. It acts as the user who generated it and can
reach only the Workspaces and tasks that ClickUp allows that user to access.

## Provider setup

1. In ClickUp, open **Settings → Apps**.
2. Generate a personal API token.
3. Use a dedicated ClickUp user when the Connection should have narrower access.

Personal tokens do not expose granular scopes. Their access follows the user's Workspace
membership and permissions. ClickUp requires OAuth for an app distributed to other users; this
package intentionally provides the self-hosted personal-token baseline only.

## Connect it

Open **Integrations → ClickUp → Connect** and paste the token. TulipFarm stores it as a Secret and
sends the raw token in the `Authorization` header only to `api.clickup.com`.

## Operations

| Tool | Access |
| --- | --- |
| `clickup_current_user` | Identify the token owner |
| `clickup_list_workspaces` | List authorized Workspaces (called teams by API v2) |
| `clickup_list_spaces` | List spaces in one Workspace |
| `clickup_list_tasks` | List filtered Workspace tasks, 100 per page |
| `clickup_get_task` | Read one task |
| `clickup_create_task` | Create a task in a List |
| `clickup_update_task` | Update selected task fields |
| `clickup_add_comment` | Add a plain-text task comment |

The API v2 path still says `team_id`; the product calls this object a Workspace. Task pagination is
zero-based. Custom task IDs require both `custom_task_ids=true` and a Workspace id.

## Events

No events are declared. ClickUp returns a new signing secret in the create-webhook response and
uses it for hexadecimal HMAC-SHA256 signatures in `X-Signature`. The current OIM webhook setup
cannot copy a provider-issued response value into the verification credential slot.

## Official references

- [Authentication](https://developer.clickup.com/docs/authentication)
- [Authorized user](https://developer.clickup.com/reference/getauthorizeduser)
- [Authorized Workspaces](https://developer.clickup.com/reference/getauthorizedteams)
- [Spaces](https://developer.clickup.com/reference/getspaces)
- [Filtered Workspace tasks](https://developer.clickup.com/reference/getfilteredteamtasks)
- [Create and update tasks](https://developer.clickup.com/reference/createtask)
- [Create a task comment](https://developer.clickup.com/reference/createtaskcomment)
- [Webhook signatures](https://developer.clickup.com/docs/webhooksignature)
