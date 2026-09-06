# Soul Doctor

`@tulipfarm/soul-doctor` finds the Soul defects nothing else reports — a Routine that cannot
compile, a bundle the Runtime never published, a Run parked forever — and decides whether one may
be repaired automatically or must go to a person. Pure logic: no database, no model, no git.

## Read on / Skip

- **Read on if** you touch defect detection, the repair gate, sweep orchestration, or the Task
  dedupe keys the Doctor owns.
- **Skip if** you are wiring it to a deployment (`apps/api/src/soul-doctor/`), changing the ledger
  tables (`packages/storage/src/soul-doctor/`), or editing the repair prompt
  (`packages/built-in-agents/src/agents/soul-repair/`).

## Map

| Path | Owns |
| --- | --- |
| `src/finding.ts` | `Finding`, its `code`/`severity`, and the fingerprint every other module keys on. |
| `src/routine-lint.ts` | Everything provable from one Routine: `lintRoutine` (compiled) and `lintRoutineDocument` (authored bytes, schema included). `LINT_CEILING` is the widest ceiling the compiler accepts, on purpose. |
| `src/diagnose.ts` | Bundle-level defects: staleness against the repo HEAD, plus a lint of every published Routine. |
| `src/run-findings.ts` | Turns a stuck Run into a finding about the *Routine* it pins, never about the Run. |
| `src/gate.ts` | `gateRepair` — the sole decision to publish or escalate. |
| `src/sweep.ts` | `sweepSoul`, the orchestration, against ports the caller supplies. |
| `src/dedupe.ts` | The reserved `doctor:` Task dedupe namespace. |

## Rules

- **The lint is what is trusted, never the model.** A repair is re-linted from its proposed bytes
  before the gate sees it; a guessed field name lints exactly as clean as the right one, which is
  why `RepairSubject.facts` states what each State actually publishes.
- `gateRepair` refuses to publish anything that is not lint-green, is not `broken`, touches a path
  other than the subject's, exceeds `MAX_REPAIR_ATTEMPTS`, or newly introduces a `SENSITIVE_FIELDS`
  key. Widening it needs a matching test, not a new branch.
- Findings fingerprint on `{code, subject, digest, at}` so a republish retires the old one; Tasks
  dedupe on the subject alone so a republish does not open a second Task. Keep that asymmetry.
- `doctor:` dedupe keys are refused from Agent-facing Tools (`apps/api/src/tasks/tools.ts`), so a
  Tool call cannot forge or resurrect the Doctor's own escalations.
- Simulation is not the lint. `simulateRoutine` conflates a missing fixture with an unresolvable
  mapping and stubs holes with `{}`, so it reports defects that are not there.
