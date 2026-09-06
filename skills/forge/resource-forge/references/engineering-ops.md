# Engineering Ops

Services, incidents and releases. Build this when the user asks for incident management, on-call
records, postmortems, a service catalog, or a deploy log.

For issue and sprint tracking use `ticket-management.md`.

## The bundle

| They say | Build |
| --- | --- |
| incident management, on-call, postmortems, outage log | `incident` + `service` |
| service catalog, ownership registry, who owns what | `service` alone |
| deploy log, release tracking, change log | `deployment` + `service` |

Build `service` first — the other two link to it.

## `service`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | |
| `description` | string | no | |
| `repoUrl` | string | no | |
| `tier` | enum | yes | `tier-1`, `tier-2`, `tier-3` |
| `ownerId` | reference | no | `x-links` → `employee` |
| `ownerTeam` | string | no | Team name, when teams are not their own type |
| `oncallContact` | string | no | Rotation name or channel |
| `runbookUrl` | string | no | |
| `status` | enum | yes | `active`, `deprecated`, `retired` |

**Shape** — `x-unique: [[name]]`.

## `incident`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `key` | string | no | `x-id-strategy` → `INC-1`; `x-readOnly` |
| `title` | string | yes | |
| `severity` | enum | yes | `sev1`, `sev2`, `sev3`, `sev4` |
| `status` | enum | yes | `investigating`, `identified`, `monitoring`, `resolved`, `postmortem-done` |
| `serviceId` | reference | no | `x-links` → `service` |
| `commanderId` | reference | no | `x-links` → `employee` |
| `detectedAt` | date | no | |
| `startedAt` | date | yes | |
| `resolvedAt` | date | no | |
| `customerImpact` | string | no | |
| `rootCause` | string | no | |
| `timeline` | array | no | Objects: `at`, `note`, `authorId` |
| `actionItems` | array | no | Objects: `description`, `ownerId`, `dueDate`, `done` |

**Shape** — `timeline` is embedded: entries have no meaning outside the incident and are never
listed alone.

**The fork worth raising.** `actionItems` embedded is right if they are a postmortem checklist
nobody tracks elsewhere. If the user wants follow-up work on the same board as everything else, the
action items should be `issue` records linking back with an `incidentId` field instead. Ask —
converting later means migrating every incident.

**One incident, one service** as written. A `serviceIds` array would not be validated at all, so
multi-service incidents need either a join type or the honest answer that `serviceId` names the
primary one. Say which you chose.

**Hooks worth offering** — compute `durationMinutes` from `startedAt` and `resolvedAt`, and set
`resolvedAt` on the transition into `resolved`.

## `deployment`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `serviceId` | reference | yes | `x-links` → `service` |
| `version` | string | yes | |
| `commitSha` | string | no | |
| `environment` | enum | yes | `dev`, `staging`, `production` |
| `status` | enum | yes | `pending`, `succeeded`, `failed`, `rolled-back` |
| `deployedById` | reference | no | `x-links` → `employee` |
| `deployedAt` | date | yes | |
| `rolledBackAt` | date | no | |
| `notes` | string | no | |

**Shape** — a rollback is a status on the original record, not a second deployment, unless the user
wants the rollback itself timed and attributed. Ask which.

## Limits worth saying out loud

- **Nothing writes these records for you.** A deploy log is populated by a Routine calling this type
  from CI, or by hand. The Resource type is the store, not the collector.
- **"Deploys this week" and "incidents per service" are filtered queries, not stored counts.** Do
  not add `incidentCount` to `service`.
- **Deleting a service orphans its incidents and deployments.** Use `status: retired`.
