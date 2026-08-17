# 04 — Eval vocabulary into the glossary

**What to build:** Put the eval nouns into the project glossary so every later ticket, and every
future reader, uses one set of names.

**Blocked by:** 03 — the names should be the ones the skeleton actually uses.

**Status:** done

- [x] Sweep, Trial, Eval Case, Corpus, Scorecard, Baseline, Noise Floor, Judge, Expectation and
      Eval Soul are defined in the glossary — `metadata/terminologies.md` → *Offline eval*
- [x] "Eval Run" is recorded as **banned**, with the reason: `Run` already names one execution of a
      Routine, it is load-bearing across the run kernel, and an L3 Trial *contains* real Runs — so
      the collision would land exactly where the code is hardest to reason about
- [x] "test case" is recorded as banned for Eval Case; it belongs to Vitest
- [x] The framework's code, CLI output and docs use the canonical names

## Deviation — Assertion → Expectation

This ticket asked for an **Assertion** row. The glossary already defines **Assertion** as one
durable Memory statement (`MemoryAssertion`, with its own REST path), and the glossary's first
rule is that one term names exactly one concept. Two Assertions could not both stand.

The eval check is now **Expectation** (`Expectation`, `expect: Expectation[]`), agreed with the
user. The JSON field was already `expect`, so the rename reads better than what it replaced.
23 usages across `apps/eval`; renamed with the tests green either side.

`unasserted` became `vacuous` in the same pass, and is now a glossary row of its own — a Trial that
passed while expecting nothing is the framework's worst failure mode and deserves a name.

Also banned: "dataset"/"eval set" → Corpus, "grader"/"rubric model" → Judge.

## Note for later tickets

`.scratch/harness-eval/spec.md` and tickets 05-16 still say "assertion" and "eval run" — they
predate this decision and are untracked working notes. Read the glossary, not them, when the two
disagree.
