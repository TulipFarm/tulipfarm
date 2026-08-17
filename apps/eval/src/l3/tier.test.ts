import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "../case.ts";
import { type EvalSoul, loadEvalSoul } from "../eval-soul.ts";
import { scriptedBinding } from "../scripted.ts";
import { SOUL_WRITE_TOOL } from "./soul-write.ts";
import { runPersistedTurn } from "./tier.ts";

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
});
