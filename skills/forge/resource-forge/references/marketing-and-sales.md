# Marketing & Sales

Pipeline, campaigns and content. Build `customer` and `employee` from `core-types.md` first where
the chosen types link to them.

| They say | Build |
| --- | --- |
| CRM, sales pipeline, lead tracking, prospects | `lead` + `customer` |
| marketing, campaign tracking, channel spend | `campaign` + `lead` |
| content calendar, editorial planning, blog pipeline | `content-piece` |
| events, webinars, conferences | `event` |

"A CRM" is the ambiguous one. Ask whether they are tracking people they hope to sell to (`lead`),
companies they already sell to (`customer`), or both with a conversion between them — which is the
usual answer.

## `lead`

A prospect, before they become a customer.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `fullName` | string | yes | |
| `email` | string | yes | |
| `company` | string | no | |
| `jobTitle` | string | no | |
| `source` | enum | no | `website`, `event`, `referral`, `outbound`, `campaign` |
| `campaignId` | reference | no | `x-links` → `campaign` |
| `stage` | enum | yes | `new`, `contacted`, `qualified`, `unqualified`, `converted` |
| `score` | number | no | |
| `ownerId` | reference | no | `x-links` → `employee` |
| `convertedCustomerId` | reference | no | `x-links` → `customer`; set on conversion |
| `lastContactedAt` | date | no | |
| `notes` | string | no | |

**Shape** — `lead` and `customer` stay separate types. A lead has a qualification lifecycle a
customer does not, and merging them fills the customer list with people who never bought anything.
`convertedCustomerId` is the bridge, and conversion copies what should carry over rather than
moving the record.

`x-unique: [[email]]` only if they genuinely never re-engage an old lead. Most teams do, so leave it
off unless they ask.

**Activity history** — calls, emails, meetings — is not an embedded array. Each has its own author
and date and gets listed across leads ("my calls this week"), so it is a `lead-activity` type
linking back with a `leadId`. Offer it only if they ask for activity tracking; it doubles the build.

## `campaign`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | |
| `channel` | enum | yes | `email`, `paid-search`, `paid-social`, `organic`, `events`, `partner` |
| `status` | enum | yes | `planned`, `active`, `paused`, `completed` |
| `startDate` | date | yes | |
| `endDate` | date | no | |
| `budget` | number | no | |
| `spend` | number | no | Entered, not computed |
| `currency` | string | no | ISO code |
| `goal` | string | no | |
| `ownerId` | reference | no | `x-links` → `employee` |

**Shape** — lead counts, conversion rates and cost-per-lead are **not** fields here. Each is a
filtered count of `lead` records by `campaignId`, and storing it on the campaign gives a number that
silently goes stale the moment a lead is added. Say this when the user asks for them, and say where
the real number comes from.

## `content-piece`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `title` | string | yes | |
| `contentType` | enum | yes | `blog`, `case-study`, `video`, `whitepaper`, `social`, `newsletter` |
| `status` | enum | yes | `idea`, `drafting`, `in-review`, `scheduled`, `published`, `archived` |
| `authorId` | reference | no | `x-links` → `employee` |
| `campaignId` | reference | no | `x-links` → `campaign` |
| `channel` | string | no | |
| `dueDate` | date | no | |
| `publishDate` | date | no | |
| `url` | string | no | |
| `tags` | array | no | Strings |

**Shape** — `tags` is an embedded array of strings, not links. Same reason as labels elsewhere: no
lifecycle of their own, and an array of references is not validated.

**Nothing publishes on its own.** `scheduled` with a `publishDate` records intent. Actually posting
is an Integration and a Routine.

## `event`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | |
| `eventType` | enum | yes | `webinar`, `conference`, `meetup`, `workshop`, `trade-show` |
| `status` | enum | yes | `planned`, `open`, `running`, `completed`, `cancelled` |
| `startsAt` | date | yes | |
| `endsAt` | date | no | |
| `location` | string | no | Venue, or a URL when virtual |
| `campaignId` | reference | no | `x-links` → `campaign` |
| `ownerId` | reference | no | `x-links` → `employee` |
| `budget` | number | no | |
| `capacity` | number | no | |
| `sessions` | array | no | Objects: `title`, `speaker`, `startsAt`, `durationMinutes` |

**Shape** — `sessions` embedded; they exist only within the event.

**Attendees are not an embedded array.** They are people with their own follow-up, so they belong
either as `lead` records carrying this event's `campaignId`, or as a dedicated registration type if
the user needs check-in tracking and a capacity count. Ask which; the second is a real extra build.

## Limits worth saying out loud

- **Every rollup is a query, not a field.** Leads per campaign, revenue per channel, published posts
  this month — none of these should be stored, because nothing would keep them correct.
- **Enums are fixed in the schema.** Collect their real channel and content-type lists now.
- **Deleting a campaign orphans the leads and content pointing at it.** Use `status: completed`.
