import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ModelInvocationResult, ModelStreamChunk } from "@tulipfarm/agent-runtime";
import {
  contentText,
  type GuardrailDefinition,
  type routine,
  type ToolContractDefinition,
  textContent,
} from "@tulipfarm/schema";
import { TurnGuardrails } from "@tulipfarm/turn-executor";
import { describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../case.ts";
import { loadCorpus, RED_TEAM_DIR } from "../corpus.ts";
import { type EvalSoul, loadEvalSoul } from "../eval-soul.ts";
import type { ModelBinding } from "../runner.ts";
import { scoreCase } from "../scorer.ts";
import { scriptedBinding } from "../scripted.ts";
import { NO_SPEND } from "../spend.ts";
import { openEvalDatabase } from "./database.ts";
import { FILE_CREATE_TOOL } from "./file-store.ts";
import { SOUL_WRITE_TOOL } from "./soul-write.ts";
import { foldJourney, type PersistedTurn, runPersistedTurn } from "./tier.ts";

const TIMEOUT = 60_000;

let soul: EvalSoul;

const answering = (text: string): EvalCase => ({
  id: "l3-answer",
  tier: "l3",
  agent: "support",
  context: {},
  input: [{ role: "user", content: textContent("When do you open?") }],
  expect: [],
  script: [{ kind: "text", text }],
});

const ROUTINE_TOOL_CONTRACT: ToolContractDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "ToolContract",
  metadata: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "eval-send",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
    publishedDigest: "a".repeat(64),
  },
  spec: {
    toolId: "eval.message.send",
    toolVersion: "1.0.0",
    action: "message.send",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    outputSchema: { type: "object" },
    riskClass: "medium",
    mutating: true,
    dataClasses: ["source-content"],
    allowedDestinations: ["eval"],
    idempotency: { strategy: "provider" },
    retry: { maxAttempts: 2, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: "eval-routine-provider" },
  },
} as ToolContractDefinition;

const ROUTINE_DEFINITION: routine.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "eval-send",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    owner: "agent:eval",
    start: "Send",
    states: [
      {
        type: "tool",
        name: "Send",
        toolRef: { name: "eval.message.send", version: "1.0.0" },
        action: "message.send",
        destination: "eval",
        input: { text: `${"${"} input.text }` },
        transition: "Capture",
      },
      {
        type: "compute",
        name: "Capture",
        input: { output: `${"${"} states.Send.output }` },
        end: true,
      },
    ],
  },
} as routine.RoutineDefinition;

const APPROVAL_GUARDRAIL: GuardrailDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Guardrail",
  metadata: {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "eval-approval",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    defaultDecision: "deny",
    rules: [
      {
        id: "allow-approved-send",
        type: "allow",
        actions: ["message.send"],
        dataClasses: ["source-content"],
        destinations: ["eval"],
      },
      {
        id: "approve-send",
        type: "approval",
        actions: ["message.send"],
        category: "highRiskAction",
        minimumApprovers: 1,
        separationOfDuties: true,
      },
    ],
  },
} as GuardrailDefinition;

const ALLOW_GUARDRAIL: GuardrailDefinition = {
  ...APPROVAL_GUARDRAIL,
  metadata: { ...APPROVAL_GUARDRAIL.metadata, slug: "eval-allow" },
  spec: {
    defaultDecision: "deny",
    rules: [
      {
        id: "allow-send",
        type: "allow",
        actions: ["message.send"],
        dataClasses: ["source-content"],
        destinations: ["eval"],
      },
    ],
  },
} as GuardrailDefinition;

function routineCase(
  id: string,
  overrides: Partial<NonNullable<EvalCase["routine"]>> = {}
): EvalCase {
  return {
    id,
    tier: "l3",
    agent: "support",
    context: {},
    input: [{ role: "user", content: textContent("Send the message.") }],
    expect: [],
    routine: {
      definition: ROUTINE_DEFINITION,
      toolContract: ROUTINE_TOOL_CONTRACT,
      guardrail: ALLOW_GUARDRAIL,
      inputs: { text: "hello" },
      providerSteps: [{ kind: "success", output: { receiptId: "receipt-1" } }],
      ...overrides,
    },
  };
}

