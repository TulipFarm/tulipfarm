# Example: engineering work

Use this pattern when someone wants to track engineering work the way GitHub Issues or GitLab do: bugs and features across repositories, linked to pull requests and releases.

## Issues and releases

Repository is a plain label from a short list, so keep it as a `single-select` field. A release has its own date and status, and many issues ship in one release, so it gets its own table.

Create **Releases** first, then **Issues** with `dependsOn` set to the Releases table ID.

**Releases**

| Label         | Kind            | Required | Notes                                    |
| ------------- | --------------- | -------- | ---------------------------------------- |
| Name          | `text` (100)    | yes      | Such as v2.4.0. Unique key.              |
| Target date   | `date`          | no       |                                          |
| Status        | `single-select` | yes      | Planned, In progress, Released, Canceled |
| Release notes | `text` (10000)  | no       |                                          |

**Issues**

| Label            | Kind                       | Required | Notes                                  |
| ---------------- | -------------------------- | -------- | -------------------------------------- |
| Title            | `text` (200)               | yes      |                                        |
| Body             | `text` (10000)             | no       |                                        |
| Repository       | `single-select`            | no       | Use the repositories the person named. |
| Type             | `single-select`            | no       | Bug, Feature, Chore, Docs              |
| State            | `single-select`            | yes      | Open, In progress, In review, Closed   |
| Priority         | `single-select`            | no       | P0, P1, P2, P3                         |
| Labels           | `multi-select`             | no       |                                        |
| Assignee         | `text` (120)               | no       | GitHub username or name.               |
| Issue URL        | `text` (500)               | no       | Unique key when issues mirror GitHub.  |
| Pull request URL | `text` (500)               | no       |                                        |
| Release          | `relationship` to Releases | no       | Many issues to one release.            |

## Variations

- **Only one repository:** remove the Repository field.
- **Issues come from GitHub:** make Issue URL the unique key, so a sync updates the same row instead of adding a copy.
- **Several pull requests per issue:** add a **Pull requests** child table (Title, URL, State, Issue relationship) instead of more URL fields.
- **Incidents:** use a separate **Incidents** table (Title, Severity, Status, Started at `timestamp`, Resolved at `timestamp`, Postmortem URL). Incidents have different stages from issues.

## Defaults to name on the card

- The state list and the priority scale.
- The repository list.
- Whether Issue URL is the unique key.

## Do not add

- An issue number field, unless the issues mirror GitHub. Then the Issue URL already identifies the issue.
- A time-to-close field. It is computed from dates and goes stale.
