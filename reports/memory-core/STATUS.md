# Memory-core Phase 1 status

**Stopped at M0: existing test failure.** No extraction milestone is complete.

At source commit `fc6bc0ba4f76226fff1e62c6b155eaabaf8d4559`, before any
runtime or test changes, `packages/knowledge/test/defaults-gate.integration.mjs`
failed its assertion at line 191. The old-storage test expected
`{intentId: '', created: false}` but received a nonempty intent ID with
`created: true`. The complete evidence is in
`M0-packages-knowledge-test-defaults-gate.integration.mjs.tap`.

The brief explicitly requires stopping on a pre-existing M0 test failure and
not fixing unrelated failures. No fix or rerun was attempted. M1 and later
milestones were not started.

All four unit suites and both requested benchmarks ran. Remaining integration
suites and the golden ranking snapshot are incomplete. See [M0](M0.md) for
commands, counts, benchmark numbers, scope, and the existing API skip.

The temporary `memory-core-phase1` Docker containers, volumes, and network
were removed. No runtime code, schema, permissions, or dependencies changed.
No GitHub or other remote operation was performed.
