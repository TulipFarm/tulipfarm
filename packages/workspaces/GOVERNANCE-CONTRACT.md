# Governance integration contract

Inspected 27 September 2026 against fetched main `5021d12`, foundation `bd4bc332`, and the resource-service owner's current `packages/access/src/index.ts`.

## Ownership and dependencies

This partition owns `src/governance.ts`, browser-safe `src/governance-contracts.ts`, `apps/api/src/governance.ts`, and new web governance views. It does not edit the workspace store, creation replay, shared access implementation, or sibling worktrees. Foundation `bd4bc332` and shared access `0c744501` are cherry-picked locally for verification.

The service accepts `{ runtime, identity, compatibility }`. Runtime is the foundation transaction router. Identity is a trusted platform query capability. `registerGovernance(app, { auth, runtime, identity: pool, compatibility })` is the API composition hook for the lifecycle/integration owner, mounted under `/v1`. No production composition is changed here.

## Authority and data shape

Human actors come from server sessions. Each command locks through `@tulipfarm/access.lockAuthorization`, then resolves the active incarnation through `resolveHuman` and checks `currentMember`. Admin commands and invitation redemption use the exclusive lock. Reads use the shared lock. Removal soft-removes the membership and deletes its team enrollment. Rejoin allocates a new membership UUID. Every path that demotes or removes an admin checks the remaining admin count under the same exclusive lock.

The two candidate designs were separate membership/team/grant stores and one workspace governance service. The service is selected because it keeps the shared transaction and final-admin invariant in one place. Browser contracts remain separate from SQL and platform identity.

Grant targets are a discriminated union of `resource` and `collection`. Collection grants store the destination team UUID as `asset_id` with `resource.create`. Resource grants store the resource UUID and one of the exact shared permission names. Ownership and team creation grant no permissions. Record create/read/update/delete and schema management remain independently selected. Reading records is an explicit additional permission, including for a schema manager who needs to inspect record values.

Member profiles are loaded from platform identity only for active IDs selected under workspace authorization. There is no global identity search endpoint. Team membership references local membership UUIDs, never arbitrary user IDs.

## HTTP and UI

The workspace governance snapshot, member role/removal, team create/rename/delete/enrollment, and grants live below `/workspaces/:workspaceId/governance`. The snapshot is admin-only and includes the caller's incarnation, active member profiles, teams, resource target labels, and grants. A separate authenticated self-leave command permits ordinary members to leave.

Invitations use common migration `0005_governance_invitations.sql`. Tokens contain a canonical lowercase workspace UUID locator and 32 random bytes. Only hashes are stored. Redemption checks expiry with `clock_timestamp()` in a separate statement after acquiring the authorization and invitation row locks. Email-bound links are manually shared and labeled as such; this partition does not claim provider delivery. The API never accepts a client-asserted email verification flag. Existing members keep their role. Email consumption cannot readmit a removed user; share links can create a fresh member incarnation. Neither invitation assigns teams.

`GET /workspaces/:workspaceId/governance/invitations?after=<uuid>` returns `{ items, nextCursor }`, replacing the original array response. Pages contain at most 100 invitations ordered by `created_at DESC, id DESC`. The cursor identifies the last returned invitation within the authorized workspace. Lists include active, revoked, expired, and consumed links but never tokens. The UI offers **Load older invitations** and refreshes all previously loaded pages after mutations. New reads and mutations cancel older reads. Confirmed revocations remain visible even when the following refresh fails.

Initial UI reads show loading, successful zero teams show a create-team action, success renders the snapshot, and failed reads offer retry. Refresh errors preserve the snapshot and form input. Aborting a refresh for a mutation resets its pending state even if the mutation fails. Access loss clears protected content. Mutations disable duplicate submission and retain input on failure. An uncertain team creation freezes its original UUID and name. A retry sends that exact command. A successful snapshot containing the original UUID, a confirmed save, or a retired-ID response resolves the uncertainty before another command can be entered. An absent snapshot row alone does not release the original command. Invitation links are returned once and are absent from lists. An uncertain invitation response requires checking the list and revoking the unknown link before creating another.

## Integration requirements

The governance migration directory now supplies `0005_governance_invitations.sql` and `0009_governance_retired_teams.sql`. Merge and sort these with the other owners' streams through the existing loader. Migration 0009 sorts after the already assigned agent 0007 and operations 0008 slots, so this fix does not insert history ahead of them. Compatibility is injected into the governance service, with the integrated stream's receipt count supplied by the composition owner. Resource-service compatibility must also include the resulting receipt count.