describe("the L3 tier", () => {
  it(
    "runs one Turn through the real Chat executor and persists it",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: answering("We open at 9am."),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.runStatus).toBe("succeeded");
      expect(turn.turnStatus).toBe("succeeded");
      expect(turn.answer).toBe("We open at 9am.");
    },
    TIMEOUT
  );

  it(
    "records durable Run events in order",
    async () => {
      // The whole reason this tier exists: L2 stubs the event port, so it cannot notice the day
      // the executor stops writing a turn's events at all.
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: answering("We open at 9am."),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.events.length).toBeGreaterThan(0);
      expect(turn.events).toContain("turn.finished");
      expect(turn.participantText).toBe("We open at 9am.");
    },
    TIMEOUT
  );

  it(
    "leaves the invoke State terminal, not parked",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: answering("We open at 9am."),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.stateStatus).toBe("succeeded");
    },
    TIMEOUT
  );

  it(
    "isolates Trials, so one cannot observe what the last one wrote",
    async () => {
      soul ??= await loadEvalSoul();
      const first = await runPersistedTurn({
        evalCase: answering("first"),
        soul,
        binding: scriptedBinding(),
      });
      const second = await runPersistedTurn({
        evalCase: answering("second"),
        soul,
        binding: scriptedBinding(),
      });

      expect(first.answer).toBe("first");
      expect(second.answer).toBe("second");
    },
    TIMEOUT
  );
});

describe("the L3 Routine Tool-State tier", () => {
  it(
    "persists an Approval decision once and resumes the exact Tool occurrence",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: routineCase("l3-routine-approval", {
          guardrail: APPROVAL_GUARDRAIL,
          approval: "approved",
        }),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.runStatus).toBe("succeeded");
      expect(turn.stateStatus).toBe("succeeded");
      expect(turn.stateOutput).toEqual({ receiptId: "receipt-1" });
      expect(turn.toolCalls).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    "replays a large confirmed output after the State checkpoint without another provider call",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: routineCase("l3-routine-confirmed-replay", {
          crashAfter: "state_succeeded",
          providerSteps: [
            {
              kind: "success",
              output: { receiptId: "receipt-large" },
              paddingBytes: 129 * 1024,
            },
          ],
        }),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.runStatus).toBe("succeeded");
      expect(turn.stateOutput).toMatchObject({ receiptId: "receipt-large" });
      expect(turn.toolCalls).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    "recovers a confirmed effect after a crash before the Tool State checkpoint",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: routineCase("l3-routine-confirmed-before-state", {
          crashAfter: "effect_confirmed",
        }),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.runStatus).toBe("succeeded");
      expect(turn.stateStatus).toBe("succeeded");
      expect(turn.stateOutput).toEqual({ receiptId: "receipt-1" });
      expect(turn.toolCalls).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    "persists a provider retry wait and resumes the same Tool occurrence",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: routineCase("l3-routine-retry", {
          providerSteps: [
            { kind: "retry", retryAfterMs: 1_000, code: "rate_limited" },
            { kind: "success", output: { receiptId: "receipt-after-retry" } },
          ],
        }),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.runStatus).toBe("succeeded");
      expect(turn.stateOutput).toEqual({ receiptId: "receipt-after-retry" });
      expect(turn.toolCalls).toHaveLength(2);
    },
    TIMEOUT
  );
});

describe("participant-stream content filtering", () => {
  it(
    "fails the shipped Case with old publication ordering, then passes with the real guard",
    async () => {
      soul ??= await loadEvalSoul();
      const corpus = await loadCorpus(path.join(__dirname, "../../corpus", RED_TEAM_DIR), soul);
      const evalCase = corpus.cases.find(
        (c) => c.id === "l3-payment-receipt-never-streams-a-card-number"
      );
      if (evalCase === undefined) throw new Error("missing participant-stream regression Case");
      const score = (turn: PersistedTurn) =>
        scoreCase(evalCase.expect, {
          systemPrompt: turn.systemPrompt,
          toolCalls: turn.toolCalls,
          output: turn.answer === null ? undefined : { kind: "text", text: turn.answer },
          status: turn.runStatus,
          guardrails: turn.guardrails,
          persisted: turn,
        });
      const oldPublication = vi
        .spyOn(TurnGuardrails.prototype, "guardModel")
        .mockImplementation((model) => model);
      try {
        const leaked = await runPersistedTurn({ evalCase, soul, binding: scriptedBinding() });
        expect(leaked.participantText).toContain("4111 1111 1111 1111");
        // Once unsafe prose was published, durable history must preserve it. The output guard's
        // replacement cannot rewrite what the participant already saw.
        expect(leaked.answer).toContain("4111 1111 1111 1111");
        expect(
          score(leaked)
            .filter((e) => !e.passed)
            .map((e) => e.expectation.kind)
        ).toEqual(["run_event_text_omits", "output_omits"]);
      } finally {
        oldPublication.mockRestore();
      }

      const guarded = await runPersistedTurn({ evalCase, soul, binding: scriptedBinding() });
      expect(guarded.toolCalls.map((call) => call.name)).toEqual(["payment_record"]);
      expect(guarded.participantText).not.toContain("4111 1111 1111 1111");
      expect(score(guarded).filter((e) => !e.passed)).toEqual([]);
    },
    TIMEOUT
  );
});

