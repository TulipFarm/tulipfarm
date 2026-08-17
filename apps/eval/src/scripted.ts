import type { ModelPort } from "@tulipfarm/agent-runtime";
import type { EvalCase } from "./case.ts";
import type { ModelBinding } from "./runner.ts";

export class ScriptExhaustedError extends Error {
  constructor(caseId: string, call: number) {
    super(
      `Case "${caseId}" called the model ${call} time(s) but its script has fewer entries. ` +
        `Lengthen "script" or tighten the Case so the loop terminates.`
    );
    this.name = "ScriptExhaustedError";
  }
}

/**
 * A model binding that replays each Case's `script`.
 *
 * Free, deterministic and credential-free, so the whole Corpus runs in ordinary CI and a
 * contributor without vendor keys can still develop the framework. A real binding ignores
 * `script` entirely.
 */
export function scriptedBinding(): ModelBinding {
  return {
    id: "scripted",
    create(evalCase: EvalCase): ModelPort {
      const script = [...(evalCase.script ?? [])];
      let call = 0;
      return {
        invoke: async (request) => {
          call += 1;
          const output = script.shift();
          if (output === undefined) throw new ScriptExhaustedError(evalCase.id, call);
          return {
            requestId: request.requestId,
            output,
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costBasis: "priced" },
          };
        },
      };
    },
  };
}
