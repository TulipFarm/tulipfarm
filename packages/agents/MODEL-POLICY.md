# Persisted model policy

Implemented and locally verified on 28 September 2026. This is the persistence
and authenticated API slice of [the continuity plan](../../docs/model-continuity-plan.md).
It does not dispatch models, resolve families, or configure provider routes.

## Injection contract

`@tulipfarm/agents/model-policy` exports `createModelPolicyService` and the
`ModelFamilyEligibility` type. The contracts entry point exports the same type
and the family, command, rule, and receipt schemas.

```ts
type ModelFamilyEligibility = (input: {
  workspaceId: string;
  modelFamilyId: string;
  fallbackFor?: string;
}) => boolean | Promise<boolean>;
```

The callback accepts synchronous or asynchronous results. Trusted composition must
read the authoritative registry per request for configured, qualified routes and
workspace restrictions. A target
check includes `fallbackFor` so composition can reject incompatible pairs.
A pricing catalog entry does not establish eligibility. No callback means no
eligible new family. Both authoring and policy await eligibility inside the existing
workspace authorization transaction. The callback performs no provider requests.
Registry failures reject the operation without recording a command.

The callback is the second argument of `createAgentAuthoring(runtime, eligible)`
and `createModelPolicyService(runtime, eligible)`. API composition passes it as
`buildApp({ modelFamilyEligibility })`, through `registerStorageComposition`'s
sixth argument and `registerAgents`' dependency of the same name.

Authoring permits retention of the exact family in the authorized current saved
definition, even when that family is unavailable. It follows the agent's current
saved revision to its immutable definition after checking expected revisions.
An arbitrary historical preference does not qualify. New agents and changed family
selections require eligibility. Clearing a preference needs no route.
Authoring validates new saves before recording a command. Duplicate commands
return their durable status even if eligibility later changes. The worker
accepts the previously validated save through its existing authoring path.
Run admission and activation-time route enforcement belong to execution work.

## Persistence and HTTP

`agentDefinitionSchema` and the Soul definition schema accept optional
`modelFamilyId`. Missing fields remain absent. No default is inserted and no old
definition, hash, projection, or activation is rewritten.

`0018_model_policy.sql` creates `tf_model_fallback_rules` and
`tf_model_policy_commands`. Each source has one nullable target and an optimistic
integer revision. A missing row reads as no fallback at revision zero. Removal
sets the target to null and retains the revision to reject stale recreation.

Current members can read rules. Only current admins can save or reconcile their
own command receipts. Saves take the workspace authorization write lock and
atomically persist the rule, receipt, and audit event. Receipts are immutable
under runtime grants and keyed by membership incarnation plus request UUID.
Replays return the original receipt without mutating the current rule.

The API exposes these authenticated routes:

- `GET /v1/workspaces/:workspaceId/model-policy/rules/:sourceFamilyId`.
- `PUT /v1/workspaces/:workspaceId/model-policy` accepts `requestId`,
  `sourceFamilyId`, nullable `targetFamilyId`, and `expectedRevision`.
- `GET /v1/workspaces/:workspaceId/model-policy/commands/:requestId`.

The service exports `read(workspaceId, userId, sourceFamilyId)`,
`save(workspaceId, userId, input)`, and `commandStatus(workspaceId, userId, requestId)`.
Rules never follow the target's rule. Removal remains possible after routes
become unavailable. These APIs expose neither provider credentials nor chat data.

## Verification and integration boundary

The fresh replacement starts at main `9f83628`, after PR83 merged conversation
controls. It reuses the six policy commits through `a502e20` from PR77.
The final reviewed base is `e6a3ca0`, which also includes the private conversation
UI from PR87. The unpublished replacement branch was rebased without a force-push.
The common stream has fifteen receipts, with conversation `0016` and `0017`
before policy `0018`. Existing SQL files and policy SQL bytes are unchanged.
Execution admission, discovery, and existing service ceilings admit fifteen.
Governance retains its minimum of twelve. Policy requires fifteen receipts and
its named migration receipt.

Run the focused PostgreSQL proof after `pnpm build`, with
`TEST_ADMIN_DATABASE_URL` set to a disposable local server:

```sh
pnpm --filter @tulipfarm/api test:model-policy
pnpm --filter @tulipfarm/conversations test:integration
node --test apps/api/test/conversations.integration.mjs apps/api/test/conversation-dispatch.integration.mjs
node --test apps/web/test/agent-editor.browser.mjs
```

The proof uses real Better Auth sessions and workspace PostgreSQL logins. It
covers upgrade replay, grants, authorization, duplicate and concurrent saves,
conflicts, removal, receipt recovery, and saved-definition history. Its projection
writer is an in-memory test substitute. The separate Soul test in
`packages/workspaces/test/soul-revisions.test.mjs` proves actual Git bundles and
immutable bytes through the existing local HTTP object-store fixture.

The three policy PostgreSQL tests provision legacy twelve-receipt, historical
conversation thirteen-receipt, and current fourteen-receipt streams. Each creates
a saved agent, activation, and pending chat before upgrade. Both conversation
cases also create a private message. They apply the fifteen-receipt stream twice,
compare every prior receipt and checksum, retain immutable
definitions and activations, replay private sends, accept a new send, and complete
the pending saved-agent chat against its pinned definition. The model and projection
writer are test substitutes. The three policy tests and all eight conversation
PostgreSQL tests passed on local PostgreSQL 18.6 on 28 September 2026.
Full R2-backed agent integration is outside this proof and requires separately
configured Soul credentials. This unit does not read those credentials.

The conversation tests cover fresh and upgraded fifteen-receipt workspaces,
pending-resource upgrade refusal, controls upgrade, executor fencing, and replay.
PR79 activated conversations in the shared loader. PR83 added `0017` before this
unit. The earlier migration-order blocker is resolved, not waived.

Ordinary editor saves retain the loaded optional family. The controlled Chromium
regression in `apps/web/test/agent-editor.browser.mjs` covers saves and uncertain
retries with and without a preference. Default API composition rejects new family
selections until root supplies `modelFamilyEligibility`. No deployment or
complete model-continuity journey is claimed.

The follow-up PostgreSQL regression reproduces instructions-only edits failing with
`400 model-family-unavailable` before the retention fix. It now covers unavailable
current-family instructions and tools edits, rejection of a different unavailable
family and historical restoration, stale revisions, async eligibility success and
denial, async registry failures, and default-deny new selections. All three
upgrade cases run these checks.

The final integrated tree passes all 49 `pnpm check` tasks, both authenticated
conversation API and dispatch tests, and the Chromium editor test. Independent
Claude Opus 5.5 review returned PASS+NOTES at `a1dfa7e` against `e6a3ca0`.
The reviewer reran all three policy, eight conversation, two API, one browser,
16 contract and Soul, and 68 release-tool tests. No code blocker remained.