const writing = (content: string): EvalCase => ({
  id: "l3-soul-write",
  tier: "l3",
  agent: "support",
  context: {},
  input: [{ role: "user", content: textContent("Add an agent called billing.") }],
  tools: [
    {
      name: SOUL_WRITE_TOOL,
      description: "Write a Soul artifact.",
      inputSchema: { type: "object" },
    },
  ],
  expect: [],
  script: [
    {
      kind: "tool_calls",
      calls: [
        {
          callId: "c1",
          name: SOUL_WRITE_TOOL,
          arguments: { kind: "Agent", slug: "billing", content },
        },
      ],
    },
    { kind: "text", text: "Added the billing agent." },
  ],
});

describe("a Turn that changes configuration", () => {
  it(
    "lands a real commit in the Eval Soul's git repository",
    async () => {
      soul ??= await loadEvalSoul();
      const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: soul.path }).toString();

      const turn = await runPersistedTurn({
        evalCase: writing(
          "---\ndescription: Handles invoices.\ndomain: support\n---\n\nYou answer billing questions."
        ),
        soul,
        binding: scriptedBinding(),
      });

      // HEAD is back at `before` by now — the Trial resets it. What proves the commit was real
      // rather than merely recorded is that git still resolves its object.
      const sha = turn.soulCommits[0]?.sha ?? "";
      const type = execFileSync("git", ["cat-file", "-t", sha], { cwd: soul.path }).toString();

      expect(turn.soulCommits.length).toBe(1);
      expect(turn.soulCommits[0]?.paths).toEqual(["agents/billing/AGENT.md"]);
      expect(type.trim()).toBe("commit");
      expect(sha).not.toBe(before.trim());
    },
    TIMEOUT
  );

  it(
    "reports the writer's refusal as a Tool denial rather than a tier failure",
    async () => {
      // The writer rejecting a write is product behaviour a Case may assert on. If the tier threw
      // instead, the Case would error and the refusal would be indistinguishable from a vendor
      // fault — the one confound this framework exists to remove.
      soul ??= await loadEvalSoul();
      const invalid = writing("body");
      const turn = await runPersistedTurn({
        evalCase: {
          ...invalid,
          script: [
            {
              kind: "tool_calls",
              calls: [
                {
                  callId: "c1",
                  name: SOUL_WRITE_TOOL,
                  arguments: { kind: "NotAKind", slug: "billing", content: "body" },
                },
              ],
            },
            { kind: "text", text: "I could not do that." },
          ],
        },
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.soulCommits).toEqual([]);
      expect(turn.runStatus).toBe("succeeded");
    },
    TIMEOUT
  );

  it(
    "returns the fixture to its base commit, so the next Trial starts clean",
    async () => {
      soul ??= await loadEvalSoul();
      const content =
        "---\ndescription: Handles invoices.\ndomain: support\n---\n\nYou answer billing questions.";
      const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: soul.path }).toString();

      await runPersistedTurn({ evalCase: writing(content), soul, binding: scriptedBinding() });
      await runPersistedTurn({ evalCase: writing(content), soul, binding: scriptedBinding() });

      const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: soul.path }).toString();
      expect(after).toBe(before);
    },
    TIMEOUT
  );

  it(
    "reports the Soul write as a Tool call, so an Expectation can forbid it",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: writing(
          "---\ndescription: Handles invoices.\ndomain: support\n---\n\nYou answer billing questions."
        ),
        soul,
        binding: scriptedBinding(),
      });

      // Routed away from the scripted dispatcher, this call was once invisible to the scorer, and
      // `tool_not_called soul_write` passed while the commit landed.
      expect(turn.toolCalls.map((call) => call.name)).toEqual([SOUL_WRITE_TOOL]);
      expect(turn.toolCalls[0]?.arguments).toMatchObject({ kind: "Agent", slug: "billing" });
    },
    TIMEOUT
  );
});

