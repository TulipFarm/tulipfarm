# Core Types

Two types that other archetypes link to. Build them first in any bundle that names them, because a
link cannot point at a type that does not exist yet.

Always call `list_resource_types` before creating either — an instance that has been used for a
while usually has one already, possibly under a different name (`client`, `account`, `staff`,
`person`). Reuse it rather than creating a second one.

## `customer`

The company or account other records point at.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Display name |
| `domain` | string | no | Primary email/web domain |
| `tier` | enum | no | `free`, `pro`, `enterprise` |
| `status` | enum | yes | `prospect`, `active`, `churned` |
| `ownerId` | reference | no | `x-links` → `employee` |
| `billingAddress` | object | no | `line1`, `line2`, `city`, `region`, `postalCode`, `country` |
| `annualValue` | number | no | Recurring revenue |
| `startedOn` | date | no | |

**Shape** — `billingAddress` is embedded: no identity of its own, never listed alone, dies with the
customer.

`x-unique: [[domain]]` only when one domain genuinely means one customer. For an agency or a group
with many subsidiaries on a shared domain it makes every second create fail, so ask before adding
it.

## `employee`

The people directory. Assignees, owners, approvers and managers across every other archetype are
links to this type.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `fullName` | string | yes | |
| `workEmail` | string | yes | |
| `jobTitle` | string | no | |
| `department` | enum | no | Ask for the real list; a wrong enum is a schema edit later |
| `managerId` | reference | no | `x-links` → `employee` — self-link, gives the org chart |
| `startDate` | date | yes | |
| `endDate` | date | no | |
| `employmentType` | enum | yes | `full-time`, `part-time`, `contractor`, `intern` |
| `location` | string | no | |
| `status` | enum | yes | `active`, `on-leave`, `departed` |
| `emergencyContact` | object | no | `name`, `relationship`, `phone` |

**Shape** — `x-unique: [[workEmail]]`. `emergencyContact` is embedded. `managerId` pointing at the
same type is what makes the org chart work; there is no separate hierarchy type.

**Left out on purpose.** Home address, salary, bank details, date of birth and national ID are not
in the default set. Offer them as an explicit addition and say what changes: anyone who can read
the type can read every field on it, so putting salary here means the directory and the payroll
data share one permission. A separate type for the sensitive fields, linked by `employeeId`, is
usually what the user actually wants.

**Departures.** `status: departed` with an `endDate` keeps history intact. Deleting the record
orphans every link pointing at it — past leave requests, closed issues, old invoices — because link
targets are checked on write and never cascaded on delete.
