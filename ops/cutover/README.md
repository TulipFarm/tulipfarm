# Governed cutover

`CutoverCoordinator` is the fail-closed authority for Phase 14 activation. Deployment composition
supplies ports for verified backup evidence, pure legacy conversion, Soul proposal and Approval,
routing preview/activation/rollback, acceptance smoke, and durable audit.

The coordinator cannot write the Soul repository or reset a database. Converted files are sent to
the proposal port with source `migration`, then explicitly approved. Any conversion warning blocks
activation.

## Required routing proof

Chat, manual Trigger, webhook, schedule, channel, and Integration traffic must each create a Run.
Every external mutation must use the Tool Broker and create effect evidence. API, worker, and
integration-worker component digests are pinned in the plan.

## Activation sequence

1. Validate every route.
2. Verify a complete backup.
3. Convert legacy definitions into a governed Soul proposal.
4. Approve the proposal.
5. Preview routing.
6. Verify rollback before activation.
7. Activate the pinned component plan.
8. Smoke every traffic surface, effect evidence, and denied access.
9. Roll back routing on any smoke failure; never reset PostgreSQL.
10. Append safe cutover audit evidence.

The operator retains the plan, backup ID, proposal ID, component digests, smoke output, and audit
correlation with the release evidence.
