# HR & People Ops

Everything built around the people directory. Build `employee` from `core-types.md` first —
every type here links to it.

Match the request to the smallest set that answers it. "Leave management" does not need
`job-application`, and offering all five at once buries the thing they asked for.

| They say | Build |
| --- | --- |
| employee directory, org chart, staff list, HR system | `employee` alone |
| leave management, time off, PTO, holiday tracker, absence | `leave-request` + `employee` |
| hiring, applicant tracking, recruiting, candidate pipeline | `job-application` + `employee` |
| onboarding, new-hire checklist, first-week setup | `onboarding-task` + `employee` |
| IT assets, equipment, laptop tracking, inventory | `asset-assignment` + `employee` |

`employee` itself lives in `core-types.md`, including what is deliberately left out of it and why
salary and identity documents belong in a separate linked type.

## `leave-request`

Time off, from request to approval. The archetype with the strongest case for hooks in this file.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `employeeId` | reference | yes | `x-links` → `employee` |
| `leaveType` | enum | yes | `annual`, `sick`, `unpaid`, `parental`, `bereavement` |
| `startDate` | date | yes | |
| `endDate` | date | yes | |
| `dayCount` | number | no | Computed in a hook — see below |
| `halfDay` | boolean | no | |
| `reason` | string | no | Optional on purpose; sick leave should not require one |
| `status` | enum | yes | `draft`, `submitted`, `approved`, `rejected`, `cancelled` |
| `approverId` | reference | no | `x-links` → `employee` |
| `decidedAt` | date | no | |
| `decisionNote` | string | no | |

**Hooks worth offering** — say which of these they want before writing any:

- Compute `dayCount` from the dates, and mark it `x-readOnly` so the stored number cannot disagree
  with the range. Business-day counting is possible; public holidays are not, unless the holidays
  themselves are a Resource type the hook can read.
- Reject `endDate` earlier than `startDate`.
- Guard the transitions: only `submitted` → `approved` or `rejected`, and only `draft` →
  `submitted`.
- Block self-approval — `approverId` equal to `employeeId`.
- Overlap detection against the same employee's approved leave. A hook can read other records to do
  it, so say it costs a lookup on every write.

**Balances are a separate decision.** "How many days do I have left?" is not a field on this type.
It is either a `leave-balance` type per employee per year that a hook decrements, or a filtered sum
computed when someone asks. Ask which; do not add an `remainingDays` field to `employee`, because
nothing would keep it correct.

## `job-application`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `candidateName` | string | yes | |
| `email` | string | yes | |
| `phone` | string | no | |
| `roleTitle` | string | yes | |
| `stage` | enum | yes | `applied`, `screening`, `interviewing`, `offer`, `hired`, `rejected` |
| `source` | enum | no | `referral`, `job-board`, `outbound`, `careers-page` |
| `appliedAt` | date | yes | |
| `recruiterId` | reference | no | `x-links` → `employee` |
| `referredById` | reference | no | `x-links` → `employee` |
| `resumeUrl` | string | no | |
| `interviewRounds` | array | no | Objects: `name`, `interviewerId`, `scheduledAt`, `outcome`, `notes` |
| `rejectionReason` | string | no | |

**Shape** — `interviewRounds` is embedded: a round belongs to this application and nothing else, and
is never listed on its own. If the user wants interviewers to see "my upcoming interviews" as a
list, that is the case for splitting rounds into their own type — ask rather than assuming.

**Say this once, do not decide it.** Candidate records are personal data about people who do not
work there, and most jurisdictions put a retention limit on them. Mention that deletion or
anonymisation after a period is usually required, and leave the policy to the user.

If they want a hired candidate to become an `employee`, that is a copy at conversion time, not a
link — the two records have different lifecycles and different readers.

## `onboarding-task`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `employeeId` | reference | yes | `x-links` → `employee` |
| `task` | string | yes | |
| `category` | enum | no | `it`, `payroll`, `compliance`, `training`, `social` |
| `ownerId` | reference | no | `x-links` → `employee` |
| `dueDate` | date | no | |
| `status` | enum | yes | `pending`, `in-progress`, `done`, `blocked` |
| `completedAt` | date | no | |

**Shape** — one record per task, not an array on `employee`. Different people own different tasks,
each has its own due date, and IT wants to see every pending IT task across all new hires — none of
which works if they are buried in an array on the person.

A reusable checklist template is a separate idea. Generating the tasks for each new hire is a
Routine, not a field here.

## `asset-assignment`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `assetTag` | string | yes | |
| `assetType` | enum | yes | `laptop`, `monitor`, `phone`, `badge`, `other` |
| `model` | string | no | |
| `serialNumber` | string | no | |
| `assignedToId` | reference | no | `x-links` → `employee`; empty means in stock |
| `assignedAt` | date | no | |
| `returnedAt` | date | no | |
| `condition` | enum | no | `new`, `good`, `worn`, `damaged` |
| `purchaseDate` | date | no | |
| `purchaseCost` | number | no | |
| `notes` | string | no | |

**Shape** — `x-unique: [[assetTag]]`.

**The fork worth raising.** This models the asset together with its *current* holder, so
reassigning a laptop overwrites who had it before. That is fine for "who has what right now" and
wrong for "who had this laptop when it was damaged". The alternative is two types — `asset` and
`asset-assignment` linking to it — which keeps the history and costs an extra lookup everywhere.
Ask, because converting later means migrating every record.

## Limits worth saying out loud

- **Statuses and enums are fixed in the schema.** Their real department list and leave types should
  be collected now, not guessed.
- **Anyone who can read a type reads every field on it.** That is why sensitive fields belong in a
  separate linked type rather than on `employee`.
- **Deleting an employee orphans every link pointing at them** — past leave, old applications,
  assigned assets. Use `status: departed`.