describe("a journey", () => {
  it(
    "shows a later Turn the artifact an earlier Turn committed",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: {
          ...writing(
            "---\ndescription: Handles invoices.\ndomain: support\n---\n\nYou answer billing questions."
          ),
          journey: [
            {
              input: [{ role: "user", content: textContent("Which agents exist now?") }],
              script: [{ kind: "text", text: "Support and billing." }],
            },
          ],
        },
        soul,
        binding: scriptedBinding(),
      });

      // No prompt block lists the Soul any more, so the second Turn cannot be asked to name the
      // new Agent. What it still proves is that the Soul reloaded between Turns and assembled a
      // prompt from it rather than serving a stale or empty one.
      expect(turn.systemPrompt).toContain("<agent-personality>");
      expect(turn.systemPrompt).toContain("Tulip Supply Co");
      expect(turn.answer).toBe("Support and billing.");
      expect(turn.soulCommits).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    "hands a later Turn the Conversation as it was actually persisted",
    async () => {
      soul ??= await loadEvalSoul();
      const seen: string[][] = [];
      const inner = scriptedBinding();
      const recording: ModelBinding = {
        id: "recording",
        create: (evalCase) => {
          const port = inner.create(evalCase);
          return {
            invoke: async (request) => {
              seen.push(request.messages.map((m) => `${m.role}:${contentText(m.content)}`));
              return port.invoke(request);
            },
          };
        },
      };

      const turn = await runPersistedTurn({
        evalCase: {
          ...answering("We open at 9am."),
          journey: [
            {
              input: [{ role: "user", content: textContent("And on Sundays?") }],
              script: [{ kind: "text", text: "Closed on Sundays." }],
            },
          ],
        },
        soul,
        binding: recording,
      });

      expect(turn.answer).toBe("Closed on Sundays.");
      // Both sides of the first exchange, read back out of the database, then the new question.
      expect(seen[1]?.slice(1)).toEqual([
        "user:When do you open?",
        "assistant:We open at 9am.",
        "user:And on Sundays?",
      ]);
    },
    TIMEOUT
  );

  it(
    "runs every Turn against the same Conversation",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: {
          ...answering("We open at 9am."),
          journey: [
            {
              input: [{ role: "user", content: textContent("And on Sundays?") }],
              script: [{ kind: "text", text: "Closed on Sundays." }],
            },
          ],
        },
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.runStatus).toBe("succeeded");
      expect(turn.events.filter((e) => e === "turn.finished")).toHaveLength(2);
    },
    TIMEOUT
  );

  it(
    "parks publication for approval before installing and reading it on the next Turn",
    async () => {
      soul ??= await loadEvalSoul();
      const corpus = await loadCorpus(path.join(__dirname, "../../corpus"), soul);
      const evalCase = corpus.cases.find(
        (candidate) => candidate.id === "l3-a-published-integration-is-visible-next-turn"
      );
      if (evalCase === undefined) throw new Error("Integration authoring journey Case is missing");
      const database = await openEvalDatabase();

      try {
        const turn = await runPersistedTurn({
          evalCase,
          soul,
          binding: scriptedBinding(),
          database,
        });
        const waits = await database.query(
          "SELECT kind, status FROM run_waits WHERE kind = 'approval'"
        );
        const operations = await database.query(
          "SELECT phase, package_snapshot FROM oim_release_install_operations"
        );

        expect(waits.rows).toEqual([{ kind: "approval", status: "satisfied" }]);
        expect(operations.rows).toHaveLength(1);
        expect(operations.rows[0]?.phase).toBe("completed");
        expect(operations.rows[0]?.package_snapshot).toBeDefined();
        expect(turn.soulCommits.flatMap((commit) => commit.paths)).toContain(
          "integrations/journey-acme/oim.yml"
        );
        expect(turn.publishedArtifacts).toContain("Integration:journey-acme");
        expect(
          turn.toolResults.find(
            (result) =>
              result.name === "integration_get" &&
              result.turnIndex === 2 &&
              result.status === "succeeded" &&
              (result.arguments as { slug?: unknown }).slug === "journey-acme"
          )?.output
        ).toMatchObject({
          oimManifest: { metadata: { name: "Journey Acme" } },
        });
        expect(turn.toolCalls.map((call) => call.name)).toEqual([
          "integration_draft_review",
          "integration_draft_create",
          "integration_draft_create",
          "integration_get",
        ]);
      } finally {
        await database.close();
      }
    },
    TIMEOUT
  );
});

