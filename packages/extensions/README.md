# Extensions

TulipFarm runs complete with no extensions. An extension is a module that fills
typed slots at startup: billing, analytics, error reporting, feature flags,
lifecycle hooks, and its own migrations. Every slot has a no-op default, so
behavior with zero extensions is the open-source behavior.

## Loading

Set `TULIPFARM_EXTENSIONS` to comma-separated module specifiers. The api,
worker, and storage worker load them in order before telemetry starts; the
database migrate, `pnpm dev:setup`, and self-host setup steps load them to run
their migrations. A package
name resolves from the app (`apps/api`, `apps/worker`); `./` and `../` paths
resolve from the working directory; absolute paths and `file:` URLs work as is.

```sh
TULIPFARM_EXTENSIONS=@acme/tulipfarm-billing,./extensions/alerts.mjs pnpm --filter @tulipfarm/api dev
```

A module that cannot be imported, does not default-export an extension, or
throws in `register()` stops startup with one JSON line on stderr
(`"event":"extensions_load_failed"`) and exit code 1. A failed `register()`
leaves no partial registration.

## Writing an extension

```ts
import { defineExtension } from '@tulipfarm/extensions';

export default defineExtension({
  name: 'acme-billing',
  async register(slots, { app, env }) {
    slots.creditGate(gate);
    slots.analytics({ capture: event => client.capture(event), shutdown: () => client.shutdown() });
    slots.hooks({ 'user.signed-up': ({ userId }) => notify(userId) });
    slots.migrations({ schema: 'acme', migrations: [{ name: '0001_ledger.sql', sql }] });
  },
});
```

| Slot                 | Kind            | Default                                                                              | Read by                                                                                                       |
| -------------------- | --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `creditGate`         | one per process | `unlimitedCredits`: funds all work, stores no balance                                | the credit meter in `@tulipfarm/workspace-storage/credits`                                                    |
| `creditPricing`      | one per process | `providerCostPricing`: one credit per $0.01 of provider cost, no markup, no rounding | `creditUnitsForProviderCost`, the credit meter, knowledge-embedding credits, the model catalog's credit rates |
| `flagProvider`       | one per process | none: each flag's env override, then its declared default (see below)                | `isFeatureEnabled`, `featureFlagSnapshot` in `@tulipfarm/observability`                                       |
| `socialPlatformApps` | one per process | none: operator `SOCIAL_<PLATFORM>_*` settings supply platform apps                   | social platform-app resolution in `@tulipfarm/social`; when set, X and Reddit need a workspace's own app      |
| `usageSink`          | many            | none                                                                                 | `recordUsage(usage)`                                                                                          |
| `analytics`          | many            | none                                                                                 | `captureEvent`, `observeInference` in `@tulipfarm/observability`                                              |
| `errorReporter`      | many            | none                                                                                 | `captureException` in `@tulipfarm/observability`                                                              |
| `hooks`              | many            | none                                                                                 | `emitHook(event, payload)`                                                                                    |
| `migrations`         | many            | none                                                                                 | `extensionMigrations()`                                                                                       |

A second extension setting a single slot fails startup. Failures inside
analytics, error reporters, usage sinks, and hook subscribers never reach the
caller; sink and hook failures go to the error reporters. `flushExtensions()` and
`shutdownExtensions()` flush and close analytics, error, and flag clients.

### Credits

TulipFarm meters every model call itself: `reserveCredits` holds the call's
upper cost, `settleCredits` replaces it with the provider cost, and both rows
stay in the workspace schema whatever gate is registered. The gate is only the
balance that funds them. `available(tx, { lock })` returns the credit units the
workspace may still spend (10^12 per credit), or `null` when unlimited; with
`lock` the balance stays locked until the transaction ends. The meter refuses
work that does not fit and calls `debit(tx, units, entry)` in the same
transaction; a negative debit returns units when a settlement costs less than
its reservation.

Two optional methods let a gate keep per-workspace state. `provision(tx)` runs
while TulipFarm provisions a workspace, in the same transaction and as the
workspace schema owner, before the isolation check; create the gate's tables and
grants there (the workspace runtime role gets `SELECT`/`UPDATE` only through
grants you add). Provisioning retries, so `provision` must be idempotent.
Workspaces provisioned before the gate was registered need their own backfill.
`balance(tx)` returns `{ available, granted }` for the credit summary
(`GET /v1/workspaces/:id/credits`); without it the summary shows `available()`
and a `null` granted total, and with the default gate both are `null`
(unlimited).

