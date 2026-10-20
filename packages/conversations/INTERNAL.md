# Internal conversation runtime

Runtime contract inspected on 28 September 2026. Normal-stream integration updated
on 29 September 2026. This service does not route private replies to a model.

## Runtime contract

`createInternalConversations` in `src/internal.ts` accepts a live existing agent
run. An autonomous origin requires scheduled authority. A linked origin requires
the delegated membership to own the private chat and an unexpired processing turn
with the supplied generation and epoch. One run has one immutable internal origin.

The internal conversation ID equals its existing run ID. Ordered messages contain
bounded text or same-run tool-call references. Inputs, results, errors, and tool
status stay in `tf_agent_tool_calls`. Internal messages do not grant action authority.
The separate internal relations cannot enter private-chat list or history queries.

Claims last 60 seconds. Renewal requires the current unexpired owner and epoch.
An expired claim increments its epoch, even when the owner ID is reused. Append,
history, renewal, and publication recheck live run authority and both relevant
fences before returning a duplicate receipt. Producer IDs deduplicate exact input.

`createInternalAgentComposition` in `apps/worker/src/internal-agent-composition.ts`
executes already-persisted calls through `createAgentExecutor`. Its transaction
hook appends the tool reference after resource work and before commit. It acquires
the private root, internal root, and claim in that order. Resource locks therefore
precede conversation locks. Cancellation or takeover before this check rolls back
the database work and its result. The ordinary executor rejects internal runs
without this hook. The composition has no integration provider and does not claim
external-effect fencing or exactly-once network execution.

`publishTool` permits only linked work and derives one fixed status sentence from
the authoritative call. It publishes no caller text, tool input, raw result, resource
name, or source-backed data. A separate immutable publication row retains the call
identity. These status messages do not complete the private turn, grant approval,
or imply that a pending action completed. Explicit information requests and
resource approvals use their separate authoritative services and ordered references.

The existing human tool-result reader and legacy chat reader deny bound internal
runs, including workspace admins. Human call submission and legacy execution also
deny those runs. Unbound legacy runs retain their existing behavior. First binding
uses the authorization write lock so a concurrent human read cannot pass its
privacy check and then read newly internal data.

## Activation boundary

The normal `workspaceResourceMigrations` composer includes model execution 0019,
attachments 0020, internal conversations 0021, team details 0023, information
requests 0024, approvals 0025, and model allowance 0026. Its twenty-two receipts preserve the shipped
twenty-one-receipt prefix. Internal and other workspace readers admit twenty-two.
Readiness and release checksum checks use that same stream.

The pending-resource-work drain-or-refuse gate remains in force. Runtime registration
and migration inclusion do not establish deployment or browser acceptance. The
[request contract](../../docs/conversation-requests.md) and
[approval contract](../../docs/conversation-approvals.md) describe the newer runtime
entry points, protected authority, and upgrade proofs.

## Verification

The restricted PostgreSQL tests exercise the service and actual worker composition.
They cover claim takeover across runtime restart, stale new producer keys, replay
conflicts, same-run tool references, immutable grants, linked epoch changes, removed
and rejoined memberships, and a cancellation race during real tool execution.
The HTTP test uses real Better Auth sessions and actual conversation and legacy
agent handlers. It checks owner and admin denial and a readable legacy control.

Run the focused checks with a disposable local `TEST_ADMIN_DATABASE_URL`:

```sh
pnpm build
node --test packages/conversations/test/integration/*.test.mjs apps/api/test/conversations.integration.mjs apps/api/test/internal-conversations.integration.mjs apps/api/test/attachments.integration.mjs
pnpm check
```

After rebase onto model policy PR 89, the focused run passed fourteen tests.
The post-rebase `pnpm check` passed all 49 tasks and 68 deployment tests.
The first pre-rebase attempt hit the command timeout and its longer rerun passed.
Independent parent review remains required. Nested review tools were unavailable
to this implementation agent. No independent-review verdict is claimed.

## Historical attachment integration, 28 September 2026

The merge of attachment PR 88 at `b46d1ba` retains both package exports and the
internal readers' eighteen-receipt ceiling. The default composer still has fifteen
receipts. Attachment-only and internal-only compositions each have sixteen.
Their combined opt-in composition has seventeen. The attachment reader's existing
seventeen-receipt ceiling accepts that stream. Eighteen receipts require pending
0019 and remain an activation task, including the attachment reader update.

The focused command above passed 21 tests against disposable local PostgreSQL.
The combined regression checks upgrade and fresh-provisioning receipts, attachment
bytes, ordered human history, internal tool execution, fixed status publication,
and owner/admin concealment. Both HTTP suites run with and without the other
opt-in migration installed. Build and typecheck passed. `pnpm check` passed all
49 tasks and 68 deployment tests after a 240-second command timeout on its first
attempt. No migration SQL, default composer, or deployment activation changed.
The combined tree still requires the parent's independent recheck before merge.

Main advanced to `b42cfc6` during verification. A second normal merge retains its
invitation-key fix. The next focused run exposed an existing executor-test race:
either concurrent completion may win. Its assertion now checks exactly one
`completed` and one `stale` result without assuming call order. Production executor
behavior is unchanged.
