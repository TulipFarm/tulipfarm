# Discovery and rollout follow-up

Source and local tests inspected on 27 September 2026.

## Discovery limits

[`listWorkspaces`](../../../workspaces/src/store.ts) reads registry candidates in
100-row keyset pages ordered by name and ID. A read-only repeatable-read transaction
keeps that ordering stable if names change during the scan. The scan buffers at most
1,000 candidates and one overflow row, then releases the registry integration before
membership checks need that pool for credential resolution. Membership checks use
current workspace runtime transactions and the authorization lock.

The scan permits 1,000 candidates and probes for overflow. It rejects overflow,
failed permission checks, and failed registry queries instead of returning a partial
list. Each batch has at most four permission checks. The registry transaction uses
a five-second statement timeout and a 60-second idle timeout.

The 30-second scan budget is checked before each page and batch, and after all
checks. In-flight work drains before rejection, so this is not a strict
30-second response deadline. Runtime admission, credential resolution, integration,
statement, and lock timeouts still bound individual checks. The runtime's pool and
deployment integration budgets remain in force.

[`discovery.integration.mjs`](../../../workspaces/test/discovery.integration.mjs)
uses a restricted registry login and 200 distinct workspace runtime logins. It checks
102 and 200 candidates, two users, empty access, revocation during discovery, SQL
denial, credential failure, recovery, ordering, and four-integration limits.
[`discovery.test.mjs`](../../../workspaces/test/discovery.test.mjs) checks the
1,000-candidate boundary, overflow, elapsed-budget rejection, and a later-page error.

## Rollout failure behavior

[`rolloutCommonMigrations`](../../src/migrations.ts) waits for every worker to settle
and close its integration before it throws an `AggregateError` containing worker
failures. Healthy siblings finish their queued work. The controller closes afterward.
Completed workspace transactions and their progress rows remain committed.

A failed integration attempt has no workspace progress row. If an integration terminates
after a `pending` row is written, the same integration cannot record `failed`. That
row remains `pending`, with no incremented attempt, while committed siblings retain
`applied`. The rollout rejects, so callers must not interpret those rows as a successful
whole rollout. A later rollout can revisit them. Callback failures also reject after
draining, even when the workspace migration has already committed.

[`rollout-draining.test.mjs`](rollout-draining.test.mjs) exercises multiple callback
failures, integration rejection, and an intentionally terminated PostgreSQL backend
with delayed sibling migrations. The termination is a controlled failure fixture.
It does not explain the separate integration termination reported by the capacity run.

## Local verification command

Build dependencies with `pnpm exec turbo run build --filter=@tulipfarm/workspaces...`.
Use the disposable local database URL described in
[development](../../../../docs/development.md), then run:

```sh
node --test packages/workspaces/test/discovery.test.mjs packages/workspaces/test/discovery.integration.mjs packages/workspace-storage/test/integration/rollout-draining.test.mjs packages/workspace-storage/test/integration/rollout.test.mjs
pnpm check
```
