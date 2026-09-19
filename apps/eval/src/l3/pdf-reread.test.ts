import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../case.ts";
import { corpusHash, loadCorpus } from "../corpus.ts";
import { type EvalSoul, loadEvalSoul } from "../eval-soul.ts";
import { runSweep } from "../runner.ts";
import { scriptedBinding } from "../scripted.ts";
import * as attachmentFixtures from "./attachments.ts";
import { runPersistedTurn } from "./tier.ts";

let soul: EvalSoul;
let cases: EvalCase[];
beforeAll(async () => {
  soul = await loadEvalSoul();
  const corpus = await loadCorpus(path.join(__dirname, "../../corpus"), soul);
  cases = corpus.cases.filter((candidate) =>
    candidate.readable?.some((file) => file.pdf !== undefined)
  );
  expect(cases).toHaveLength(3);
}, 60_000);
afterAll(() => soul?.dispose());
afterEach(() => vi.restoreAllMocks());

function sweep(evalCase: EvalCase) {
  return runSweep({
    corpus: { cases: [evalCase], hash: corpusHash([evalCase], soul.hash), soul },
    model: scriptedBinding(),
  });
}

describe("real File Tool and live PDF rereads", () => {
  it("keeps a readable scan's original binary and page accounting after file_read", async () => {
    const evalCase = cases.find(
      (candidate) => candidate.readable?.[0]?.pdf?.replaceAfterRead === undefined
    );
    if (evalCase === undefined) throw new Error("Missing scanned PDF reread Case");
    expect((await sweep(evalCase)).passed).toBe(1);
    const turn = await runPersistedTurn({ evalCase, soul, binding: scriptedBinding() });
    expect(turn.modelCallCount).toBe(2);
  }, 60_000);

  it.each(["malformed", "encrypted"] as const)(
    "rejects the actual %s replacement, and fails the Case when inspection refusals are discarded",
    async (variant) => {
      const evalCase = cases.find(
        (candidate) => candidate.readable?.[0]?.pdf?.replaceAfterRead === variant
      );
      if (evalCase === undefined) throw new Error("Missing replacement Case");
      const makeAttachments = attachmentFixtures.evalAttachments;
      const regression = vi
        .spyOn(attachmentFixtures, "evalAttachments")
        .mockImplementation((input) => {
          const fixture = makeAttachments(input);
          const inspect = fixture.port.inspect;
          if (inspect === undefined) throw new Error("Missing inspection port");
          return {
            ...fixture,
            port: {
              ...fixture.port,
              inspect: async (...args) => {
                const inspected = await inspect(...args);
                return inspected.refusal === undefined ? inspected : {};
              },
            },
          };
        });
      const broken = await sweep(evalCase);
      expect(broken.trials[0]?.error).toBeUndefined();
      expect(
        broken.trials[0]?.expectations
          .filter((entry) => !entry.passed)
          .map((entry) => entry.expectation.kind)
      ).toEqual(["provider_prompt_omits_file"]);
      regression.mockRestore();
      expect((await sweep(evalCase)).passed).toBe(1);
      const turn = await runPersistedTurn({ evalCase, soul, binding: scriptedBinding() });
      expect(turn.modelCallCount).toBe(1);
      expect(turn.providerPromptFiles).toEqual([]);
      expect(turn.answer).toContain(
        variant === "encrypted" ? "Upload an unlocked copy" : "Upload a readable copy"
      );
    },
    60_000
  );
});