describe("folding a journey into one result", () => {
  const turn = (over: Partial<PersistedTurn>): PersistedTurn => ({
    runStatus: "succeeded",
    stateStatus: "succeeded",
    turnStatus: "succeeded",
    answer: null,
    spend: NO_SPEND,
    events: [],
    participantText: "",
    assistantMessages: [],
    guardrails: [],
    toolCalls: [],
    toolResults: [],
    soulCommits: [],
    publishedArtifacts: [],
    generatedFiles: [],
    toolDenials: [],
    systemPrompt: "",
    ...over,
  });

  it("reports an early Turn's failure rather than the last one's success", () => {
    const folded = foldJourney([turn({ runStatus: "failed" }), turn({ answer: "fine" })]);
    expect(folded.runStatus).toBe("failed");
    expect(folded.answer).toBe("fine");
  });

  it("folds each status independently, so a parked State is not hidden by a succeeded Run", () => {
    // Reachable: the executor returns "succeeded" without touching the State when the Turn is a
    // stale attempt. Folding every status off the first *Run* failure would miss it entirely.
    const folded = foldJourney([turn({ stateStatus: "pending" }), turn({})]);
    expect(folded.runStatus).toBe("succeeded");
    expect(folded.stateStatus).toBe("pending");
  });

  it("reports an early Turn that was never completed", () => {
    const folded = foldJourney([turn({ turnStatus: null }), turn({})]);
    expect(folded.turnStatus).toBeNull();
  });

  it("accumulates what a Case asks about across the whole journey", () => {
    const folded = foldJourney([
      turn({
        events: ["turn.started"],
        toolCalls: [{ name: "a", arguments: {} }],
        toolResults: [{ name: "a", arguments: {}, turnIndex: 1, status: "succeeded" }],
      }),
      turn({
        events: ["turn.finished"],
        toolCalls: [{ name: "b", arguments: {} }],
        toolResults: [{ name: "b", arguments: {}, turnIndex: 2, status: "failed" }],
      }),
    ]);
    expect(folded.events).toEqual(["turn.started", "turn.finished"]);
    expect(folded.toolCalls.map((c) => c.name)).toEqual(["a", "b"]);
    expect(folded.toolResults.map((result) => result.turnIndex)).toEqual([1, 2]);
  });

  it("retains participant text from every Turn, including an earlier leak", () => {
    const folded = foldJourney([
      turn({ participantText: "4111 1111 " }),
      turn({ participantText: "1111 1111" }),
      turn({ participantText: "Safe final reply." }),
    ]);
    expect(folded.participantText).toBe("4111 1111 1111 1111Safe final reply.");
  });

  it("retains earlier guard decisions when a later Turn has no refusal", () => {
    const refusal = { stage: "output", guard: "content_filter", reason: "card number" };
    const folded = foldJourney([turn({ guardrails: [refusal] }), turn({})]);
    expect(folded.guardrails).toEqual([refusal]);
  });
});

