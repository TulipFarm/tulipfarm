# Example: ticket management

Use this pattern when someone wants to track tasks or tickets the way Jira, Linear, or Asana do: work items that move through stages, belong to a project, and have an owner.

## Small team, one table

A small team asks for "a table to manage tickets". Start with one table:

**Tickets**

| Label           | Kind            | Required | Notes                                                    |
| --------------- | --------------- | -------- | -------------------------------------------------------- |
| Title           | `text` (200)    | yes      |                                                          |
| Description     | `text` (5000)   | no       |                                                          |
| Status          | `single-select` | yes      | Open, In progress, Waiting on customer, Resolved, Closed |
| Priority        | `single-select` | no       | Low, Medium, High, Urgent                                |
| Assignee        | `text` (120)    | no       | Or a relationship to People if that table exists.        |
| Requester email | `text` (254)    | no       |                                                          |
| Due date        | `date`          | no       |                                                          |

## Several projects, two tables

When the person mentions projects, boards, or teams of work, split projects into their own table. Many tickets share one project, and the project has its own details.

Create **Projects** first, then **Tickets** with `dependsOn` set to the Projects table ID.

**Projects**

| Label  | Kind            | Required | Notes                               |
| ------ | --------------- | -------- | ----------------------------------- |
| Name   | `text` (200)    | yes      |                                     |
| Key    | `text` (10)     | no       | Short code such as OPS. Unique key. |
| Lead   | `text` (120)    | no       |                                     |
| Status | `single-select` | yes      | Planned, Active, Paused, Done       |

**Tickets**

| Label       | Kind                             | Required | Notes                                                               |
| ----------- | -------------------------------- | -------- | ------------------------------------------------------------------- |
| Title       | `text` (200)                     | yes      |                                                                     |
| Description | `text` (10000)                   | no       |                                                                     |
| Project     | `relationship` to Projects       | yes      | Many tickets to one project.                                        |
| Type        | `single-select`                  | no       | Task, Bug, Story                                                    |
| Status      | `single-select`                  | yes      | Backlog, To do, In progress, In review, Done, Canceled              |
| Priority    | `single-select`                  | no       | No priority, Low, Medium, High, Urgent                              |
| Assignee    | `text` (120)                     | no       |                                                                     |
| Labels      | `multi-select`                   | no       | Start with the labels the person named, or leave a few common ones. |
| Estimate    | `numeric` (precision 5, scale 1) | no       | Points or hours; say which.                                         |
| Due date    | `date`                           | no       |                                                                     |
| Parent      | `relationship` to Tickets        | no       | Only when they use subtasks or epics.                               |

## Defaults to name on the card

- The status list. Jira-style teams often use To do, In progress, Done. Linear-style teams add Backlog and Canceled.
- Whether Assignee is a name or a link to People.
- What Estimate measures.

## Do not add

- A ticket number field. Rows already have their own identity.
- Sprints or cycles, unless the person plans work in fixed time boxes. Then add a **Cycles** table (Name, Start date, End date) and a Cycle relationship on Tickets.
