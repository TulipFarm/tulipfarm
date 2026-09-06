# Ticket Management

Issue tracking for internal work. Build this when the user asks for a tracker, an issue tracker,
project management, a backlog, sprints, or names a product they want a replacement for.

For customer-facing tickets — someone outside the company raised it and expects a reply — use
`customer-support.md` instead. The two are different shapes and both may be wanted.

## What the user is asking for

The product they name tells you what they expect. Ask which way they lean if it is not obvious;
the answer changes the fields, not just the wording.

| They say | They usually want | Lean towards |
| --- | --- | --- |
| "a Jira alternative" | Projects, workflows, epics, story points, structured process | `project` + `issue` + `cycle`, `estimate` in points, `parentIssueId` used for epics |
| "a Linear alternative" | Speed, cycles, a tight opinionated set of states, little config | `project` + `issue` + `cycle`, fewer statuses, no `issue-relation` at first |
| "a Trello/kanban board" | Cards moving through columns, no estimates | `project` + `issue` only, statuses named as their columns; read the display limit below |
| "a backlog" / "a to-do list for the team" | One flat list, no ceremony | `issue` alone, `projectId` optional |
| "a bug tracker" | Defect intake, no sprints | `issue` with `issueType` fixed to `bug`, plus `stepsToReproduce` and `environment` |

Do not build all five types because they said "Jira". Propose the core three, name the other two as
optional, and let them decide.

## The bundle

| | Type | |
| --- | --- | --- |
| Core | `project` | Container, and the source of the issue key prefix |
| Core | `issue` | The unit of work |
| Core | `cycle` | Sprint or iteration — drop it if they do not run sprints |
| Optional | `issue-comment` | Threaded discussion on an issue |
| Optional | `issue-relation` | blocks / duplicates / relates-to |

Build order: `employee` (from `core-types.md`) → `project` → `cycle` → `issue` → the optional two.
`issue` links to all three of the others, so it cannot be created first.

## `project`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | |
| `key` | string | yes | Short uppercase prefix, e.g. `ENG` |
| `description` | string | no | |
| `status` | enum | yes | `planned`, `active`, `paused`, `completed`, `cancelled` |
| `leadId` | reference | no | `x-links` → `employee` |
| `startDate` | date | no | |
| `targetDate` | date | no | |

**Shape** — `x-unique: [[key]]`. Every issue carries the prefix, so two projects sharing a key make
their issues indistinguishable.

## `issue`

Bugs, features, tasks and chores are **one type**, separated by `issueType`. Splitting them into
separate Resource types fragments every board and every query, and there are no joins to put them
back together.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `key` | string | no | `x-id-strategy` → `ENG-1`; `x-readOnly` |
| `title` | string | yes | |
| `description` | string | no | |
| `issueType` | enum | yes | `bug`, `feature`, `task`, `chore` |
| `status` | enum | yes | `backlog`, `todo`, `in-progress`, `in-review`, `done`, `cancelled` |
| `priority` | enum | yes | `none`, `low`, `medium`, `high`, `urgent` |
| `projectId` | reference | yes | `x-links` → `project` |
| `assigneeId` | reference | no | `x-links` → `employee` |
| `reporterId` | reference | no | `x-links` → `employee` |
| `parentIssueId` | reference | no | `x-links` → `issue` — sub-issues and epics |
| `cycleId` | reference | no | `x-links` → `cycle` |
| `estimate` | number | no | Points or hours — ask which, and say so in the description |
| `labels` | array | no | Strings |
| `dueDate` | date | no | |
| `completedAt` | date | no | |

For a bug-only tracker add `stepsToReproduce` (string), `environment` (enum) and `severity` (enum)
as optional fields on this same type. Only create a separate `bug-report` type if the user runs a
genuinely separate intake process with different people and a different lifecycle.

### The key prefix is what makes it feel real

`x-id-strategy: { prefix: "ENG-", sequence: true, field: "key" }` produces `ENG-1`, `ENG-2`. Offer
it every time — a tracker whose items have no short handle is a spreadsheet. Take the prefix from
the project key and mark `key` as `x-readOnly` so nobody edits it.

The counter is per Resource type, not per project. With several projects in one `issue` type the
numbers are global: `ENG-1`, `ENG-2`, `ENG-3` regardless of which project each belongs to. Say this
before building it. A user who insists on per-project numbering needs one issue type per project,
which costs them the shared backlog — usually not worth it.

### Labels are strings, not links

`labels` is an embedded array of **strings**. Labels have no lifecycle of their own, and an array of
ids is not validated at all, so an array of references would silently accept nonsense. If labels
later need owners, colours or descriptions, they become their own type plus a join type — never an
array of references.

### Epics are the same type

`parentIssueId` is a self-link, so an epic is an issue with children and a sub-task is an issue with
a parent. There is no separate epic type. Two levels is what this supports comfortably; deeper
nesting works but nothing displays the tree.

## `cycle`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | e.g. `Cycle 14` |
| `projectId` | reference | no | `x-links` → `project`; omit for one shared cadence |
| `startDate` | date | yes | |
| `endDate` | date | yes | |
| `status` | enum | yes | `planned`, `active`, `completed` |
| `goal` | string | no | |
| `committedPoints` | number | no | Scope at start — see below |

**Shape** — `committedPoints` is a deliberate point-in-time snapshot, written once when the cycle
starts and never recomputed. Scope creep is the difference between it and the live sum of the
cycle's issues. Put that in the field description so nobody "fixes" it into a computed total later.

## `issue-comment`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `issueId` | reference | yes | `x-links` → `issue` |
| `authorId` | reference | yes | `x-links` → `employee` |
| `body` | string | yes | |
| `postedAt` | date | yes | |
| `editedAt` | date | no | |

**Shape** — its own type, deliberately **not** an embedded array on `issue`. Embedding rewrites the
whole issue record on every comment and bumps its version, so two people commenting at the same time
collide on the concurrency check. Comments are also edited and deleted on their own.

## `issue-relation`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `fromIssueId` | reference | yes | `x-links` → `issue` |
| `toIssueId` | reference | yes | `x-links` → `issue` |
| `relationType` | enum | yes | `blocks`, `duplicates`, `relates-to` |

**Shape** — the join-type pattern: many-to-many, and the relationship carries a field of its own, so
it cannot be an array on either side. Skip it unless the user asked for dependency tracking; most
small teams never use it.

## Limits worth saying out loud before you build

Say these while proposing, not after the user finds them.

- **Statuses are fixed in the schema.** `status` is an enum on the type, so changing the workflow
  means editing the Resource type, not dragging columns in a settings screen. Get the list right at
  build time and ask whether they want `in-review` and `cancelled` before assuming.
- **The same statuses apply to every project.** Per-project workflows are not reachable.
- **Records display as a sortable table with a text filter, not a drag-and-drop board.** If the
  user pictured cards in columns, they should hear this before the type exists, not after.
- **Counting issues per cycle or project is a filtered query, not a stored number.** Do not add
  `issueCount` to `project` or `cycle`; nothing would keep it correct.
- **Deleting a project or cycle orphans the issues pointing at it.** Link targets are checked when
  the issue is written and never cascaded on delete. Prefer `status: cancelled` over deletion, or
  guard it in a `before` hook on `project`.

## Questions worth asking, and nothing else

The archetype answers everything else. Ask only:

1. Points or hours for `estimate`?
2. Do they run sprints — build `cycle` or not?
3. What prefix for the issue keys?
4. Any status in their real workflow that is missing from the list?
