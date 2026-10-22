# Integration backend integration

Inspected and tested on 28 September 2026. This package implements local backend behavior. The [delivery evidence](../../docs/integrations-delivery.md) records passing real GitHub, compiled worker, browser, and independent-review checks, plus parent integration gates.

## Public exports

`@tulipfarm/integrations` exports `createIntegrationService`, `IntegrationError`, `integrationCompatibility`, `integrationCredentialKeyring`, and the `IntegrationService`, `IntegrationStorage`, and `IntegrationKeyring` types.

`createIntegrationService({ runtime, keyring?, providerFetch? })` uses real `fetch` by default. The optional fetch dependency supports deterministic failure and concurrency tests.

Every service operation takes `workspaceId`, then an authenticated user ID or trusted `Actor`. The remaining arguments follow the requested service contract.

| Operation                                          | Result                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `list`                                             | `{ integrations: IntegrationMetadata[] }`                                                                         |
| `create`                                           | `IntegrationMetadata`. A creator without read permission receives a creation receipt, not later private metadata. |
| `get`, `rotate`, `update`, `setGrants`, `transfer` | `IntegrationDetail`                                                                                               |
| `remove`                                           | `{ removed: true }`                                                                                               |
| `readIssue`                                        | `{ number, title, body, state, url }`                                                                             |
| `creationContext`                                  | `{ teams: [{ id, name }] }` containing authorized destination teams                                               |
| `setCreationGrants`                                | Accepts and returns `{ owningTeamId, teamIds }`. Only admins can call it.                                         |

Metadata contains `id`, `name`, `owningTeamId`, `enabled`, `generation`, `grantsVersion`, and `capabilities`. Capabilities are `read`, `use`, `manage`, and `administer`. Detail adds `repositories`, each with `canReadIssues`. Only admin detail includes `grants` and `sourceGrants`.

`setGrants` requires `{ expectedGrantsVersion, grants, sourceGrants }`. The database starts `grants_version` at 1. Under the authorization write lock, a matching version increments once with the policy replacement. A stale version returns `conflict` without changing grants or audit events. UI callers send the version from the detail they edited.

`@tulipfarm/integrations/contracts` imports Zod and the browser-safe `uuidSchema` from `@tulipfarm/access/contracts`. It exports the request and response schemas used by the API, including `integrationCreationGrantsSchema`. Agent contracts also import these browser-safe exports. UUID inputs normalize to lowercase before credential binding, advisory lock construction, scope evaluation, and replay comparison. User IDs remain opaque strings.

`@tulipfarm/integrations/common-migrations` exports `integrationCommonMigrations()`. It returns only this package's SQL migration, `0012_connections.sql`. The workspace aggregate merges and sorts it with the existing common stream. Versions count receipts rather than filename prefixes. Integrated integration compatibility requires ten receipts, including invitation `0010`, saved-agent `0011`, integration `0012`, and scheduling `0013`. The [integration evidence](../../docs/integration-evidence.md) records this combined stream.

## Authorization and storage

Integration permissions use dedicated tables. The existing resource grant table and resource permission vocabulary are unchanged. `canAccessAsset` resolves integration read, use, manage, creation, and `github.issue.read` through their own targets. Source IDs are UUID asset IDs in the existing agent scope arrays.

Use and manage require explicit read. Grant validation and a deferred self-referencing foreign key enforce that prerequisite. Ownership grants no access. Creation grants target destination teams. Only admins manage grants, source grants, creation grants, and ownership.

`tf_integrations` retains tombstones and immutable creation intent. Removal clears encrypted credentials and disables the integration. Foreign keys preserve historical source and dispatch identities. A generated `live_owning_team_id` references the owning team only while the integration is live. Deleted integrations preserve their original `owning_team_id` without preventing team deletion. Governance owns active-ownership checks, grant cleanup, and the existing `tf_retired_teams` identity protection.

## Credentials

The keyring reads these environment variables:

- `INTEGRATION_CREDENTIAL_KEY_ID` identifies the active key.
- `INTEGRATION_CREDENTIAL_KEY` is a 32-byte AES key encoded as 64 hexadecimal characters.
- `INTEGRATION_CREDENTIAL_PREVIOUS_KEYS` is an optional JSON object mapping prior key IDs to hexadecimal keys.

The previous-key object must not contain the active key ID. AES-256-GCM authenticates the workspace ID, integration ID, and credential generation. Rotation uses `expectedGeneration` compare-and-swap. No public API resolves credentials. Ciphertext is accessible only to the restricted runtime database capability, not migration or confirmation logins.