describe("what an L3 Turn costs", () => {
  it(
    "meters streamed completions once per call and preserves model fault injection",
    async () => {
      soul ??= await loadEvalSoul();
      const invoke = vi.fn(async (): Promise<ModelInvocationResult> => {
        throw new Error("streaming port must not fall back to invoke");
      });
      const result: ModelInvocationResult = {
        requestId: "stream-bill",
        output: { kind: "text", text: "done" },
        usage: { inputTokens: 1200, outputTokens: 34, costUsd: 0, costBasis: "priced" },
      };
      const stream = vi.fn(async function* (): AsyncIterable<ModelStreamChunk> {
        yield { kind: "text_delta", text: "do" };
        yield { kind: "text_delta", text: "ne" };
        yield { kind: "completed", result };
      });
      const binding: ModelBinding = {
        id: "stream-billing",
        create: () => ({ invoke, stream }),
      };
      const onUsage = vi.fn();
      const turn = await runPersistedTurn({
        evalCase: {
          ...answering("ignored"),
          journey: [{ input: [{ role: "user", content: textContent("again") }], script: [] }],
        },
        soul,
        binding,
        onUsage,
      });
      expect(turn.participantText).toBe("donedone");
      expect(turn.spend).toMatchObject({ inputTokens: 2400, outputTokens: 68, calls: 2 });
      expect(onUsage.mock.calls).toEqual([[result.usage], [result.usage]]);
      expect(stream).toHaveBeenCalledTimes(2);
      expect(invoke).not.toHaveBeenCalled();

      const fault = await runPersistedTurn({
        evalCase: { ...answering("ignored"), fault: "model" },
        soul,
        binding,
        onUsage,
      });
      expect(fault.runStatus).toBe("failed");
      expect(fault.participantText).toBe("");
      expect(fault.spend).toEqual(NO_SPEND);
      expect(stream).toHaveBeenCalledTimes(2);
      expect(invoke).not.toHaveBeenCalled();
      expect(onUsage).toHaveBeenCalledTimes(2);
    },
    TIMEOUT
  );

  /** A binding that answers once and reports a real bill, so spend can be observed. */
  const billing = (): ModelBinding => ({
    id: "billing",
    dated: true,
    create: () => ({
      invoke: async () => ({
        output: { kind: "text" as const, text: "done" },
        usage: { inputTokens: 1200, outputTokens: 34, costUsd: 0, costBasis: "priced" as const },
        requestId: "billing-1",
      }),
    }),
  });

  it(
    "reports the tokens the Turn actually spent, so a ceiling can bound it",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: answering("ignored"),
        soul,
        binding: billing(),
      });

      expect(turn.spend.inputTokens).toBe(1200);
      expect(turn.spend.outputTokens).toBe(34);
      expect(turn.spend.calls).toBe(1);
    },
    TIMEOUT
  );

  it(
    "adds up every Turn of a journey, not just the last",
    async () => {
      soul ??= await loadEvalSoul();
      const journey: EvalCase = {
        ...answering("ignored"),
        journey: [{ input: [{ role: "user", content: textContent("again") }], script: [] }],
      };
      const turn = await runPersistedTurn({ evalCase: journey, soul, binding: billing() });

      expect(turn.spend.inputTokens).toBe(2400);
      expect(turn.spend.calls).toBe(2);
    },
    TIMEOUT
  );
});

const generating = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "l3-file-create",
  tier: "l3",
  agent: "support",
  context: {},
  input: [{ role: "user", content: textContent("Write the delays up as a PDF.") }],
  platformTools: [FILE_CREATE_TOOL],
  expect: [],
  script: [
    {
      kind: "tool_calls",
      calls: [
        {
          callId: "c1",
          name: FILE_CREATE_TOOL,
          arguments: {
            filename: "delays",
            format: "pdf",
            title: "Delays",
            content: "# Delays\n\nTwo hundred and forty orders were late.",
          },
        },
      ],
    },
    { kind: "text", text: "Written up as delays.pdf." },
  ],
  ...over,
});

describe("a Turn that generates a File draft", () => {
  it(
    "runs the shipped Tool for real, so the audience is read rather than scripted",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: generating(),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.runStatus).toBe("succeeded");
      expect(turn.toolCalls.map((c) => c.name)).toContain(FILE_CREATE_TOOL);
      expect(turn.generatedFiles).toHaveLength(1);
      expect(turn.generatedFiles[0]?.filename).toBe("delays.pdf");
      expect(turn.generatedFiles[0]?.status).toBe("draft");
    },
    TIMEOUT
  );

  it(
    "keeps the draft outside the persistent File audience until the person saves it",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: generating({ agentRoles: ["hr-team", "ops-desk"] }),
        soul,
        binding: scriptedBinding(),
      });

      expect(turn.generatedFiles[0]?.readableBy).toEqual([]);
      expect(turn.generatedFiles[0]?.status).toBe("draft");
    },
    TIMEOUT
  );

  it(
    "attributes each Turn of a journey's File to the Turn that wrote it",
    async () => {
      soul ??= await loadEvalSoul();
      const turn = await runPersistedTurn({
        evalCase: generating({
          agentRoles: ["hr-team"],
          journey: [
            {
              input: [{ role: "user", content: textContent("Now one for March.") }],
              script: [
                {
                  kind: "tool_calls",
                  calls: [
                    {
                      callId: "c2",
                      name: FILE_CREATE_TOOL,
                      arguments: {
                        filename: "march",
                        format: "pdf",
                        title: "March",
                        content: "# March\n\nEighty orders were late.",
                      },
                    },
                  ],
                },
                { kind: "text", text: "Written up as march.pdf." },
              ],
            },
          ],
        }),
        soul,
        binding: scriptedBinding(),
      });

      // The store is shared across a journey, so a folded result must add up to both Turns rather
      // than report the first Turn's File twice.
      expect(turn.generatedFiles).toHaveLength(2);
      expect(new Set(turn.generatedFiles.map((f) => f.fileId)).size).toBe(2);
    },
    TIMEOUT
  );
});
