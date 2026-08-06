# Evals — Agent Conventions

`@tulipfarm/evals` — the AI evals harness: versioned datasets, code + LLM-judge scorers, a multi-run
runner with a pass-rate threshold, and a reducer to the agent-runtime activation gate. tsconfig
extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/agent-runtime`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This package
is a **pure core**: it defines provider-neutral ports and never imports `@tulipfarm/llm`. Real
models and the LLM-judge are wired in the app layer (`apps/api/src/evals/`).

## Core decisions (binding)

- **Every eval TARGET is a real model / real agent loop.** There is no "fake agent" quality mode.
  Scripted fakes appear ONLY in this package's unit tests, to calibrate the scorers and the gate
  (prove the measuring instrument works). Those are ordinary CI unit tests, not agent evals.
- **Two kinds of scorer, chosen per suite:** code scorers (`mustRefuse`, `toolCalled`, `jsonValid`,
  `recallAtK`, `maxCostUsd`, …) for objective facts, and an opt-in `llmJudge` for open-ended quality
  (faithfulness/correctness/helpfulness). The judge reuses the existing provider key on the
  `complex` tier — no new secret.
- **Nondeterminism is handled by sampling.** Each case runs `runs` times (default 3) and passes when
  the pass rate meets `minPassRate` (default 2/3). Per-case overrides live on the case.
- **Live evals are on-demand only, never a PR gate** (cost, flakiness, fork-PR secrets). Run them
  locally with `EVAL_LIVE=1 … pnpm evals`, or from the GitHub Actions UI via the manual
  (`workflow_dispatch`) `.github/workflows/evals-live.yml` — there is no cron schedule.

## Layout

| Path | What |
| --- | --- |
| `src/types.ts` | `EvalCase`, `TargetOutput`, `Scorer`, `EvalRunReport`, ports. |
| `src/runner.ts` | `runEvals` — multi-run execution + pass-rate threshold + latency capture. |
| `src/scorers/` | Code scorers (`code.ts`) and the `JudgeModelPort` + `llmJudge` (`judge.ts`). |
| `src/targets.ts` | `EvalTarget` port, `modelTarget` (single invoke), `agentLoopTarget` (drives `AgentLoop`). |
| `src/dataset.ts` | `DatasetSource` + `fileDatasetSource` (YAML). |
| `src/sink.ts` | `EvalReportSink` + `fileSink` (JSON + Markdown) / `inMemorySink`. |
| `src/report.ts` | `toEvalReport` reducer to the agent-runtime `EvalReport` + stable `reportDigest`. |
| `datasets/*.yaml` | Versioned suites: `quality`, `safety`, `tool-use`. |

## Adding a case

Author it in the suite YAML with a **new** `caseId`/`version` (never silently edit an expectation —
bump `version`, mirroring the agent-runtime `EvalCase` contract). Pick the target the case is for
(`model` vs `agent-loop`) and give the live runner (`apps/api/src/evals/run-evals.ts`) the scorers
the suite needs. Keep judged cases' rubrics explicit and binary (PASS if … / FAIL if …).

## Phase 2 roadmap (documented, not built here)

- **Persistence:** `EVAL_STORAGE_STATEMENTS` + `PgEvalRunStore` in `packages/storage/src/evals/`,
  registered in `apps/api/src/pg-migrations/index.ts` (mirror `SOUL_PUBLICATION_STORAGE_STATEMENTS`);
  swap `fileSink` → `pgSink`.
- **API:** `apps/api/src/evals/routes.ts` (`GET /api/v1/evals/suites|runs|runs/:id`) mirroring
  `apps/api/src/observability/routes.ts`, admin-only, with OpenAPI schemas, wired in `app.ts`.
- **UI:** a `Settings → Evals` route in `apps/web` plus a status badge on the agent governance card.
- **Gate:** feed the persisted `EvalReport` into `evaluateActivation` in the agent
  publication/changeset flow so a regression blocks activation automatically.