Migration 0009 adds append-only `tf_retired_teams`, backfills IDs from `team.delete` audit events, changes invitation creation and expiry defaults to wall-clock time, and indexes invitation pagination. Team deletion records the retired UUID in the same transaction as grant and enrollment cleanup. Creation rejects a retired UUID with 409 `team-id-retired`, including retries with the original name. Runtime has SELECT and INSERT on the tombstones, without UPDATE or DELETE. Existing agent-team foreign keys still govern whether deletion can commit. Team creation and deletion return 503 `teams-unavailable` until the migration receipt exists. Invite operations check their 0005 receipt. Applied SQL files remain unchanged.

HTTP parser failures retain client-error statuses with bounded response codes: malformed JSON returns 400 `invalid-request`, an oversized body returns 413 `request-too-large`, and an unsupported content type returns 415 `unsupported-media-type`. OpenAPI declares all three responses.

The web router replaces the members and invitation placeholders and adds teams/grants routes. The resource web owner's routes remain independent additions. The members page creates and revokes invitation links. The standalone join page accepts a fragment token without putting it into auth redirects or email workflow history. Signed-out recipients sign in and reopen their link. Automatic invitation continuation through sign-in remains outside this partition.

## Verification progress

The restricted-role HTTP suite passed against foundation and access on 27 September 2026. It uses real Better Auth sessions, a restricted platform identity login, and two restricted workspace logins. `pnpm check` passed. The optional `RESOURCE_SERVICE_ROOT` composition also passed with the resource owner's actual HTTP handlers. A record-only member created and updated literal record values, failed schema save and ungranted reads, and gained read access after an explicit grant. A schema manager persisted a preparing schema command and failed record creation. The fixture creates the initial physical table through the migration login. It does not claim a full Soul migration execution journey.

The browser script passed initial read failure and retry, successful empty state, refresh failure with retained input, duplicate-write suppression, explicit grant toggles, mobile dark mode, keyboard access, protected-content removal after access loss, and invitation creation, revocation, and joining. Browser responses are controlled fixtures. HTTP authority is verified separately against PostgreSQL.

The eight review findings have regression coverage in [`apps/api/test/governance.integration.mjs`](../../apps/api/test/governance.integration.mjs) and [`apps/web/test/governance.browser.mjs`](../../apps/web/test/governance.browser.mjs). The HTTP suite listens on an ephemeral loopback port and uses real Better Auth sessions and disposable restricted PostgreSQL logins. It proves expiration after both lock waits, uppercase workspace token redemption, paging and revoking an older live link, rejected retired-team replay, and parser status codes. The upgrade proof checks unchanged prior checksums, retirement backfill, replayed rollout, and denied tombstone modification. Browser regressions cover aborted refresh recovery, immutable uncertain creation and original-ID reconciliation, late invitation response cancellation, older-page retry, and confirmed revocation after refresh failure. These browser responses are controlled fixtures, not a browser-to-database claim.

The final local HTTP run on 27 September 2026 used the resource-service sibling at `39ae2c9`, including its confirmation-history migration. Its shared access source matched this partition. That checkout had an untracked `packages/access/AGENT-INTEGRATION-REQUEST.md`; no sibling files were edited. The final browser script and `pnpm check` passed. The full check completed 25 tasks with 13 cache hits. Vite reported its existing large-chunk advisory. Production composition, full Soul migration execution, and agent-team deletion coordination remain outside this verification.

Reproducible commands from the worktree root:

```sh
pnpm --filter @tulipfarm/workspaces build
TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres pnpm --filter @tulipfarm/api test:governance
TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres RESOURCE_SERVICE_ROOT=/absolute/path/to/tulipfarm-cloud-storage-resource-service pnpm --filter @tulipfarm/api test:governance
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node apps/web/test/governance.browser.mjs
pnpm check
```

`RESOURCE_SERVICE_ROOT` must be absolute because pnpm runs the script from `apps/api`. Use the absolute sibling checkout path for that command. The resource checkout must have its dependencies built. Its files remain read-only to this partition.

Agent enrollment administration is not implemented by this human membership partition. Existing agent-team foreign keys must continue to block team deletion until the agent owner supplies its coordinated removal path.

## Throughput and review

The blocking work was reading the shared access and restricted runtime contracts. One owner implemented domain, HTTP, and UI files because recursive delegation was prohibited. The shared exclusive authorization row serializes policy writes and final-admin decisions. Independent HTTP, browser, and repository checks ran in parallel after implementation. Comment and source review ran locally without a subagent. No suppressions or explanatory code comments were introduced.

Model the Domain selected the resource/collection grant union. Type System Discipline kept browser schemas separate and parsed database rows at the boundary. Prove It Works required real restricted-role HTTP operations and browser transitions before the local commit.
