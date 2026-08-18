import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "../case.ts";
import { type EvalSoul, loadEvalSoul } from "../eval-soul.ts";
import type { ModelBinding } from "../runner.ts";
import { scriptedBinding } from "../scripted.ts";
import { NO_SPEND } from "../spend.ts";
import { SOUL_WRITE_TOOL } from "./soul-write.ts";
import { foldJourney, type PersistedTurn, runPersistedTurn } from "./tier.ts";

const TIMEOUT = 60_000;

let soul: EvalSoul;

const answering = (text: string): EvalCase => ({
  id: "l3-answer",
  tier: "l3",
  agent: "support",
  context: { governancePages: [] },
  input: [{ role: "user", content: "When do you open?" }],
  expect: [],
  script: [{ kind: "text", text }],
});

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

const writing = (content: string): EvalCase => ({
  id: "l3-soul-write",
  tier: "l3",
  agent: "support",
  context: { governancePages: [] },
  input: [{ role: "user", content: "Add an agent called billing." }],
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
              input: [{ role: "user", content: "Which agents exist now?" }],
              script: [{ kind: "text", text: "Support and billing." }],
            },
          ],
        },
        soul,
        binding: scriptedBinding(),
      });

      // The prompt is the *second* Turn's, assembled from a Soul reloaded after the first Turn
      // committed. If the writer commits a path the loader cannot read, this is what notices.
      expect(turn.systemPrompt).toContain("billing");
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
              seen.push(request.messages.map((m) => `${m.role}:${String(m.content)}`));
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
              input: [{ role: "user", content: "And on Sundays?" }],
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
              input: [{ role: "user", content: "And on Sundays?" }],
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
});

describe("folding a journey into one result", () => {
  const turn = (over: Partial<PersistedTurn>): PersistedTurn => ({
    runStatus: "succeeded",
    stateStatus: "succeeded",
    turnStatus: "succeeded",
    answer: null,
    spend: NO_SPEND,
    events: [],
    toolCalls: [],
    soulCommits: [],
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
      turn({ events: ["turn.started"], toolCalls: [{ name: "a", arguments: {} }] }),
      turn({ events: ["turn.finished"], toolCalls: [{ name: "b", arguments: {} }] }),
    ]);
    expect(folded.events).toEqual(["turn.started", "turn.finished"]);
    expect(folded.toolCalls.map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("what an L3 Turn costs", () => {
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
        journey: [{ input: [{ role: "user", content: "again" }], script: [] }],
      };
      const turn = await runPersistedTurn({ evalCase: journey, soul, binding: billing() });

      expect(turn.spend.inputTokens).toBe(2400);
      expect(turn.spend.calls).toBe(2);
    },
    TIMEOUT
  );
});