Default API storage composition and ordinary-worker agent composition load the keyring explicitly at startup. Deployments supply `INTEGRATION_CREDENTIAL_KEY` and the optional `INTEGRATION_CREDENTIAL_PREVIOUS_KEYS` from their secret store. Both processes receive an explicit `INTEGRATION_CREDENTIAL_KEY_ID`. These are source configuration requirements, not evidence of provisioned secrets or deployment.

## Dispatch and retries

Lock order is workspace authorization, request advisory lock, agent run for agent calls, integration row, then dispatch row. Current grants and agent authority are evaluated after the authorization lock. A dispatch record commits before decryption and HTTP. Revocation after that commit cannot recall the provider request, but result delivery reauthorizes.

`requestId` binds immutable actor incarnation or run, integration, source, and issue number. Each completed request retains one sanitized result. Concurrent callers see `in-progress`. A failed attempt can retry at most three times under the same ID. Every retry reauthorizes and snapshots the current credential generation. Execution older than 60 seconds becomes terminal failed on observation. It does not automatically retry an ambiguous attempt.

After a recorded failure with attempts remaining, `readIssue` throws `provider-retryable`. The agent executor returns `waiting`, so `boundedAgentTool` retries after its timer or resume signal. Exhausted attempts, stale ambiguous dispatches, and late results that lose their dispatch update remain `provider-failed`. The API maps the retryable code to HTTP 503 without exposing provider diagnostics.

Only `GET https://api.github.com/repos/{owner}/{repo}/issues/{number}` is supported. Redirects fail. The provider timeout is ten seconds, and the response limit is 256 KiB. Pull-request responses and mismatched issue numbers fail. Returned fields are bounded and exclude provider headers and unknown fields. Provider errors never retain their original message or cause.

## Agent integration and merge points

`createAgentExecutor({ runtime, integrations })` accepts a service with `readIssue`. The integration branch loads the validated persisted call, verifies its definition and predecessors, commits, and then calls the service outside the SQL transaction. `requirePersistedIssueCall` rechecks that exact call at dispatch. Agent result reads reauthorize the integration, source, and live agent scopes.

Integration preserves the saved-agent live invoke checks in `packages/access/src/index.ts` and `packages/agents/src/store.ts`. The ordinary-worker proof saves `github.issue.read` through Soul, executes delegated and scheduled reads, then revokes only invoke permission. Integration/source grants remain, but the delegated run and result reads fail authorization.

## Local verification

The following commands passed against disposable databases on the existing PostgreSQL container at `127.0.0.1:5432`:

```sh
pnpm --filter @tulipfarm/agents... build
pnpm --filter @tulipfarm/integrations test
pnpm --filter @tulipfarm/integrations test:integration
pnpm --filter @tulipfarm/agents test
pnpm --filter @tulipfarm/agents test:integrations
TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres pnpm --filter @tulipfarm/access test:integration
TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres pnpm --filter @tulipfarm/agents exec node --test test/store.integration.mjs
pnpm exec oxlint --deny-warnings packages/access packages/agents packages/integrations
git diff --check
```

Integration tests cover encrypted generation binding, previous keys, provider restrictions, human permissions, creation, rotation, deletion, FK enforcement, restricted capability denial, dispatch races, retries, and stale dispatch. Agent tests cover persisted call validation, ordering, concurrent execution, current limits, run scope, delegated membership incarnation, scheduled revocation, and sanitized results.

The review-fix regressions in `test/service.integration.mjs` cover uppercase creation, rotation, replay, canonical PostgreSQL advisory locks, stale and concurrent grant versions, rollback after invalid grants, and historical dispatch retention after team deletion. `../agents/test/integrations.integration.mjs` covers uppercase agent scopes and persisted calls, retry exhaustion, and stale ambiguity. Its local Temporal test observes a durable timer after provider failure, resumes with a rotated credential, and verifies that activation revocation prevents a later dispatch. The provider remains a deterministic test dependency.

On 28 September 2026, `pnpm check` passed all 39 tasks. The focused integration, agent integration, access, and agent-store integration commands also passed. The local Temporal test uses the existing server at `127.0.0.1:7233` and creates isolated workflow IDs and a task queue.

The [delivery evidence](../../docs/integrations-delivery.md) supersedes this package's earlier backend-only verification scope. Real-provider acceptance and local composition passed. Production acceptance remains open. Governance changes that directly alter integration grant policies increment `grants_version` under the authorization write lock so stale editors cannot restore removed grants.
