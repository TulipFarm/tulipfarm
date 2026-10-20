# Memory-core Phase 1 status

**M0 complete. M1 is next.**
No runtime code, existing tests, schemas, or permissions changed.

The latest user decision accepts every failure reproduced on the unmodified
`origin/staging` baseline (`fc6bc0b`), regardless of cause. This includes all
four approval failures. Every later milestone must reproduce the same known
failures. A new failure, changed failure, or unexpected pass is a stop.
The brief's other stop conditions and M4/M5 review gates remain in force.

All 222 integration entry points completed serially on the approved Compose
environment: 1,239 tests, 1,131 passes, 102 known pre-existing failures,
no cancellations, and six existing skips. Every resumed file ran while the
original tracked app/package files still matched `fc6bc0b`.

| Suite         | Files | Tests | Pass | Known failures | Existing skips |
| ------------- | ----: | ----: | ---: | -------------: | -------------: |
| knowledge     |    28 |   257 |  254 |              3 |              0 |
| conversations |    40 |   163 |  148 |             14 |              1 |
| api           |    80 |   328 |  291 |             37 |              0 |
| worker        |    74 |   491 |  438 |             48 |              5 |

Both benchmarks passed. Fusion and real-search golden snapshots were
captured and replayed unchanged. The four serial unit suites passed:
Knowledge 237, Conversations 118, API 177 plus one original skip, worker 63.
Repository lint and scoped typecheck passed.

See [M0](M0.md) for exact failure signatures, benchmark measurements,
environment settings, and receipts. `M0-signatures.json` freezes every
integration file's counts and errors for later comparison.

The owned `memory-core-phase1` Compose project stays available for M1.
The bare cluster is not used. Clean up only owned services at the next stop.
M1 and later milestones have not started. No GitHub or other remote action
was performed. The M0 completion commit is new; no prior commit is amended.
