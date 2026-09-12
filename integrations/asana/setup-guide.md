# Connect Asana

This launch package uses an Asana personal access token (PAT). The token acts as the user who
created it and can reach only the workspaces, projects, and tasks that user can access.

## Provider setup

1. Open the [Asana developer console](https://app.asana.com/0/my-apps).
2. Create a personal access token with a clear name for this TulipFarm Connection.
3. Use a dedicated Asana account when the Connection should not carry a person's full access.

PATs do not have separately selectable OAuth scopes. They carry the creating user's API access.
For an OAuth app, the equivalent operations require `users:read`, `projects:read`, `tasks:read`,
`tasks:write`, and `stories:write`. This package does not implement the OAuth consent flow.

## Connect it

Open **Integrations → Asana → Connect** and paste the PAT. TulipFarm stores it as a Secret and
sends it only as a Bearer token to `app.asana.com`.

## Operations

| Tool | Access |
| --- | --- |
| `asana_current_user` | Identify the token owner |
| `asana_list_projects` | List projects in one workspace, with cursor pagination |
| `asana_list_tasks` | List tasks in one project, with cursor pagination |
| `asana_get_task` | Read one task |
| `asana_create_task` | Create a task in a workspace or project |
| `asana_update_task` | Update selected task fields |
| `asana_add_comment` | Add a comment story to a task |

Create requests must identify a workspace directly or through `projects` or `parent`. Updates send
only the fields in the `data` object; omitted fields stay unchanged.

## Events

No events are declared. Asana creates the signing secret during a concurrent webhook handshake and
expects it echoed in `X-Hook-Secret`. The current OIM schema can verify HMAC and echo a header, but
cannot capture a provider-issued handshake secret into the event verification credential slot.

## Official references

- [Personal access tokens](https://developers.asana.com/docs/personal-access-token)
- [Get projects](https://developers.asana.com/reference/getprojects)
- [Get tasks from a project](https://developers.asana.com/reference/gettasksforproject)
- [Create a task](https://developers.asana.com/reference/createtask)
- [Update a task](https://developers.asana.com/reference/updatetask)
- [Create a story on a task](https://developers.asana.com/reference/createstoryfortask)
- [Webhooks](https://developers.asana.com/docs/webhooks-guide)
