# Build the L2 runner

Type: task
Status: open
Blocked by: 02, 03, 06

## Question

Build the thing. Given a corpus of L2 cases, a pinned model, and the fixture Soul, execute every
case and emit a structured report.

This is the spine of the whole framework and it is the cheapest part to build: `AgentLoop`
(`packages/agent-runtime/src/loop/loop.ts`) already runs in-process with injected ports, and
`packages/agent-runtime/test/security/harness.ts` (`loopHarness`) is roughly 90% of the scaffold —
real `AgentLoop`, scripted tool dispatch, in-memory checkpoints, captured events. The work is
swapping `FakeModelAdapter` for a real pinned model, feeding cases in, and collecting results out.

Deliver:

- A runner that takes a corpus + a model pin + the fixture Soul and returns a report.
- Case selection: run everything, one tier, one capability area, or a single case by id — the
  local CLI is useless without it.
- Concurrency, with a cap. Cases are independent and mostly latency, so serial execution wastes
  wall-clock; but vendor rate limits are real and a 429 storm looks like a quality regression.
  Decide the cap and make it configurable.
- **Loud failure.** A case that errors, times out, or whose model call falls back to a different
  model must be recorded as an *error*, distinct from a case that ran and scored zero. Conflating
  the two silently corrupts every comparison built on this report.
- Retries: decide whether a transient 429 is retried and whether a retried case is flagged in the
  report. Retrying hides rate-limit pain but a retried case is not quite the same measurement.
- Per-case capture: assertion outcomes, judge verdicts where present, token usage, `costUsd`,
  wall-clock, loop iteration count, and the model actually used.
- The report is the input to both [Baseline storage and delta comparison](10-baseline-storage.md)
  and [Cost accounting and the $5 ceiling](11-cost-accounting.md), so its shape has to serve them.
- Tests for the runner itself — using `FakeModelAdapter`, so they cost nothing and can live in the
  normal suite. The runner is code like any other and gets no exemption.

Do **not** wire the CI workflow here; that is fog on the map until the scorecard shape exists.
Prove it works from the local CLI first.
