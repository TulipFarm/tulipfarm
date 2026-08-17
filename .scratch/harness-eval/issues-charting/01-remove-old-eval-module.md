# Remove the unused Agent-publication eval module

Type: task
Status: open
Blocked by: —

## Question

Nothing to decide — this is manual work that clears the ground so the harness eval can own the
word "eval" in this repo without ambiguity.

`packages/agent-runtime/src/evals/` (`index.ts`, `suite.ts`, `suite.test.ts`, ~172 lines plus 254
lines of test) implements `runEvalSuite` and `evaluateActivation`: a versioned suite runner and a
gate that blocks *publishing a user-authored Agent* when it regresses, with expiring admin
exceptions. It has **zero call sites outside its own test file**.

Settled at charting: it goes. It is a different product surface — "operator evaluates their own
Agent before publishing" — from this effort's "maintainer evaluates the harness before release".

Do:

- Delete `packages/agent-runtime/src/evals/`.
- Remove its re-exports from `packages/agent-runtime/src/index.ts`.
- Remove the `src/evals/` row from `packages/agent-runtime/AGENTS.md`, and the phrase "runtime
  eval activation" from its Read-on list.
- Check whether `EvalSeverity`, `EvalException` or any sibling type leaked into
  `packages/schema` or into Run event types, and remove those too if they are equally orphaned.
- Verify with `pnpm typecheck` — a surviving consumer is a compile error, not a test failure.
  Then `pnpm --filter @tulipfarm/agent-runtime test`.

The answer records what was deleted and confirms nothing else referenced it.
