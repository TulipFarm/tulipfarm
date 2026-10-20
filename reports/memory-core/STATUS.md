# Memory-core Phase 1 status

**Stopped again at M0: a different test-environment failure.**
No extraction milestone is complete.

At source commit `fc6bc0ba4f76226fff1e62c6b155eaabaf8d4559`, before any
runtime or test changes, `packages/knowledge/test/defaults-gate.integration.mjs`
failed its assertion at line 191. The old-storage test expected
`{intentId: '', created: false}` but received a nonempty intent ID with
`created: true`. The complete evidence is in
`M0-packages-knowledge-test-defaults-gate.integration.mjs.tap`.

The user accepted that original failure as a known squashed-baseline failure
and authorized resuming M0. It must remain identical at later milestones.
No test was edited, fixed, weakened, or marked skipped.

On resume, `defaults.integration.mjs` passed all 13 tests. Then
`packages/knowledge/test/embedding-capacity.integration.mjs:37` failed:
`Disposable cluster must not contain a pre-existing identity role`.
Expected role-query row count: `0`. Actual: `1`. Code: `ERR_ASSERTION`.
The complete evidence is in
`M0-packages-knowledge-test-embedding-capacity.integration.mjs.tap`.

The Compose setup creates that role in `infra/postgres/init.sql:1`.
This is a disposable-cluster precondition failure, not the squashed-baseline
cause, so it was not added to the accepted-failure list. The user permits
continuing only for failures with that cause. Execution stopped without
changing or rerunning the test.

All four unit suites and both requested benchmarks ran. Remaining integration
suites and the golden ranking snapshot are incomplete. See [M0](M0.md) for
commands, counts, benchmark numbers, scope, and the existing API skip.

The original and resumed `memory-core-phase1` Docker containers, volumes, and
network were removed. No runtime code, schema, permissions, or dependencies
changed. M1 and later milestones were not started. No GitHub or other remote
operation was performed.
