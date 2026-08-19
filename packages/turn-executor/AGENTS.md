# @tulipfarm/turn-executor

How one Chat Turn executes: the Agent State runner, the Turn driver, guardrail composition, Run
event writing, and the Chat Run executor itself.

Extracted from `apps/worker` so a second host — the offline eval harness in `apps/eval` — can drive
a real Turn without importing an app. An app may not import another app.

## Read on / Skip

**Read on** if your task touches: Chat Turn execution, the Agent State machine, Turn guardrails,
Run event emission, Tool-call announcement or preview, or the ports a Turn host must satisfy.

**Skip** if you are changing the bounded Tool loop or Context assembly — those are
`packages/agent-runtime`. Skip for Routine dispatch, leases and reconciliation — those stay in
`apps/worker`.

## Map

| Path | Owns |
| --- | --- |
| `src/ports.ts` | What the executor requires of its host: `RunExecutor`, `RunOutcome`, `SpendSink`, `ModelCallReceiptSource`, spend records. |
| `src/chat-executor.ts` | `createChatExecutor` — the Chat Run executor. Resolves Turn facts from the Run and rebuilds per-Run state. |
| `src/driver.ts` | `TurnDriver` — one Turn attempt, from Context through model to completion. |
| `src/agent-state.ts` | `AgentStateRunner`, approval waits, State transitions. |
| `src/conversation-turn.ts` | `ConversationTurnCompleter` — durable Turn completion. |
| `src/guardrails.ts` | `TurnGuardrails` — guard composition; a guard that throws or times out is skipped, never allowed to stall. |
| `src/run-events.ts` | `TurnEventWriter` and the Run event append port. |
| `src/tool-events.ts`, `src/tool-preview.ts` | Announcing Tool calls to participants. |
| `src/kernel-ports.ts` | Reclaiming pending and waiting States. |

## Rules

- **This package declares ports; it never imports an implementation.** The Worker's `PgSpendSink`,
  `LlmModelPort` and Run dispatcher satisfy `src/ports.ts` from outside. Adding a dependency on a
  concrete store or provider here would re-couple it to the Worker and defeat the extraction.
- **`ports.ts` is the single home for those contracts.** `apps/worker` re-exports them from their
  historical modules (`executors.ts`, `run-dispatcher.ts`, `observability.ts`, `model.ts`) so its
  own imports still read naturally — do not redeclare them there.
- **`model` is injected as `ModelPort | ((input) => ModelPort)`.** The factory form is what lets a
  host bind a different model per Turn; the eval harness relies on it.
- **The input guard sees an attachment's name, never its contents.** Files reach the model
  natively — an image as an image, a PDF as a document — so there is no extracted text to screen,
  and the bytes are opaque to every guard we run. A filename is screened because it reaches the
  model verbatim, and it is block-only: redacting a name would change which File the part refers
  to. Treat instructions hidden inside a document as a model-resistance problem, not a guard one;
  `apps/eval/corpus/red-team` asserts that ending. Extraction for Knowledge is a separate path and
  screening belongs there when it lands.