`@tulipfarm/workspace-storage/credit-account` holds a test gate over a
per-workspace `tf_credit_account` table that TulipFarm's own tests register to
exercise exhaustion; `installCreditAccount(client, workspaceId)` creates the
table. TulipFarm never registers it.

Each settled call is also reported to usage sinks through `recordUsage` after
its transaction commits, with token counts when the provider reported them.

### Credit pricing

Providers' costs are metered in pico-USD (10^-12 USD). The `creditPricing` slot
converts them to credit units:

```ts
interface CreditPricing {
  readonly unitsPerPicoUsd: bigint; // credit units charged per pico-USD
  round(units: bigint): bigint; // applied once per aggregate
}
```

The rate applies to each call; `round` applies once to an aggregate (a flow's
total in `settleCredits`, a workspace's knowledge-embedding total), never per
call. It must map 0 to 0, never return less than its input, and be monotonic.
Reservations use the same pricing, so a reservation still covers its settlement.

The default, `providerCostPricing`, is `{ unitsPerPicoUsd: 100n, round: units =>
units }`: one credit per $0.01, no markup, fractional credits kept. A hosted
deployment adding a 50% markup and whole-credit rounding registers:

```ts
const credit = 1_000_000_000_000n;
slots.creditPricing({
  unitsPerPicoUsd: 150n,
  round: units => ((units + credit - 1n) / credit) * credit,
});
```

`creditUnitsForProviderCost(picoUsd)` returns `round(picoUsd × unitsPerPicoUsd)`.
Task budgets (`limits.credits`) and the credit gate count the same units.

Feature flags are declared once in `@tulipfarm/config/feature-flags` with a
description, a default (`true`, `false`, or `development`: on unless
`NODE_ENV=production`), and an override variable `FEATURE_FLAG_<NAME>`.
`isFeatureEnabled` resolves a flag in this order:

```text
flag provider ──boolean──▶ result
      │ undefined, throws (logged), or none
      ▼
FEATURE_FLAG_<NAME>=true|false ──▶ result
      │ unset
      ▼
FEATURE_FLAGS_OFF lists it ──▶ false
      │ no
      ▼
declared default
```

Each flag also declares a `scope`, which decides who it is evaluated for:

| Scope       | Distinct id      | Subject sent to the provider                     | Use for                                                            |
| ----------- | ---------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `user`      | the user id      | `user`, plus `workspace` when the caller has one | Per-person UI and features                                         |
| `workspace` | `workspace:<id>` | `workspace` only; any user is ignored            | Features that background work also checks, so API and worker agree |
| `global`    | `global`         | nothing                                          | Instance-wide switches                                             |

The provider receives the flag key and a `FlagSubject`:

```ts
{
  scope: 'user' | 'workspace' | 'global',
  distinctId: string,
  user?: { id, email?, emailDomain? },
  workspace?: { id, slug?, name?, createdAt? },
}
```

Callers pass ids. When a provider is registered, a subject resolver (registered
by the api and worker with `registerFlagSubjectResolver`) fills the missing
fields from trusted storage: user email in the api; workspace slug, name, and
creation time in both. Values the caller passes win, and `emailDomain` comes from
the final email. Lookups are cached for 60 seconds (at most 1000 entries),
concurrent lookups share one query, a lookup taking over a second is skipped, and
only UUIDs are looked up. The worker has no email, so user-scoped flags there see
the id only. With no provider, nothing is looked up.

A provider may implement `evaluateMany(flags, subject)`; `featureFlagSnapshot`
then evaluates each scope's flags in one call, and any flag it leaves `undefined`
falls back as above. A provider's `false` is a decision, not a fallback.

Flags select features; they never grant access. Callers check membership, roles,
and entitlements first. Target a specific customer by workspace id; slug and name
can change. Unknown flags are off and never reach the provider.

### Product analytics events

Server product events are declared once in `@tulipfarm/config/analytics-events`,
each with a description and its allowed properties: booleans, numbers, UUIDs,
enumerated values, and lower-case identifiers. `trackEvent(name, { userId?,
workspaceId? }, properties)` in `@tulipfarm/observability` drops undeclared
events, undeclared properties, and values of the wrong type, then calls every
`analytics` adapter with the user id (or `workspace:<id>` when there is no user)
and the `workspace` group. Events carry no content, names, or email.

| Event                      | Properties               | Emitted by                                           |
| -------------------------- | ------------------------ | ---------------------------------------------------- |
| `user_signed_up`           |                          | api, after better-auth creates the user              |
| `workspace_created`        |                          | storage worker, when setup marks the workspace ready |
| `member_invited`           | `resend`                 | api, when an email invitation is issued or resent    |
| `member_joined`            |                          | api, the first time an invitation is redeemed        |
| `conversation_started`     | `in_project`             | api, when a conversation commits                     |
| `message_sent`             |                          | api, when a user message commits                     |
| `agent_save_requested`     | `agent_id`, `created`    | api, when an agent save command is queued            |
| `workflow_saved`           | `workflow_id`, `created` | api, when a workflow version commits                 |
| `integration_connected`    | `provider`               | api, when an integration connection commits          |
| `integration_disconnected` | `provider`               | api, when an integration is disconnected             |
| `task_completed`           | `outcome`                | worker, on a task's terminal transition              |

Each fires after its change commits; idempotent replays fire nothing. Workspace
renames, workflow and agent runs, knowledge sources, and social posts have no
event yet.

Two calls store profile data through the optional `ProductAnalytics.group` and
`ProductAnalytics.person` methods. `identifyWorkspace` stores the workspace's
`name`, `slug`, and `created_at` on its `workspace` group when it becomes ready.
`identifyUser` stores only `email_domain` on the person at sign-up; the email is
never stored on a profile. Adapters without these methods skip them.

### Hook events

Each event fires once its change has committed; a rolled-back change fires
nothing. Emitters do not wait for subscribers, and `emitHook` never rejects: a
failing subscriber is logged (`extension_hook_failed`) and sent to the error
reporters. Delivery is in-process and at most once per commit, so a crash right
after commit can drop an event. Payloads carry ids, not content, except the
names and email noted below.

| Event               | Payload                                                                                                                         | Emitted by                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `user.signed-up`    | `userId`, `email`, `name` (the only PII, for lifecycle email)                                                                   | api, after better-auth creates the user                                                    |
| `workspace.created` | `workspaceId`, `workspaceName` (display name), `userId` (creator)                                                               | storage worker, when setup marks the workspace ready                                       |
| `member.invited`    | `workspaceId`, `invitationId`, `invitedByUserId`, `replacesInvitationId` (revoked one on resend, else `null`)                   | api, when an email invitation is issued or resent                                          |
| `task.completed`    | `workspaceId`, `taskId`, `outcome` (`completed` \| `failed`)                                                                    | worker, on a task's terminal transition; a retried task can complete again                 |
| `usage.recorded`    | `workspaceId`, `usageId` (attempt id), `flowId` (`null` for workspace knowledge work), `modelId`, `activity`, `providerPicoUsd` | api and worker, when a model attempt's cost settles (chat, agent, table search, knowledge) |

`usage.recorded.providerPicoUsd` is the cost the ledger settled at: `0` for an
attempt never sent, and the reservation's bound when the provider's usage
stayed unknown. It is separate from `recordUsage()` and the `usageSink` slot.

Inside workspace storage, emitters register with `afterCommit(client, callback)`
from `@tulipfarm/workspace-storage/runtime`, which runs after the enclosing
transaction commits and drops the callback on rollback.

Extension migrations use their own schema (not `public`, `app`,
`database_management`, or `pg_*`), named `NNNN_name.sql` in ascending order.
`apps/database` applies them after TulipFarm's migrations, under the same
advisory lock, in extension load order. Each set runs with `search_path` set to
its schema, then `app`, then `public`, one transaction per migration, and
records receipts in `<schema>.schema_migrations`, never in TulipFarm's
`database_management.migrations`. Re-running is a no-op; an edited, removed, or
reordered applied migration stops the run. These migrations cover platform
tables only; they do not run inside workspace schemas.

## Web overrides

`@tulipfarm/extensions/web` is a browser-safe override registry. The web app
declares overridable components and routes with defaults; web extensions replace
entries by name before render, then the registry seals.
The web app's entries (`analytics`, `credits`, `usage`) and the
`VITE_TULIPFARM_WEB_EXTENSIONS` build setting that selects extensions are listed in
[`apps/web/README.md`](../../apps/web/README.md#web-extensions).

```ts
const overrides = createOverrideRegistry({ 'settings.billing': UnlimitedCredits });
overrides.apply([billingWebExtension]);
const Billing = overrides.get('settings.billing');
```

### Browser analytics

The web app declares an `analytics` override with `noopBrowserAnalytics` as the
default and calls it through `guardBrowserAnalytics`, so a throwing client never
breaks rendering. With the default, `configured()` is false and no consent prompt,
script, or network request exists.

```ts
import { createOverrideRegistry, guardBrowserAnalytics, noopBrowserAnalytics } from '@tulipfarm/extensions/web';

const overrides = createOverrideRegistry({ analytics: noopBrowserAnalytics });
overrides.apply(webExtensions);
export const analytics = guardBrowserAnalytics(overrides.get('analytics'));
```

The app calls `identify(userId, { emailDomain })` on sign-in and
`workspace({ id, slug, name })` when a workspace page opens, then
`workspace(undefined)` when it closes. Each call replaces the previous context;
a client must drop the old user or workspace targeting rather than add to it. A
client sends this context only after consent, and only for targeting (surveys,
replay rules); it never stores the email. App feature flags still come from
`/v1/feature-flags`.

## Analytics and error-reporting vendors

TulipFarm contains no analytics or error-reporting vendor code, and self-hosted
installs send no telemetry. Traces, metrics, and logs use OpenTelemetry. A private
extension adds a vendor by implementing the slots:

| Side        | Slot                 | Implements                                             | Typical vendor call                                                                    |
| ----------- | -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| api, worker | `analytics`          | `ProductAnalytics.capture/group/person/flush/shutdown` | PostHog Node `capture`, `groupIdentify`, `$set`                                        |
| api, worker | `errorReporter`      | `ErrorReporter.captureException/flush/shutdown`        | PostHog `captureException` or Sentry Node `captureException`                           |
| api, worker | `flagProvider`       | `FlagProvider.isEnabled/evaluateMany/shutdown`         | PostHog `isFeatureEnabled`/`getAllFlags` with `FlagSubject` as person/group properties |
| web         | `analytics` override | `BrowserAnalytics`                                     | `posthog-js` or Sentry Browser                                                         |

```ts
// In the private extension package, which owns the vendor dependency.
import { defineExtension } from '@tulipfarm/extensions';
import { PostHog } from 'posthog-node';

export default defineExtension({
  name: 'acme-analytics',
  register(slots, { env }) {
    if (!env.POSTHOG_PROJECT_TOKEN) return;
    const client = new PostHog(env.POSTHOG_PROJECT_TOKEN, {
      host: 'https://us.i.posthog.com',
      enableExceptionAutocapture: true,
    });
    const adapter = {
      capture: event => client.capture(event),
      captureException: (error, distinctId) => client.captureException(error, distinctId),
      flush: () => client.flush(),
      shutdown: () => client.shutdown(),
    };
    slots.analytics(adapter);
    slots.errorReporter(adapter);
  },
});
```

Rules for adapters:

- Read keys, hosts, and DSNs from the extension's own environment; TulipFarm
  declares no vendor settings.
- Server events carry identifiers and metrics only, and are sent without browser
  consent; disclose them in the deployment's privacy notice. `observeInference` sends
  `$ai_generation`/`$ai_embedding` with model, latency, and token counts, never
  prompt or completion text.
- Register one object for several slots; `flushExtensions()` and
  `shutdownExtensions()` call each distinct object once.
- TulipFarm reports 5xx request errors, failed Temporal activities, failed
  background jobs, and startup/shutdown failures. Uncaught exceptions outside
  those paths need the vendor's own autocapture.
- The web adapter must keep consent: send nothing until `choose(true)`, honor
  Do Not Track / Global Privacy Control. If the deployment sets a CSP, the
  private deployment adds the vendor hosts to `connect-src`, not TulipFarm.
